// e2e/assert_e2e_ran.mjs — the fail-on-empty guard (#198).
//
// Playwright has no built-in "fail if zero tests ran", so a suite that silently
// skips 100% of its tests (the #198 false-green: every spec gated behind an env
// flag CI never set) still reports the run as green. This guard parses the JSON
// report and FAILS the build unless real tests actually executed — so the
// "Playwright E2E" check can never again be green on a guarantee it didn't make.
//
// Honest, explicit skips are still allowed (e.g. a not-yet-built feature); this
// only fails when NOTHING ran.
import { readFileSync } from "node:fs";

const REPORT = process.argv[2] ?? "playwright-report/results.json";

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch (err) {
  console.error(`[assert_e2e_ran] could not read ${REPORT}: ${err.message}`);
  console.error("[assert_e2e_ran] the Playwright JSON report is missing — did the run produce one?");
  process.exit(1);
}

let executed = 0;
let skipped = 0;

// Walk the suite tree. A `test` (one spec × one project) has a top-level status of
// "expected" | "unexpected" | "flaky" | "skipped"; anything that is not "skipped"
// actually executed.
function walk(suite) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "skipped") skipped += 1;
      else executed += 1;
    }
  }
  for (const child of suite.suites ?? []) walk(child);
}
for (const suite of report.suites ?? []) walk(suite);

console.log(`[assert_e2e_ran] executed=${executed} skipped=${skipped}`);

if (executed === 0) {
  console.error(
    "[assert_e2e_ran] FAIL: zero E2E tests executed — the suite is false-green. " +
      "Every test was skipped or none were collected. Refusing to report a hollow gate.",
  );
  process.exit(1);
}

console.log("[assert_e2e_ran] OK: the E2E gate ran real tests.");

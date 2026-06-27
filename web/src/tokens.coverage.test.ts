import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// CSS-coverage gate (product-team P0 "this can never ship again").
//
// The deployed wizard rendered as raw browser-default inputs because every
// className it used (wizard__field/form/lede + decision-banner__metrics/metric…)
// had ZERO matching rule in tokens.css. This test fails when a static className
// in the app has no rule in tokens.css, so an orphaned class can never silently
// ship as an unstyled element again.
//
// KNOWN_ORPHANS is the documented backlog of screens still awaiting their styles
// (detail / role / modals — P1/P2 in the review plan). The list may only SHRINK:
// a new orphan fails the gate, and styling a listed screen without removing it
// here also fails (keeps the backlog honest). Drive it to [] as parity lands.

const srcDir = dirname(fileURLToPath(import.meta.url));

const KNOWN_ORPHANS = new Set<string>([
  // feedback-modal__* and conflict-modal__* are now styled in tokens.css
  // (issue #144) — removed from the backlog so the gate stays honest.
  "narrative-canvas__field",
  "narrative-canvas__status",
  "role-view",
  "role-view--loading",
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

// Static className string literals only: className="a b" and className={"a b"}.
// Dynamic/templated classNames (className={`x ${y}`}) can't be statically checked.
function usedClasses(src: string): string[] {
  const out: string[] = [];
  const re = /className=(?:"([^"]*)"|\{\s*"([^"]*)"\s*\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const c of (m[1] ?? m[2] ?? "").split(/\s+/)) if (c) out.push(c);
  }
  return out;
}

describe("tokens.css covers every static className the app renders", () => {
  const css = readFileSync(join(srcDir, "tokens.css"), "utf8");
  const defined = new Set(
    [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
  );

  const orphans = new Map<string, string[]>();
  for (const file of tsxFiles(srcDir)) {
    const src = readFileSync(file, "utf8");
    for (const c of usedClasses(src)) {
      if (!defined.has(c)) {
        const rel = relative(srcDir, file);
        const list = orphans.get(c) ?? [];
        if (!list.includes(rel)) list.push(rel);
        orphans.set(c, list);
      }
    }
  }

  it("has no NEW orphaned classNames beyond the documented backlog", () => {
    const fresh = [...orphans.entries()].filter(([c]) => !KNOWN_ORPHANS.has(c));
    const report = fresh
      .map(([c, files]) => `  .${c} — used in ${files.join(", ")}, no rule in tokens.css`)
      .join("\n");
    expect(
      fresh.length,
      `Orphaned classNames render as unstyled browser defaults — add rules to tokens.css:\n${report}`,
    ).toBe(0);
  });

  it("the backlog allowlist only shrinks (remove a class once it is styled)", () => {
    const stale = [...KNOWN_ORPHANS].filter((c) => !orphans.has(c));
    expect(
      stale.length,
      `These are now styled — delete them from KNOWN_ORPHANS:\n  ${stale.join(", ")}`,
    ).toBe(0);
  });
});

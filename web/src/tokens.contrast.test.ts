import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Design-audit P1 (Task 3.4): --error text measured 3.56-4.49:1 on the four
// cell-state band backgrounds (+ 4.45:1 on --surface-alt) and --placeholder
// measured 2.59:1 on white — all FAIL the WCAG-AA 4.5:1 floor for normal text.
// This file locks the fix with a small WCAG relative-luminance/contrast helper.
//
// NOTE ON "NO-CLIENT-MATH" (CLAUDE.md / PRD §13): that rule governs the app's
// PROJECTION math (dollars/percents the server computes and the client must
// render verbatim, never recompute). This is test-side design-system tooling —
// a contrast checker over tokens.css, the same category as typeScale.test.ts —
// and never ships in the app bundle. It has no bearing on NO-CLIENT-MATH.
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colors (order-independent). */
function contrast(hexA: string, hexB: string): number {
  const [l1, l2] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const srcDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(srcDir, "tokens.css"), "utf8");

// Parse every custom property declared in :root into a raw-value map, then
// resolve var(--name[, fallback]) chains down to a literal hex — so an ALIAS
// token like `--warn-text: var(--warning);` still resolves to a real color
// instead of silently falling back to an undefined-var placeholder.
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
if (!rootBlock) throw new Error("tokens.contrast.test.ts: could not find a :root block in tokens.css");

const rawVars = new Map<string, string>();
for (const m of rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
  rawVars.set(m[1], m[2].trim());
}

function resolve(name: string, seen: Set<string> = new Set()): string {
  if (seen.has(name)) throw new Error(`tokens.css: circular var() reference resolving --${name}`);
  seen.add(name);
  const raw = rawVars.get(name);
  if (raw === undefined) throw new Error(`tokens.css does not define --${name} in :root`);
  const varMatch = /^var\(--([\w-]+)(?:\s*,.+)?\)$/.exec(raw);
  return varMatch ? resolve(varMatch[1], seen) : raw;
}

describe("tokens.css: --band-input/--band-overridden/--band-estimated/--warn-text are real tokens", () => {
  it("defines each in :root (not just referenced as an undefined var() fallback)", () => {
    for (const name of ["band-input", "band-overridden", "band-estimated", "warn-text"]) {
      expect(rawVars.has(name), `tokens.css must define --${name} in :root`).toBe(true);
    }
  });
});

interface Pair {
  /** Custom-property name (no leading --) used as the TEXT color. */
  fg: string;
  /** Custom-property name (no leading --) used as the BACKGROUND color. */
  bg: string;
  /** Where this pair renders in the app — kept in the failure message. */
  where: string;
}

// The explicit, declared list of (fg, bg) pairs this gate checks. Every pair is
// normal-weight/normal-size text (never large-text 18pt+), so the WCAG-AA floor
// is 4.5:1 for all of them (no 3:1 large-text exception applies anywhere here).
const PAIRS: Pair[] = [
  // The four cell-state band backgrounds the audit flagged (3.56-4.49:1, all FAIL
  // pre-fix) — negative (loss) figures via .cell[data-negative] in the 3-year
  // table (ProjectionTab.tsx / tokens.css .cell--input/.cell--overridden/.cell--estimated).
  { fg: "error", bg: "band-input", where: "negative $ in an INPUT-state cell (.cell--input[data-negative]), 3-year table" },
  { fg: "error", bg: "band-overridden", where: "negative $ in an OVERRIDDEN-state cell (.cell--overridden[data-negative]), 3-year table" },
  { fg: "error", bg: "band-estimated", where: "negative $ in an ESTIMATED-state cell (.cell--estimated[data-negative]), 3-year table" },
  // error-on-surface-alt (4.45:1, FAIL pre-fix) — the owner list's red
  // "capital required" column (.list__capital) sits directly on the page
  // background (body/.app { background: var(--surface-alt) }).
  { fg: "error", bg: "surface-alt", where: "capital-required red text in the owner list (.list__capital), page bg" },
  // Not audited as failing (COMPUTED-state cells/KPI strip/decision tiles render
  // on plain --surface white), but declared here as a regression lock since
  // .cell[data-negative] shares one rule across every cell state.
  { fg: "error", bg: "surface", where: "negative $ in a COMPUTED-state cell / KPI strip / decision tile, white bg" },
  // --placeholder (2.59:1 on white, FAIL pre-fix) — every wizard/NumberField
  // empty-input placeholder renders on the white input background.
  { fg: "placeholder", bg: "surface", where: "empty-input placeholder text (wizard fields, NumberField), white bg" },
  // --warn-text (design audit: previously an UNDEFINED var() fallback, #8a5a00,
  // never actually declared in :root) — OverrideAudit's stale-upstream /
  // needs-justification flags, both on white and on a surface-alt container.
  { fg: "warn-text", bg: "surface", where: "OverrideAudit stale-upstream / needs-justification text, white bg" },
  { fg: "warn-text", bg: "surface-alt", where: "OverrideAudit inside a surface-alt container (Settings/KPIs grid)" },
  // Cash-flow module redesign (2026-07-04): muted ink carries the axis titles,
  // axis tick labels, year labels and the group "Ending cash" summary — on white
  // and on the surface-alt group-header / row-highlight band. Locked to AA.
  { fg: "text-muted", bg: "surface", where: "cash-flow axis titles / tick labels, white bg" },
  { fg: "text-muted", bg: "surface-alt", where: "cash-flow group 'Ending cash' summary + active-row highlight band" },
];

describe("tokens.css: cell-state + placeholder + warn-text colors clear WCAG-AA 4.5:1", () => {
  it.each(PAIRS)("--$fg on --$bg ($where)", ({ fg, bg, where }) => {
    const fgHex = resolve(fg);
    const bgHex = resolve(bg);
    const ratio = contrast(fgHex, bgHex);
    expect(
      ratio,
      `--${fg} (${fgHex}) on --${bg} (${bgHex}) = ${ratio.toFixed(2)}:1, needs >=4.5:1 for normal text — renders as: ${where}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});

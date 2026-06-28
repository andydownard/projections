import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #22 — ≤3 font sizes. tokens.css must define exactly the three-step type scale
// (+ weight + placeholder tokens), and EVERY font-size declaration must resolve
// to one of the three scale tokens. The only allowed exceptions are SVG chart
// glyphs sized in px (they scale with the chart viewBox, not the document type
// scale). This gate keeps a fourth ad-hoc size from silently creeping back in.
const srcDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(srcDir, "tokens.css"), "utf8");

// font-size values that are intentionally NOT on the rem scale (chart internals).
const ALLOWED_NON_TOKEN = new Set(["11px"]);

describe("type scale (#22)", () => {
  it("defines the three scale tokens + weights + placeholder in :root", () => {
    for (const tokenName of [
      "--text-lg",
      "--text-base",
      "--text-sm",
      "--w-regular",
      "--w-semibold",
      "--w-bold",
      "--placeholder",
    ]) {
      expect(css, `tokens.css must define ${tokenName}`).toContain(`${tokenName}:`);
    }
  });

  it("uses ONLY the three scale tokens for font-size (chart px glyphs excepted)", () => {
    const decls = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length).toBeGreaterThan(0);

    const offenders = decls.filter((v) => {
      if (
        v === "var(--text-lg)" ||
        v === "var(--text-base)" ||
        v === "var(--text-sm)"
      ) {
        return false;
      }
      return !ALLOWED_NON_TOKEN.has(v);
    });

    expect(
      offenders.length,
      `Off-scale font-size values (migrate to var(--text-lg|base|sm)):\n  ${[...new Set(offenders)].join("\n  ")}`,
    ).toBe(0);
  });

  it("maps no more than three distinct rem sizes onto the scale", () => {
    // The scale tokens themselves are the only rem font-sizes; everything else
    // references them. Proven by the token definitions resolving to 3 values.
    const scale = ["--text-lg", "--text-base", "--text-sm"]
      .map((t) => new RegExp(`${t}:\\s*([0-9.]+rem)`).exec(css)?.[1])
      .filter(Boolean);
    expect(new Set(scale).size).toBe(3);
  });
});

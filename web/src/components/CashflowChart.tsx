// web/src/components/CashflowChart.tsx — the "Cash position and change by month" module (redesign, spec
// 2026-07-04). A hand-rolled SVG dual-axis chart (bar = monthly Net, line =
// Cumulative cash, on a SHARED pixel-exact $0 row) paired with a year-grouped,
// expand/collapse monthly table that is the chart's accessible text-alternative
// twin. No chart library; SVG x/y/points/d/width/height are LAYOUT GEOMETRY, not
// styling (the sanctioned exception). Every plotted point and every table cell
// renders the server's `{display}` string VERBATIM (PRD §13, NO-CLIENT-MATH); the
// ONLY client-formatted text is axis gridline tick labels, via the gated
// `formatAxisTick()` chrome helper (see format.ts doctrine).
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import { isNegative } from "./displayLabels";
import { formatAxisTick } from "../format";
import { cashflowCsvHref } from "../api/viewModel";
import type { ServerValue } from "../api/client";
import type { Milestone, Milestones, MonthlyPoint } from "../api/viewModel";

export interface CashflowChartProps {
  monthly: MonthlyPoint[];
  breakevenMonth: number | null;
  /** Server {raw,display} for Grand Opening / Break-even / Payback (issue #117). */
  milestones?: Milestones;
  /** The projection's view_slug — drives the CSV export link. Omit to hide it. */
  viewSlug?: string;
}

const ROWS: Array<{ label: string; pick: (m: MonthlyPoint) => ServerValue }> = [
  { label: "Revenue", pick: (m) => m.revenue },
  { label: "Expenses", pick: (m) => m.expenses },
  { label: "Net", pick: (m) => m.net },
  { label: "Cumulative cash", pick: (m) => m.cumulativeCash },
];

// ── nice-number tick algorithm (spec §3.3) ──────────────────────────────────
// The {1, 2, 2.5, 5, 10} step set (the 2.5 slot yields clean $25k/$250k ticks).
const NICE_STEPS = [1, 2, 2.5, 5, 10];

function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  const e = Math.floor(Math.log10(rawStep));
  const base = 10 ** e;
  const f = rawStep / base; // 1 <= f < 10
  for (const s of NICE_STEPS) if (f <= s) return s * base;
  return 10 * base;
}

interface AxisScale {
  ticks: number[];
  step: number;
  scale: number; // pixels per dollar (identical above & below zero → linear, $0 shared)
  top: number; // value at the plot's TOP edge (= a·step, ≥ 0)
  bottom: number; // value at the plot's BOTTOM edge (= −b·step, ≤ 0)
}
export interface DualAxis {
  zeroFrac: number; // BELOW-zero share of the plot (1 − f); zeroY = padT + (1−zeroFrac)·plotH
  net: AxisScale;
  cum: AxisScale;
  unified: boolean;
}

// The signed extent of a series ALWAYS straddles 0 (lo ≤ 0 ≤ hi) so $0 is a valid
// shared anchor and always a tick.
function signedExtent(values: number[]): { lo: number; hi: number } {
  return { lo: Math.min(0, ...values), hi: Math.max(0, ...values) };
}
// The natural ABOVE-zero share of a signed extent (1 = all-positive, 0 = all-negative,
// 0.5 for an all-zero series).
function aboveShare({ lo, hi }: { lo: number; hi: number }): number {
  const span = hi - lo;
  return span > 0 ? hi / span : 0.5;
}

// One axis's full-extent nice ladder, given a SHARED tick segmentation (a ticks
// above zero, b below). `a·step` covers the positive extent, `b·step` the
// negative, so the ladder runs EDGE TO EDGE of the plot and $0 is always a tick.
// The pixels-per-dollar scale is identical above and below zero, so the mapping
// is linear and $0 lands at fraction b/(a+b) — the SAME on every axis built with
// the same (a,b), which is what pins the shared-$0 pixel row (owner defect 1).
function axisLadder(ext: { lo: number; hi: number }, a: number, b: number, plotH: number): AxisScale {
  const need = Math.max(ext.hi > 0 ? ext.hi / a : 0, ext.lo < 0 ? -ext.lo / b : 0);
  const step = niceStep(need) || 1;
  const ticks: number[] = [];
  for (let k = a; k >= -b; k--) ticks.push(Math.round(k * step));
  return { ticks, step, scale: plotH / ((a + b) * step), top: a * step, bottom: -b * step };
}

// Balanced shared-zero dual axis (owner defect 1 — "each axis's ticks+gridlines
// must span the FULL vertical extent"). The old pass let whichever axis had the
// deeper below-zero fraction dictate the shared $0 pixel; the OTHER axis's whole
// ladder was then crammed into a sliver (on the owner's real 5-year projection
// the $1.5M…($500k) cumulative ticks all piled into the top quarter). The fix:
//  (a) the shared zero fraction is the AVERAGE of each axis's natural above-zero
//      share (clamped for sane headroom), so neither axis dictates it;
//  (b) a SINGLE integer segmentation (a ticks above zero, b below) is shared by
//      both axes — pinning the SAME zero fraction a/(a+b) on both ($0 pixel-shared
//      by construction) — while each axis picks its OWN nice step to cover its OWN
//      data, so BOTH ladders run the full plot height;
//  (c) if the two nice domains agree within one tick-step at both ends (the legacy
//      net≈cumulative-trough case, which otherwise reads as an error), UNIFY to a
//      single ladder rendered identically on both sides.
export function computeDualAxis(netVals: number[], cumVals: number[], plotH: number): DualAxis {
  const netExt = signedExtent(netVals);
  const cumExt = signedExtent(cumVals);
  const f = Math.min(0.92, Math.max(0.08, (aboveShare(netExt) + aboveShare(cumExt)) / 2));
  // Shared tick counts (a above, b below) approximating f with 5–8 total ticks;
  // a,b ≥ 1 guarantees a headroom band on each side (zero is never at a plot edge,
  // which is what re-triggered the review-C1 collapse). Tie-break to the DENSER
  // ladder so a balanced f≈0.5 yields the fuller 7-rung ±ladders the owner expects.
  let best = { a: 1, b: 1, err: Infinity, total: 0 };
  for (let total = 4; total <= 7; total++) {
    const a = Math.max(1, Math.min(total - 1, Math.round(f * total)));
    const err = Math.abs(a / total - f);
    if (err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && total > best.total)) {
      best = { a, b: total - a, err, total };
    }
  }
  const { a, b } = best;
  let net = axisLadder(netExt, a, b, plotH);
  let cum = axisLadder(cumExt, a, b, plotH);
  const commonStep = Math.max(net.step, cum.step);
  const unified =
    Math.abs(net.top - cum.top) <= commonStep && Math.abs(net.bottom - cum.bottom) <= commonStep;
  if (unified && net.step !== cum.step) {
    // Re-cut both axes on the coarser shared step so the two ladders are identical.
    const union = { lo: Math.min(net.bottom, cum.bottom), hi: Math.max(net.top, cum.top) };
    net = axisLadder(union, a, b, plotH);
    cum = net;
  }
  return { zeroFrac: b / (a + b), net, cum, unified };
}

// ── year grouping (spec §4.2 — pure integer month bucketing, NO client math) ──
interface Group {
  key: string;
  slug: string;
  label: string;
  months: MonthlyPoint[];
  endingCash: ServerValue;
}

function buildGroups(monthly: MonthlyPoint[], opening: number): Group[] {
  const groups: Group[] = [];
  const pre = monthly.filter((m) => m.month < opening);
  if (pre.length) {
    groups.push({
      key: "pre-opening",
      slug: "pre-opening",
      label: "Pre-opening",
      months: pre,
      endingCash: pre[pre.length - 1].cumulativeCash,
    });
  }
  const operating = monthly.filter((m) => m.month >= opening);
  const byYear = new Map<number, MonthlyPoint[]>();
  for (const m of operating) {
    const y = Math.floor((m.month - opening) / 12) + 1;
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(m);
  }
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const months = byYear.get(y)!;
    // A short trailing group is labeled honestly ("Year 5 · 11 mo"), never padded.
    const label = months.length < 12 ? `Year ${y} · ${months.length} mo` : `Year ${y}`;
    groups.push({
      key: `year-${y}`,
      slug: `year-${y}`,
      label,
      months,
      endingCash: months[months.length - 1].cumulativeCash,
    });
  }
  return groups;
}

// Distinct, non-color-only icon per milestone (shape carries meaning too). Owner
// defect 2: the flag / triangle / star glyphs render at ONE size everywhere
// (chip stack, plot markers, table slots) via the shared `cashflow-glyph` class.
const MILESTONE_META: Array<{ key: keyof Milestones; label: string; icon: string }> = [
  { key: "grandOpening", label: "Grand Opening", icon: "⚑" },
  { key: "breakEven", label: "Break-even", icon: "=" },
  { key: "payback", label: "Payback", icon: "★" },
];

export function CashflowChart({ monthly, breakevenMonth, milestones, viewSlug }: CashflowChartProps) {
  // Responsive geometry (spec §7): a NARROWER reference viewBox at ≤480px so the
  // tick text renders legibly (a geometry change, not a CSS shrink). Guarded so
  // jsdom (no matchMedia) and SSR default to the desktop reference.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 480px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  const opening = milestones?.grandOpening?.raw ?? 1;
  const beMonth = milestones?.breakEven?.raw ?? breakevenMonth ?? null;
  const groups = useMemo(() => buildGroups(monthly, opening), [monthly, opening]);

  // Default expanded: Pre-opening + Year 1, plus the group that CONTAINS break-even
  // (so both key milestones are visible without hunting — spec §4.4).
  const idBase = useId();
  const beGroupKey = beMonth != null
    ? groups.find((g) => g.months.some((m) => m.month === beMonth))?.key
    : undefined;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>(["pre-opening", "year-1"]);
    if (beGroupKey) init.add(beGroupKey);
    return init;
  });
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const openGroup = (key: string) =>
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  // ONE lifted hover/focus state, keyed by the server `month` field (spec §5).
  // `hovered` is the TRANSIENT pointer/keyboard position; `pinnedMonth` is the
  // STICKY tap/click pin (spec §5 touch row — the primary interaction at 375).
  // The rendered highlight is `activeMonth = hovered ?? pinnedMonth`, so a
  // transient hover temporarily overrides a pin and the display falls back to
  // the pin when the pointer leaves.
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinnedMonth, setPinnedMonth] = useState<number | null>(null);

  if (!monthly.length) {
    return (
      <section className="cashflow-module" data-testid="cashflow-module" aria-label="Cash position and change by month">
        <div className="cashflow-module__header">
          <h2 className="cashflow-module__title">Cash position and change by month</h2>
        </div>
        <figure className="cashflow-chart" data-testid="cashflow-chart">
          <figcaption className="cashflow-chart__caption">No monthly cash-flow data.</figcaption>
        </figure>
      </section>
    );
  }

  const n = monthly.length;

  const idxOfMonth = (month: number | null | undefined) =>
    month == null ? -1 : monthly.findIndex((m) => m.month === month);

  // Unified milestone callouts (owner defect 2). EVERY plotted marker is labeled:
  // Grand Opening, Break-even, Payback (only when it lands within the horizon).
  // Each has an on-plot marker (a light vertical line + a glyph) AND a row in
  // the left-aligned chip stack. `label` is the chip's display name.
  // (2026-07-04 owner feedback: the "Lowest cash" callout is removed — it always
  // lands the month before break-even, so it was a redundant, negatively-toned
  // restatement of break-even rather than new information.)
  interface Callout { key: string; icon: string; label: string; display: string; idx: number }
  const milestoneCallouts: Callout[] = [];
  const pushMs = (key: keyof Milestones, icon: string, label: string, ms: Milestone | undefined) => {
    const idx = idxOfMonth(ms?.raw);
    if (ms && ms.raw != null && idx >= 0) milestoneCallouts.push({ key, icon, label, display: ms.display, idx });
  };
  if (milestones) {
    for (const meta of MILESTONE_META) pushMs(meta.key, meta.icon, meta.label, milestones[meta.key]);
  } else if (beMonth != null && idxOfMonth(beMonth) >= 0) {
    milestoneCallouts.push({ key: "breakEven", icon: "=", label: "Break-even", display: `Month ${beMonth}`, idx: idxOfMonth(beMonth) });
  }

  // ── chart geometry (spec §7) ──────────────────────────────────────────────
  const W = narrow ? 380 : 660;
  // Reserved milestone-chip band (fix, 2026-07-04 third pass — see the render
  // below). Commit 47bda6f drew the chip stack on a translucent panel OVERLAID
  // INSIDE the plot's top-left corner; that is exactly what let it collide with
  // tick labels / gridlines / bars (design review: "Payback · Month 32" ran
  // through the "$100,000" tick; the panel hid the left "$0" label at other
  // shapes; at 375px it covered roughly a third of the plot). The structural
  // fix: reserve a BAND above the plot, sized to the ACTUAL chip count for this
  // projection (0–3: grand opening, break-even, payback-when-resolved), and
  // push the plot's top edge (padT) down by exactly that band
  // height. The SVG's total height grows by the same amount, so plotH below is
  // unaffected and the plot area never shrinks — every chip row then lives at a
  // y strictly LESS than the plot's top edge, and every gridline / tick label /
  // bar lives at a y >= the plot's top edge, so the two sets can never collide
  // regardless of viewport width or chip text length.
  const chipRowH = 13;
  const chipGap = 8; // split evenly above/below the stack inside its own band
  const chipCount = milestoneCallouts.length;
  const chipBandH = chipCount * chipRowH + chipGap;
  const baseH = 300;
  const H = baseH + chipBandH;
  // padL/padR widened from the spec's 60/64: §3.4 mandates FULL comma-form tick
  // labels ("($300,000)") — ~62px wide — so the narrower spec paddings (sized for
  // the abbreviated "$300k" labels in the spec's illustrative worked example)
  // clipped them at both edges. Verified un-clipped in the QA screenshot (§7 says
  // to confirm padding by screenshot, not formula). +16 on each side (owner
  // live-review, 2026-07-04 second pass) is the rotated axis title's own
  // "thickness" (a vertical title's footprint in the gutter is its font
  // line-height, ~12px, not its text length) — the minimum needed so the
  // rotated title clears the tick-label column; the plot keeps the rest.
  const padL = 90;
  const padR = 98;
  // Milestone chip stack LEFT EDGE (owner feedback, 2026-07-04 fourth pass):
  // align flush with the MODULE TITLE's left edge ("Cash position and change by
  // month"), not the plot's left edge (padL). The title <h2> and this <figure>/
  // <svg> are sibling children of the SAME `.cashflow-module` flex column, which
  // applies its 1.125rem horizontal padding once, at the section level
  // (tokens.css `.cashflow-module`); `.cashflow-chart` (the figure) and
  // `.cashflow-chart__svg` carry NO padding/margin of their own (tokens.css:
  // `.cashflow-chart { margin: 0; }`, `.cashflow-chart__svg { width: 100%; }`).
  // So the SVG's own x=0 lands on the exact same visual column as the title's
  // left text edge — not an approximation of it — and the chip stack anchors
  // there instead of at padL.
  const chipStackX = 0;
  // Fixed glyph column width + label gap so every chip row's glyph is
  // center-anchored on the SAME x regardless of that glyph's own natural
  // width, and every label starts flush at the SAME x regardless of its
  // glyph's width (see the chip <text> render below).
  const CHIP_GLYPH_COL_W = 14;
  const CHIP_LABEL_PAD = 6;
  // The axis titles no longer live in a top row (owner item, 2026-07-04 second
  // review — they rotate into the left/right gutters instead), so the BASE
  // headroom reverts to the pre-axis-title-chip constant: just enough room for
  // the on-chart milestone GLYPH row (the small icon atop each vertical line,
  // rendered at padT-3 below) before the plot starts. The chip stack's own band
  // (chipBandH above) stacks ON TOP of that, pushing padT down further still
  // (no narrow/wide split needed — that split existed only to stack the old
  // horizontal title chips).
  const basePadT = 44;
  const padT = basePadT + chipBandH;
  const padB = 28;
  const plotW = W - padL - padR;
  // plotH is INVARIANT under the chip band: H and padT both grow by chipBandH,
  // so H - padT - padB == baseH - basePadT - padB regardless of chip count —
  // this is what guarantees the reserved band never shrinks the plot.
  const plotH = H - padT - padB;
  // Rotated axis-title geometry: each title is one <g> rotated about a pivot
  // point (pivotX, plotCenterY) — see the render below for the rotation-math
  // doctrine (rotate(-90,·) on the left puts the FIRST local-x content, the
  // glyph, at the bottom, reading bottom-to-top; rotate(90,·) on the right
  // puts it at the top, reading top-to-bottom — the standard mirrored
  // twin-axis convention). Vertically centering both on the plot means both
  // pivots share the same Y, so the shared-$0 spirit extends to the titles
  // too. leftTitleX/rightTitleX sit just inside the SVG edge, outside the
  // tick-label column (padL/padR above already reserve the room).
  const plotCenterY = padT + plotH / 2;
  const leftTitleX = 10;
  const rightTitleX = W - 14;

  // Owner defect 3: inset the band layout from the plot edges so the FIRST/LAST
  // bars clear the frame (month 1 previously sat flush against the left edge and
  // read as clipped). One inset both sides, sized off the raw band so it stays
  // proportionate at 12- and 60-month horizons. The scrubber/hit-test still spans
  // the full plot, so pointer resolution is unaffected.
  const xInset = Math.min(14, Math.max(6, (plotW / n) * 0.6));
  const innerW = plotW - 2 * xInset;
  const bandW = innerW / n;
  const xCenter = (i: number) => padL + xInset + (i + 0.5) * bandW;
  const xLeftOf = (month: number) => padL + xInset + ((month - 1) / n) * innerW;

  // Balanced full-height dual axes (owner defect 1). Both $0 land on the SAME pixel
  // row by construction (a shared tick segmentation → shared zero fraction), and
  // each axis's ladder spans the FULL plot height. See computeDualAxis above.
  const dual = computeDualAxis(
    monthly.map((m) => m.net.raw),
    monthly.map((m) => m.cumulativeCash.raw),
    plotH,
  );
  const net = dual.net;
  const cum = dual.cum;
  const zeroY = padT + (1 - dual.zeroFrac) * plotH;
  const sNet = net.scale;
  const sCum = cum.scale;
  const yFor = (v: number, s: number) => (v >= 0 ? zeroY - v * s : zeroY + Math.abs(v) * s);

  // With the balanced shared segmentation (owner defect 1) both axes have the SAME
  // number of ticks at the SAME pixel rows — tick k of either axis lands at
  // `zeroY − k·plotH/(a+b)`, independent of that axis's step. So the horizontal
  // grid is ONE clean shared set of rows (net values labeled left, cumulative
  // right); no separate net-tinted gridline family and no moiré to collide-guard.
  const barW = Math.max(1, Math.min(24, bandW * 0.6));

  const linePts = monthly.map((m, i) => `${xCenter(i)},${yFor(m.cumulativeCash.raw, sCum)}`).join(" ");
  const areaPath =
    `M ${xCenter(0)},${zeroY} ` +
    monthly.map((m, i) => `L ${xCenter(i)},${yFor(m.cumulativeCash.raw, sCum)}`).join(" ") +
    ` L ${xCenter(n - 1)},${zeroY} Z`;

  // Year dividers + span labels (spec §3.6). A boundary sits at the LEFT edge of the
  // grand-opening month and every 12 months thereafter.
  const maxYear = Math.floor((monthly[n - 1].month - opening) / 12) + 1;
  const yearSpans = Array.from({ length: Math.max(1, maxYear) }, (_, k) => {
    const y = k + 1;
    const first = Math.max(opening + (y - 1) * 12, opening);
    const last = Math.min(opening + y * 12 - 1, monthly[n - 1].month);
    // Right edge of the span uses the SAME inset band mapping as xLeftOf (defect 3).
    const xRight = padL + xInset + (last / n) * innerW;
    return { y, first, last, xMid: (xLeftOf(first) + xRight) / 2 };
  }).filter((s) => s.last >= s.first);

  const milestoneDesc = milestoneCallouts.length
    ? ` Milestones: ${milestoneCallouts.map((c) => `${c.label} ${c.display}`).join("; ")}.`
    : "";
  const beLabel = beMonth != null ? `month ${beMonth}` : "not within the horizon";

  const activeMonth = hovered ?? pinnedMonth;
  const activeIdx = activeMonth != null ? idxOfMonth(activeMonth) : -1;
  const activePt = activeIdx >= 0 ? monthly[activeIdx] : null;

  // Deliberate navigation (keyboard land / tap) into a collapsed group
  // auto-expands it (spec §5); PASSIVE pointer hover never does.
  const revealGroupOf = (month: number) => {
    const g = groups.find((grp) => grp.months.some((m) => m.month === month));
    if (g) openGroup(g.key);
  };

  // Tap/click-to-pin (spec §5 touch, review I1): tap pins the month's readout;
  // tapping the same month again unpins; tapping another month moves the pin.
  const togglePin = (month: number) => {
    if (pinnedMonth === month) {
      setPinnedMonth(null);
      setHovered(null);
    } else {
      setPinnedMonth(month);
      setHovered(month);
      revealGroupOf(month);
    }
  };

  // Plot→row pointer resolution (review C2): the scrubber rect spans exactly the
  // plot, so the horizontal fraction across its SCREEN box maps 1:1 onto the n
  // equal month bands — pure hit-test geometry (no data math). The whole band
  // column is the hit target (≥24px logical, spec §5).
  const monthFromClientX = (el: Element, clientX: number): number | null => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return null; // jsdom / zero-layout guard
    const frac = (clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
    return monthly[idx].month;
  };

  // Keyboard scrubber (spec §6): one composite role="slider" tab stop. Absent an
  // active (hovered/pinned) month, the default readout position is the first
  // month of the horizon.
  const currentMonth = activeMonth ?? monthly[0].month;
  const moveTo = (month: number) => {
    const clamped = Math.max(monthly[0].month, Math.min(monthly[n - 1].month, month));
    setHovered(clamped);
    // Deliberate keyboard navigation into a collapsed group auto-expands it (§5).
    revealGroupOf(clamped);
  };
  const onScrubberKey = (e: KeyboardEvent<SVGRectElement>) => {
    const first = monthly[0].month;
    const last = monthly[n - 1].month;
    let handled = true;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        moveTo(currentMonth + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        moveTo(currentMonth - 1);
        break;
      case "Home":
        moveTo(first);
        break;
      case "End":
        moveTo(last);
        break;
      case "PageUp":
        moveTo(currentMonth + 12);
        break;
      case "PageDown":
        moveTo(currentMonth - 12);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
  const readout = (m: MonthlyPoint) =>
    `Month ${m.month}: Revenue ${m.revenue.display}, Expenses ${m.expenses.display}, ` +
    `Net ${m.net.display}, Cumulative cash ${m.cumulativeCash.display}`;

  return (
    <section className="cashflow-module" data-testid="cashflow-module" aria-label="Cash position and change by month">
      <div className="cashflow-module__header">
        <h2 className="cashflow-module__title">Cash position and change by month</h2>
        {viewSlug && (
          <a
            className="btn btn--download cashflow-module__export"
            data-testid="cashflow-export"
            href={cashflowCsvHref(viewSlug)}
            download
          >
            <span className="btn__icon" aria-hidden="true">⤓</span>
            CSV
          </a>
        )}
      </div>

      <figure className="cashflow-chart" data-testid="cashflow-chart">
        <svg
          className="cashflow-chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          preserveAspectRatio="xMidYMid meet"
          aria-label={`Monthly net (bars) and cumulative cash (line) over ${n} months. Break-even ${beLabel}.${milestoneDesc} Full figures in the table below.`}
        >
          {/* pre-opening background band */}
          {opening > 1 && (
            <g>
              <rect
                className="cashflow-chart__preopen-band"
                x={padL}
                y={padT}
                width={Math.max(0, xLeftOf(opening) - padL)}
                height={plotH}
              />
              <text className="cashflow-chart__preopen-label" x={padL + 4} y={padT + 12}>
                Pre-opening
              </text>
            </g>
          )}

          {/* axis titles (identity carried here, not a standalone legend) —
              owner item, 2026-07-04 second review: CONVENTIONAL rotated
              y-axis titles, one per gutter, vertically centered on the plot,
              instead of the horizontal top-row chips that read as sloppy /
              unlabeled. "($)" is dropped — the tick labels already carry "$".
              Each title is glyph-then-text in LOCAL (pre-rotation) reading
              order, rotated as ONE group so the glyph rides along with the
              text. rotate(-90, pivot) on the left sends the first
              (smallest-local-x) content — the glyph — to the BOTTOM of the
              rotated block, so the net title reads bottom-to-top;
              rotate(90, pivot) on the right sends it to the TOP, so the
              cumulative title reads top-to-bottom — the standard mirrored
              twin-axis convention. The swatch shapes stay aria-hidden; the
              text is the real, readable label. */}
          <g
            className="cashflow-chart__axis-label cashflow-chart__axis-label--net"
            transform={`rotate(-90 ${leftTitleX} ${plotCenterY})`}
          >
            <rect aria-hidden="true" className="cashflow-chart__axis-swatch--net-pos" x={leftTitleX - 34} y={plotCenterY - 4} width={5} height={8} />
            <rect aria-hidden="true" className="cashflow-chart__axis-swatch--net-neg" x={leftTitleX - 29} y={plotCenterY - 4} width={5} height={8} />
            <text
              data-testid="cashflow-axis-title-net"
              x={leftTitleX - 20}
              y={plotCenterY + 3}
              className="cashflow-chart__axis-label-text"
            >
              Monthly net
            </text>
          </g>
          <g
            className="cashflow-chart__axis-label cashflow-chart__axis-label--cum"
            transform={`rotate(90 ${rightTitleX} ${plotCenterY})`}
          >
            <line aria-hidden="true" className="cashflow-chart__axis-swatch--cum" x1={rightTitleX - 46} x2={rightTitleX - 32} y1={plotCenterY} y2={plotCenterY} />
            <circle aria-hidden="true" className="cashflow-chart__axis-swatch--cum-dot" cx={rightTitleX - 32} cy={plotCenterY} r={2} />
            <text
              data-testid="cashflow-axis-title-cum"
              x={rightTitleX - 28}
              y={plotCenterY + 3}
              className="cashflow-chart__axis-label-text"
            >
              Cumulative cash
            </text>
          </g>

          {/* full-width gridlines: HERO (cumulative) only, at its nice ticks */}
          {cum.ticks.map((t) => (
            <line
              key={`grid-${t}`}
              className="cashflow-chart__gridline"
              x1={padL}
              x2={padL + plotW}
              y1={yFor(t, sCum)}
              y2={yFor(t, sCum)}
            />
          ))}

          {/* right (cumulative) axis tick labels */}
          {cum.ticks.map((t) => (
            <text
              key={`ctick-${t}`}
              className="cashflow-chart__axis-tick cashflow-chart__axis-tick--right"
              x={padL + plotW + 6}
              y={yFor(t, sCum) + 3}
            >
              {formatAxisTick(t)}
            </text>
          ))}

          {/* left (net) axis: tick labels ONLY. The gridline ROWS are shared with
              the cumulative axis by construction (see the comment above), so the
              net axis reuses those same rows — labeling them on the left — rather
              than drawing a redundant second gridline family. */}
          {net.ticks.map((t) => (
            <text
              key={`ntick-${t}`}
              className="cashflow-chart__axis-tick cashflow-chart__axis-tick--left"
              x={padL - 6}
              y={yFor(t, sNet) + 3}
            >
              {formatAxisTick(t)}
            </text>
          ))}

          {/* underwater area wash under the cumulative line */}
          <path d={areaPath} className="cashflow-chart__area" />

          {/* net bars (sign-colored, grow from the shared zero row) */}
          {monthly.map((m, i) => {
            const yv = yFor(m.net.raw, sNet);
            const up = m.net.raw >= 0;
            const active = m.month === activeMonth;
            return (
              <rect
                key={`bar-${m.month}`}
                x={xCenter(i) - barW / 2}
                y={up ? yv : zeroY}
                width={barW}
                height={Math.max(0.5, Math.abs(yv - zeroY))}
                rx={2}
                className={
                  "cashflow-chart__bar" +
                  (up ? "" : " cashflow-chart__bar--neg") +
                  (active ? " cashflow-chart__bar--active" : "")
                }
              />
            );
          })}

          {/* shared zero row (heavier than gridlines — the one honest anchor) */}
          <line className="cashflow-chart__zero" x1={padL} x2={padL + plotW} y1={zeroY} y2={zeroY} />

          {/* cumulative line — white ring underlay then the brand stroke on top so
              the near-gray green stays legible where it crosses green net bars */}
          <polyline points={linePts} fill="none" className="cashflow-chart__line-ring" />
          <polyline points={linePts} fill="none" className="cashflow-chart__line" />

          {/* year dividers + span labels */}
          {yearSpans.map((s) =>
            s.y > 1 || opening > 1 ? (
              <line
                key={`yd-${s.y}`}
                className="cashflow-chart__year-divider"
                x1={xLeftOf(s.first)}
                x2={xLeftOf(s.first)}
                y1={padT}
                y2={padT + plotH}
              />
            ) : null,
          )}
          {yearSpans.map((s) => (
            <text key={`yl-${s.y}`} className="cashflow-chart__year-label" x={s.xMid} y={H - 8}>
              Year {s.y}
            </text>
          ))}

          {/* milestone markers (owner defect 2): a light CONSISTENT vertical line
              per plotted milestone, each capped with its glyph above the plot.
              All glyphs share `cashflow-glyph` → one size everywhere. */}
          {milestoneCallouts.map((c) => {
            const lx = xCenter(c.idx);
            return (
              <g
                key={c.key}
                data-testid={`${c.key.toLowerCase()}-marker`}
                className={`cashflow-chart__milestone cashflow-chart__milestone--${c.key}`}
              >
                <title>{`${c.label}: ${c.display}`}</title>
                <line className="cashflow-chart__milestone-line" x1={lx} x2={lx} y1={padT} y2={padT + plotH} />
                <text
                  className="cashflow-glyph cashflow-chart__milestone-glyph"
                  x={lx}
                  y={padT - 3}
                  textAnchor="middle"
                  aria-hidden="true"
                >
                  {c.icon}
                </text>
              </g>
            );
          })}

          {/* left-aligned milestone chip stack, in its OWN RESERVED BAND above
              the plot (fix, 2026-07-04 third pass) rather than overlaid inside
              it — the prior on-plot panel could still collide with tick labels
              / gridlines / bars at some shape × viewport combinations. Because
              the band's height (chipBandH above) is baked into padT itself,
              every row here sits strictly ABOVE the plot's top edge —
              collision-free BY CONSTRUCTION, not by visual tuning. The left
              edge (owner feedback, 2026-07-04 fourth pass) is flush with the
              MODULE TITLE's left edge (chipStackX = 0, see the geometry block
              above) rather than the plot's left edge (padL) — ONE flush-left
              text edge that lines up with "Cash position and change by month"
              above it, not indented past it. Each row: glyph + "Label · Month
              N" (amounts, if ever shown, are server display strings; "Month N"
              is a month index, chrome — never a re-derived figure). The glyph
              here matches the glyph atop that milestone's vertical line down
              in the plot (rendered above) — that shared glyph is the
              association; the chip text no longer sits at the line's x. */}
          {milestoneCallouts.length > 0 && (
            <g className="cashflow-chart__milestone-chips" data-testid="milestone-chips">
              {milestoneCallouts.map((c, i) => (
                <text
                  key={c.key}
                  data-testid={`milestone-chip-${c.key}`}
                  className={`cashflow-chart__milestone-chip cashflow-chart__milestone-chip--${c.key}`}
                  x={chipStackX}
                  y={chipGap / 2 + chipRowH * (i + 1)}
                >
                  {/* Fixed glyph column, center-anchored, so ⚑ / = / ★ (each a
                      different natural width) land on ONE shared center line
                      instead of drifting the label start by their own advance
                      width (the old `dx` offset made narrower glyphs like the
                      former ▲ sit closer to their label than wider ones). */}
                  <tspan
                    className="cashflow-glyph cashflow-chart__milestone-glyph"
                    x={chipStackX + CHIP_GLYPH_COL_W / 2}
                    textAnchor="middle"
                    aria-hidden="true"
                  >
                    {c.icon}
                  </tspan>
                  <tspan
                    className="cashflow-chart__milestone-chip-label"
                    x={chipStackX + CHIP_GLYPH_COL_W + CHIP_LABEL_PAD}
                    textAnchor="start"
                  >
                    {`${c.label} · ${c.display}`}
                  </tspan>
                </text>
              ))}
            </g>
          )}

          {/* hover/focus crosshair + active point */}
          {activePt && activeIdx >= 0 && (
            <g>
              <line
                className="cashflow-chart__crosshair"
                x1={xCenter(activeIdx)}
                x2={xCenter(activeIdx)}
                y1={padT}
                y2={padT + plotH}
              />
              <circle
                className="cashflow-chart__point"
                cx={xCenter(activeIdx)}
                cy={yFor(activePt.cumulativeCash.raw, sCum)}
                r={5}
              />
            </g>
          )}

          {/* tooltip (SVG geometry + textContent, never innerHTML) */}
          {activePt && activeIdx >= 0 && (
            <g
              className="cashflow-chart__tooltip"
              data-testid="cashflow-tooltip"
              transform={`translate(${Math.min(Math.max(xCenter(activeIdx) - 70, padL), padL + plotW - 140)}, ${padT + 4})`}
            >
              <rect className="cashflow-chart__tooltip-box" x={0} y={0} width={140} height={78} rx={4} />
              <text className="cashflow-chart__tooltip-title" x={8} y={15}>{`Month ${activePt.month}`}</text>
              {ROWS.map((r, ri) => (
                <text key={r.label} className="cashflow-chart__tooltip-row" x={8} y={30 + ri * 14}>
                  <tspan className="cashflow-chart__tooltip-value">{r.pick(activePt).display}</tspan>
                  {` ${r.label}`}
                </text>
              ))}
            </g>
          )}

          {/* keyboard + pointer scrubber — one composite role=slider tab stop
              (spec §6) AND the plot's single pointer surface (review C2/I1): the
              rect covers the whole plot, so each month's full band column is the
              hit target. mousemove = transient hover (passive — never expands a
              collapsed group); click/tap = pin (deliberate — auto-expands). */}
          <rect
            className="cashflow-chart__scrubber"
            data-testid="cashflow-scrubber"
            x={padL}
            y={padT}
            width={plotW}
            height={plotH}
            tabIndex={0}
            role="slider"
            aria-label="Cash position and change by month — use Left and Right arrow keys to move through months"
            aria-valuemin={monthly[0].month}
            aria-valuemax={monthly[n - 1].month}
            aria-valuenow={currentMonth}
            aria-valuetext={readout(monthly[idxOfMonth(currentMonth) >= 0 ? idxOfMonth(currentMonth) : 0])}
            onKeyDown={onScrubberKey}
            onBlur={() => setHovered(null)}
            onMouseMove={(e) => {
              if (pinnedMonth != null) return; // a pin holds until unpinned/moved
              const m = monthFromClientX(e.currentTarget, e.clientX);
              if (m != null) setHovered(m);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={(e) => {
              const m = monthFromClientX(e.currentTarget, e.clientX);
              if (m != null) togglePin(m);
            }}
          />
        </svg>
      </figure>

      {/* the grouped monthly table — the chart's full text-alternative twin */}
      <div className="cashflow-table__scroll">
        <table className="cashflow-table cashflow-table--by-month" data-testid="cashflow-table">
          <caption className="sr-only">
            {`Monthly cash-flow, months ${monthly[0].month} to ${monthly[n - 1].month}, grouped by year`}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="cashflow-table__label">Month</th>
              {ROWS.map((r) => (
                <th scope="col" key={r.label} className="num">{r.label}</th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => {
            const isOpen = expanded.has(g.key);
            const bodyId = `${idBase}-${g.slug}`;
            return (
              <tbody key={g.key} className="cashflow-table__group" id={bodyId} data-testid={`cashflow-group-${g.slug}`}>
                <tr className="cashflow-table__group-header">
                  {/* a plain <td> (not a <th>) so the disclosure header never reads
                      as a 6th column/row header — the <button> carries the semantics */}
                  <td className="cashflow-table__group-header-cell" colSpan={ROWS.length + 1}>
                    <button
                      type="button"
                      className="cashflow-table__group-toggle"
                      data-testid={`cashflow-group-toggle-${g.slug}`}
                      aria-expanded={isOpen}
                      aria-controls={bodyId}
                      onClick={() => toggle(g.key)}
                    >
                      <span className={"cashflow-table__chevron" + (isOpen ? " cashflow-table__chevron--open" : "")} aria-hidden="true">
                        ▸
                      </span>
                      <span className="cashflow-table__group-name">{g.label}</span>
                      <span className="cashflow-table__group-summary">
                        Ending cash {g.endingCash.display}
                      </span>
                    </button>
                  </td>
                </tr>
                {g.months.map((m) => {
                  const isOpening = m.month === opening && opening >= 1 && milestones != null;
                  const flags = MILESTONE_META.filter(
                    (meta) => milestones?.[meta.key]?.raw === m.month,
                  );
                  const active = m.month === activeMonth;
                  // No onFocus handler: data rows carry no focusable element, so
                  // a row focus event can never fire (review I2). Keyboard access
                  // to per-month data routes through the SINGLE slider scrubber
                  // (spec Part 6 — one tab stop, not 60), which drives the same
                  // row highlight. onClick = the spec §5 touch row's tap-to-pin
                  // parity on the table side (a redundant pointer affordance —
                  // never the only path to anything).
                  return (
                    <tr
                      key={m.month}
                      hidden={!isOpen}
                      data-testid={`cashflow-month-${m.month}`}
                      data-grand-opening={isOpening ? "true" : undefined}
                      className={active ? "cashflow-table__row--active" : undefined}
                      onMouseEnter={() => setHovered(m.month)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => togglePin(m.month)}
                    >
                      <th scope="row" className="cashflow-table__label">
                        {/* Owner item 3: a fixed-width leading slot for the
                            milestone icon, ALWAYS rendered (empty when the
                            month carries no flag) so "M1".."M60" all start at
                            the identical x — previously the icon was appended
                            AFTER the variable-width month number, so its
                            column position (and the month text's apparent
                            alignment) drifted row to row. */}
                        <span className="cashflow-table__milestone-slot">
                          {flags.map((meta) => (
                            <span key={meta.key} className={`cashflow-table__milestone cashflow-table__milestone--${meta.key}`}>
                              <span className="cashflow-glyph" aria-hidden="true">{meta.icon}</span>
                              <span className="sr-only">({meta.label})</span>
                            </span>
                          ))}
                        </span>
                        {`M${m.month}`}
                      </th>
                      {ROWS.map((r) => {
                        const cell = r.pick(m);
                        return (
                          <td key={r.label} className="num" data-negative={isNegative(cell) ? "true" : undefined}>
                            {cell.display}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>

      {/* keyboard/SR text alternative to the on-chart milestone labels */}
      {milestones && (
        <ul className="sr-only" data-testid="chart-milestones-sr">
          {MILESTONE_META.map((meta) => {
            const ms: Milestone = milestones[meta.key];
            const reached = ms.raw != null;
            const when = reached ? ms.display : (ms.reason ?? ms.display);
            return (
              <li key={meta.key}>
                {meta.label}: {when}
                {reached && ms.duration ? ` (${ms.duration})` : ""}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

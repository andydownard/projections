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

interface Domain {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

// The domain ALWAYS includes 0, and min/max are exact multiples of step, so 0 is
// guaranteed to be a returned tick (the shared anchor).
function niceDomain(values: number[], targetTicks: number): Domain {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const step = niceStep((hi - lo) / targetTicks) || 1;
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  // Degenerate guard (review C1): a ONE-SIGNED domain puts $0 at the domain edge.
  // The shared-zero pass then pins zeroY to a plot edge (zeroFrac 0 or 1), which
  // collapses the OTHER axis's scale to 0 whenever it has data on the starved
  // side — on the canonical 60%-labor default (payback N/A → cumulative max is
  // exactly 0) every net bar rendered at the 0.5px floor and all left-axis labels
  // stacked on one row. One nice-step of headroom past zero keeps every domain
  // strictly zero-spanning, so both scales stay finite and positive. When both
  // series genuinely span zero the domains are untouched and the shared-$0 pixel
  // row is unchanged (test-pinned).
  if (max === 0) max = step;
  if (min === 0) min = -step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { min, max, step, ticks };
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

// Distinct, non-color-only icon per milestone (shape carries meaning too).
const MILESTONE_META: Array<{ key: keyof Milestones; label: string; icon: string }> = [
  { key: "grandOpening", label: "Grand Opening", icon: "⚑" },
  { key: "breakEven", label: "Break-even", icon: "▲" },
  { key: "payback", label: "Payback", icon: "★" },
];
// Only Grand Opening + Break-even are labeled ON the plot (Payback would crowd the
// line; it is flagged on its table row + the sr-only summary instead).
const ON_CHART_KEYS: Array<keyof Milestones> = ["grandOpening", "breakEven"];

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

  // ── chart geometry (spec §7) ──────────────────────────────────────────────
  const W = narrow ? 380 : 660;
  const H = 300;
  // padL/padR widened from the spec's 60/64: §3.4 mandates FULL comma-form tick
  // labels ("($300,000)") — ~62px wide — so the narrower spec paddings (sized for
  // the abbreviated "$300k" labels in the spec's illustrative worked example)
  // clipped them at both edges. Verified un-clipped in the QA screenshot (§7 says
  // to confirm padding by screenshot, not formula).
  const padL = 74;
  const padR = 82;
  // Axis-title block + milestone-label row height depends on layout: at <=480px
  // the two axis titles STACK into two rows (spec §7 "axis-title pair may
  // stack") instead of sharing one row — owner-feedback fix (item 1): at the
  // wide layout's fixed right-anchor offset, the cumulative title's text
  // collided with the net title's text at ZERO gap on the narrower 380-unit
  // reference viewBox (confirmed in a real 375px browser render — the two read
  // as one run-together string, which is why the owner saw the axes as
  // unlabeled). Stacking needs more headroom before the milestone-label row,
  // which itself needs more headroom before the plot starts.
  const padT = narrow ? 58 : 44;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const tCum = narrow ? 3 : 5;
  const tNet = narrow ? 3 : 4;
  // Cumulative axis-title position: same row as net (right-anchored) at
  // wide/tablet; a second row, left-aligned under the net title, when narrow.
  const cumTitleY = narrow ? 20 : 6;
  const cumTitleTextY = narrow ? 27 : 13;
  const cumTitleX1 = narrow ? padL : W - padR - 130;
  const cumTitleX2 = narrow ? padL + 14 : W - padR - 116;
  const cumTitleTextX = narrow ? padL + 18 : W - padR - 112;
  // Milestone on-chart labels sit below the axis-title block; narrow needs the
  // extra row's worth of headroom the stacked titles now occupy.
  const milestoneBaseY = narrow ? 36 : 24;

  const n = monthly.length;
  const bandW = plotW / n;
  const xCenter = (i: number) => padL + (i + 0.5) * bandW;
  const xLeftOf = (month: number) => padL + ((month - 1) / n) * plotW;

  const net = niceDomain(monthly.map((m) => m.net.raw), tNet);
  const cum = niceDomain(monthly.map((m) => m.cumulativeCash.raw), tCum);

  // Shared-zero positioning pass: both $0 land on the SAME pixel row. `zeroFrac` is
  // the largest fraction of any axis' range that sits BELOW zero; the below-zero
  // band gets that share of the plot, so the axis with the deepest negative reaches
  // the bottom and $0 is one shared reference row for both series.
  const fracBelow = (d: Domain) => (d.max - d.min ? (0 - d.min) / (d.max - d.min) : 0);
  const zeroFrac = Math.max(fracBelow(net), fracBelow(cum));
  const zeroY = padT + (1 - zeroFrac) * plotH;
  const scaleOf = (d: Domain) =>
    Math.min(
      d.max > 0 ? (zeroY - padT) / d.max : Infinity,
      d.min < 0 ? (padT + plotH - zeroY) / Math.abs(d.min) : Infinity,
    );
  const sNet = scaleOf(net);
  const sCum = scaleOf(cum);
  const yFor = (v: number, s: number) =>
    !Number.isFinite(s) ? zeroY : v >= 0 ? zeroY - v * s : zeroY + Math.abs(v) * s;

  // Owner item 2: the net axis's tick lines now span the full plot width too
  // (previously a 4px left-edge stub only). Collision rule — if a net gridline
  // lands within 1 viewBox unit of a cumulative (hero) gridline, draw ONLY the
  // cumulative one (no moiré doubles). $0 is always exactly coincident by
  // construction (yFor(0,*) === zeroY for both axes), so this rule also
  // naturally absorbs the shared-zero row: the heavier `.cashflow-chart__zero`
  // line (drawn later, on top) stays the single emphasized zero anchor.
  const cumGridYs = cum.ticks.map((t) => yFor(t, sCum));
  const netGridVisible = (y: number) => !cumGridYs.some((cy) => Math.abs(cy - y) < 1);

  const barW = Math.max(1, Math.min(24, bandW * 0.6));

  const linePts = monthly.map((m, i) => `${xCenter(i)},${yFor(m.cumulativeCash.raw, sCum)}`).join(" ");
  const areaPath =
    `M ${xCenter(0)},${zeroY} ` +
    monthly.map((m, i) => `L ${xCenter(i)},${yFor(m.cumulativeCash.raw, sCum)}`).join(" ") +
    ` L ${xCenter(n - 1)},${zeroY} Z`;

  // Cash trough = capital required (= the most-negative cumulative). Server display.
  let troughIdx = 0;
  for (let i = 1; i < n; i++) {
    if (monthly[i].cumulativeCash.raw < monthly[troughIdx].cumulativeCash.raw) troughIdx = i;
  }
  const trough = monthly[troughIdx];

  const idxOfMonth = (month: number | null | undefined) =>
    month == null ? -1 : monthly.findIndex((m) => m.month === month);

  // On-chart markers (Grand Opening + Break-even), staggered onto two rows.
  const markers = milestones
    ? MILESTONE_META.filter((meta) => ON_CHART_KEYS.includes(meta.key))
        .map((meta) => ({ ...meta, ms: milestones[meta.key], idx: idxOfMonth(milestones[meta.key].raw) }))
        .filter((mk) => mk.idx >= 0)
    : beMonth != null && idxOfMonth(beMonth) >= 0
      ? [{ key: "breakEven" as const, label: "Break-even", icon: "▲",
          ms: { raw: beMonth, display: `Month ${beMonth}` } as Milestone, idx: idxOfMonth(beMonth) }]
      : [];

  // Year dividers + span labels (spec §3.6). A boundary sits at the LEFT edge of the
  // grand-opening month and every 12 months thereafter.
  const maxYear = Math.floor((monthly[n - 1].month - opening) / 12) + 1;
  const yearSpans = Array.from({ length: Math.max(1, maxYear) }, (_, k) => {
    const y = k + 1;
    const first = Math.max(opening + (y - 1) * 12, opening);
    const last = Math.min(opening + y * 12 - 1, monthly[n - 1].month);
    return { y, first, last, xMid: (xLeftOf(first) + (padL + (last / n) * plotW)) / 2 };
  }).filter((s) => s.last >= s.first);

  const milestoneDesc = markers.length
    ? ` Milestones: ${markers.map((mk) => `${mk.label} ${mk.ms.display}`).join("; ")}.`
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

  // Keyboard scrubber (spec §6): one composite role="slider" tab stop.
  const currentMonth = activeMonth ?? trough.month;
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
          aria-label={`Monthly net (bars) and cumulative cash (line) over ${n} months. Lowest cash balance ${trough.cumulativeCash.display} in month ${trough.month}; break-even ${beLabel}.${milestoneDesc} Full figures in the table below.`}
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

          {/* axis titles (identity carried here, not a standalone legend). At
              <=480px the two stack into two rows instead of sharing one — see
              the padT/cumTitle* comment above (owner item 1). The swatch
              shapes are aria-hidden; the text label already names the series. */}
          <g className="cashflow-chart__axis-label cashflow-chart__axis-label--net">
            <rect aria-hidden="true" className="cashflow-chart__axis-swatch--net-pos" x={padL} y={6} width={5} height={8} />
            <rect aria-hidden="true" className="cashflow-chart__axis-swatch--net-neg" x={padL + 5} y={6} width={5} height={8} />
            <text x={padL + 14} y={13} className="cashflow-chart__axis-label-text">Monthly net ($)</text>
          </g>
          <g className="cashflow-chart__axis-label cashflow-chart__axis-label--cum">
            <line aria-hidden="true" className="cashflow-chart__axis-swatch--cum" x1={cumTitleX1} x2={cumTitleX2} y1={cumTitleY} y2={cumTitleY} />
            <circle aria-hidden="true" className="cashflow-chart__axis-swatch--cum-dot" cx={cumTitleX2} cy={cumTitleY} r={2} />
            <text x={cumTitleTextX} y={cumTitleTextY} className="cashflow-chart__axis-label-text">Cumulative cash ($)</text>
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

          {/* left (net) axis: full-width gridlines (owner item 2) + labels. A
              lighter, net-tinted variant so the two grid families stay tellable
              apart; any row within 1 unit of a cumulative gridline is skipped
              here (collision rule — see the netGridVisible comment above). */}
          {net.ticks.map((t) => {
            const y = yFor(t, sNet);
            return (
              <g key={`ntick-${t}`}>
                {netGridVisible(y) && (
                  <line
                    className="cashflow-chart__gridline cashflow-chart__gridline--net"
                    x1={padL}
                    x2={padL + plotW}
                    y1={y}
                    y2={y}
                  />
                )}
                <text
                  className="cashflow-chart__axis-tick cashflow-chart__axis-tick--left"
                  x={padL - 6}
                  y={y + 3}
                >
                  {formatAxisTick(t)}
                </text>
              </g>
            );
          })}

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

          {/* cash-trough marker (= capital required) */}
          <circle
            cx={xCenter(troughIdx)}
            cy={yFor(trough.cumulativeCash.raw, sCum)}
            r={4}
            className="cashflow-chart__trough"
            data-testid="trough-marker"
          />

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

          {/* on-chart milestone labels (Grand Opening + Break-even), staggered */}
          {markers.map((mk, i) => {
            const lx = xCenter(mk.idx);
            const anchor = lx > W - padR - 40 ? "end" : lx < padL + 40 ? "start" : "middle";
            const labelY = milestoneBaseY + (i % 2) * 12;
            return (
              <g
                key={mk.key}
                data-testid={`${String(mk.key).toLowerCase()}-marker`}
                className={`cashflow-chart__milestone cashflow-chart__milestone--${mk.key}`}
              >
                <title>{`${mk.label}: ${mk.ms.display}`}</title>
                <line className="cashflow-chart__milestone-leader" x1={lx} x2={lx} y1={labelY + 3} y2={padT} />
                <text className="cashflow-chart__milestone-label" x={lx} y={labelY} textAnchor={anchor} aria-hidden="true">
                  {mk.icon} {mk.label} · {mk.ms.display}
                </text>
              </g>
            );
          })}

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
                              <span aria-hidden="true">{meta.icon}</span>
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

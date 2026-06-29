// web/src/components/CashflowChart.tsx — hand-rolled SVG monthly cash-flow.
//
// The signature decision artifact: the cumulative-cash trajectory (the hero line)
// with a tinted "underwater" deficit area, monthly NET bars on a secondary scale,
// the cash-trough marker (which IS the capital required) and the milestone
// crossings — paired with the full M0–M12 data table that is BOTH the dense detail
// and the chart's accessible text alternative. No chart library; positioning is
// pure layout geometry, not a projection figure (PRD §13) — every shown number is
// the server's { display } string.
//
// Epic G (#40) redesign:
//   - milestone names are labeled ON the plotted timeline (text by each marker),
//     NOT in a separate legend list (that visible list is removed);
//   - the series legend ("Cumulative cash" + "Net") sits on the LEFT;
//   - the left y-axis is labeled in $ with 2–3 gridline ticks (server display
//     strings + the $0 baseline — no client math);
//   - the chart and the monthly table SHARE one month-column geometry (a fixed
//     left gutter + N equal month bands), so chart M0..M12 align to the table
//     columns directly below.
import { isNegative } from "./displayLabels";
import type { ServerValue } from "../api/client";
import type { Milestone, Milestones, MonthlyPoint } from "../api/viewModel";

export interface CashflowChartProps {
  monthly: MonthlyPoint[];
  breakevenMonth: number | null;
  /** Server {raw,display} for Grand Opening / Break-even / Payback (issue #117).
   *  When present, all three are marked DISTINCTLY on the timeline using the
   *  server `raw` for position and `display` for the label — no client math.
   *  Optional so legacy snapshots without milestones still render. */
  milestones?: Milestones;
  width?: number;
  height?: number;
}

/** Distinct, non-color-only icon per milestone (shape carries meaning too). */
const MILESTONE_META: Array<{
  key: keyof Milestones;
  testid: string;
  label: string;
  icon: string;
}> = [
  { key: "grandOpening", testid: "grandopening-marker", label: "Grand Opening", icon: "⚑" },
  { key: "breakEven", testid: "breakeven-marker", label: "Break-even", icon: "▲" },
  { key: "payback", testid: "payback-marker", label: "Payback", icon: "★" },
];

// D3: label ONLY Grand Opening + Break-even ON the chart with short thin leader
// lines. Payback is intentionally NOT drawn on the plot (it would crowd the line);
// it lives in the header metric bar + the sr-only milestone summary below.
const ON_CHART_KEYS: Array<keyof Milestones> = ["grandOpening", "breakEven"];

const ROWS: Array<{ label: string; pick: (m: MonthlyPoint) => ServerValue }> = [
  { label: "Revenue", pick: (m) => m.revenue },
  { label: "Expenses", pick: (m) => m.expenses },
  { label: "Net", pick: (m) => m.net },
  { label: "Cumulative cash", pick: (m) => m.cumulativeCash },
];

export function CashflowChart({
  monthly,
  breakevenMonth,
  milestones,
  width = 660,
  height = 240,
}: CashflowChartProps) {
  if (!monthly.length) {
    return (
      <figure className="cashflow-chart" data-testid="cashflow-chart">
        <figcaption className="cashflow-chart__caption">No monthly cash-flow data.</figcaption>
      </figure>
    );
  }

  // The left gutter (14% of width) is shared with the monthly table's label column
  // (CSS `--cf-label-col: 14%`) so the chart's month bands sit directly above the
  // table's month columns. padR is 0 so the last band aligns with the last column.
  const padT = 30; // room for the on-chart milestone labels
  const padB = 22; // room for the M0..M12 ticks
  const padL = width * 0.14;
  const padR = 0;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const cums = monthly.map((m) => m.cumulativeCash.raw);
  // Pad the cumulative range with headroom so the zero baseline is never at the
  // extreme edge and the net bars (anchored to it) never clip top or bottom.
  const cLo = Math.min(0, ...cums);
  const cHi = Math.max(0, ...cums);
  const headroom = (cHi - cLo || 1) * 0.2;
  const cMin = cLo - headroom;
  const cMax = cHi + headroom;
  const cSpan = cMax - cMin || 1;
  const yLine = (v: number) => padT + ((cMax - v) / cSpan) * plotH;
  const zeroY = yLine(0);

  // Each month occupies an equal BAND; the series plot through the band CENTERS so
  // month i lines up with the table's i-th month column (both are N equal columns
  // inside the same shared width, after the same left gutter).
  const n = monthly.length;
  const bandW = plotW / n;
  const xAt = (i: number) => padL + (i + 0.5) * bandW;

  // Monthly NET bars on a secondary scale anchored at the zero line.
  const nets = monthly.map((m) => m.net.raw);
  const maxAbsNet = Math.max(1, ...nets.map((n2) => Math.abs(n2)));
  const barAmp = plotH * 0.12;
  const barW = Math.max(3, bandW * 0.46);

  const linePts = monthly.map((m, i) => `${xAt(i)},${yLine(m.cumulativeCash.raw)}`).join(" ");
  const areaPath =
    `M ${xAt(0)},${zeroY} ` +
    monthly.map((m, i) => `L ${xAt(i)},${yLine(m.cumulativeCash.raw)}`).join(" ") +
    ` L ${xAt(n - 1)},${zeroY} Z`;

  // Trough = the most-negative cumulative position (the cash low point); peak = the
  // highest. Their server display strings label the y-axis ticks (no client math).
  let troughIdx = 0;
  let peakIdx = 0;
  for (let i = 1; i < n; i++) {
    if (monthly[i].cumulativeCash.raw < monthly[troughIdx].cumulativeCash.raw) troughIdx = i;
    if (monthly[i].cumulativeCash.raw > monthly[peakIdx].cumulativeCash.raw) peakIdx = i;
  }
  const trough = monthly[troughIdx];
  const peak = monthly[peakIdx];

  // Locate a milestone on the series by its server month value (raw), not array
  // position — robust if the series is ever not 1-based-contiguous. Returns -1
  // for an unreached (raw null) milestone so NO phantom marker is drawn at 0.
  const idxOf = (raw: number | null | undefined) =>
    raw == null ? -1 : monthly.findIndex((m) => m.month === raw);

  // D3: only Grand Opening + Break-even are labeled ON the chart (Break-even falls
  // back to the legacy `breakevenMonth` prop when no milestones object is supplied).
  const markers = milestones
    ? MILESTONE_META.filter((meta) => ON_CHART_KEYS.includes(meta.key))
        .map((meta) => {
          const ms: Milestone = milestones[meta.key];
          return { ...meta, ms, idx: idxOf(ms.raw) };
        })
        .filter((mk) => mk.idx >= 0)
    : [];

  // Break-even line shown even without a milestones object (back-compat).
  const beIdx = milestones ? idxOf(milestones.breakEven.raw) : idxOf(breakevenMonth);

  const beLabel = milestones
    ? milestones.breakEven.raw != null
      ? milestones.breakEven.display
      : "not within Year 1"
    : breakevenMonth != null && breakevenMonth >= 0
      ? `month ${breakevenMonth}`
      : "not within Year 1";

  // Accessible description (role=img): the markers' on-chart text is decorative, so
  // the milestone facts travel here + in the sr-only list + the data table below.
  const milestoneDesc = markers.length
    ? ` Milestones: ${markers.map((mk) => `${mk.label} ${mk.ms.display}`).join("; ")}.`
    : "";

  // y-axis ticks: peak, $0 baseline, trough (deduped by y). Labels are server
  // display strings ($0 is the constant baseline) — never re-derived.
  const axisTicks = [
    { y: yLine(peak.cumulativeCash.raw), label: peak.cumulativeCash.display },
    { y: zeroY, label: "$0" },
    { y: yLine(trough.cumulativeCash.raw), label: trough.cumulativeCash.display },
  ].filter((t, i, arr) => arr.findIndex((o) => Math.abs(o.y - t.y) < 6) === i);

  return (
    <figure className="cashflow-chart" data-testid="cashflow-chart">
      <div className="cashflow-chart__frame">
        {/* Series legend — on the LEFT (#40). Each entry pairs a swatch with a TEXT
            label so the two series are never told apart by color alone. */}
        <ul className="cashflow-chart__legend" data-testid="cashflow-legend" aria-label="Chart series">
          <li className="cashflow-chart__legend-item">
            <span className="cashflow-chart__legend-swatch cashflow-chart__legend-swatch--cum" aria-hidden="true" />
            Cumulative cash
          </li>
          <li className="cashflow-chart__legend-item">
            <span className="cashflow-chart__legend-swatch cashflow-chart__legend-swatch--net" aria-hidden="true" />
            Net
          </li>
        </ul>

        {/* The plot + the monthly table share ONE scroll container and the SAME
            month geometry, so the chart columns align to the table columns. */}
        <div className="cashflow-chart__plot">
          {/* #196: no fixed pixel height — the box follows the viewBox aspect via CSS
              so a narrow phone column scales the chart proportionally. The viewBox
              keeps the 660x240 drawing geometry. */}
          <svg
            className="cashflow-chart__svg"
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            role="img"
            preserveAspectRatio="xMidYMid meet"
            aria-label={`Monthly cumulative cash. Lowest cash balance ${trough.cumulativeCash.display} in month ${trough.month}; break-even ${beLabel}.${milestoneDesc} Full figures in the table below.`}
          >
            {/* left y-axis ($), with 2–3 gridline ticks labeled by server display */}
            <text
              x={4}
              y={padT - 14}
              className="cashflow-chart__axis-title"
              data-testid="cashflow-axis-label"
            >
              $
            </text>
            <line
              x1={padL}
              x2={padL}
              y1={padT}
              y2={height - padB}
              className="cashflow-chart__axis"
            />
            {axisTicks.map((t) => (
              <g key={t.label}>
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={t.y}
                  y2={t.y}
                  className="cashflow-chart__gridline"
                />
                <text x={padL - 6} y={t.y + 3} className="cashflow-chart__axis-tick">
                  {t.label}
                </text>
              </g>
            ))}

            {/* tinted area between the cumulative line and the zero baseline */}
            <path d={areaPath} className="cashflow-chart__area" />

            {/* monthly net bars (secondary scale) behind the line */}
            {monthly.map((m, i) => {
              const h = (m.net.raw / maxAbsNet) * barAmp;
              const up = m.net.raw >= 0;
              return (
                <rect
                  key={`bar-${m.month}`}
                  x={xAt(i) - barW / 2}
                  y={up ? zeroY - h : zeroY}
                  width={barW}
                  height={Math.max(0.5, Math.abs(h))}
                  className={up ? "cashflow-chart__bar" : "cashflow-chart__bar cashflow-chart__bar--neg"}
                />
              );
            })}

            {/* zero baseline (kept distinct from the gridlines) */}
            <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} className="cashflow-chart__zero" />

            {/* hero cumulative-cash line */}
            <polyline points={linePts} fill="none" className="cashflow-chart__line" />

            {/* cash-trough marker (= capital required) */}
            <circle
              cx={xAt(troughIdx)}
              cy={yLine(trough.cumulativeCash.raw)}
              r={4}
              className="cashflow-chart__trough"
              data-testid="trough-marker"
            />

            {/* D3: Grand Opening + Break-even labeled ABOVE the plot, each with a
                SHORT thin leader line down to the curve — never a full vertical line
                through the label text, and the two labels are staggered onto separate
                rows so they never overlap. Never color alone (icon + text). */}
            {milestones
              ? markers.map((mk, i) => {
                  const lx = xAt(mk.idx);
                  // Anchor the label inside the plot near the edges so it never clips.
                  const anchor = lx > width - 64 ? "end" : lx < padL + 64 ? "start" : "middle";
                  // Stagger by index so close labels sit on separate rows (no overlap).
                  const labelY = 9 + (i % 2) * 11;
                  // The leader is SHORT: from just under the label down to the top of
                  // the plot region (a thin connector), not a line across the plot.
                  return (
                    <g
                      key={mk.key}
                      data-testid={mk.testid}
                      className={`cashflow-chart__milestone cashflow-chart__milestone--${mk.key}`}
                    >
                      <title>{`${mk.label}: ${mk.ms.display}`}</title>
                      <line
                        x1={lx}
                        x2={lx}
                        y1={labelY + 3}
                        y2={padT}
                        className="cashflow-chart__milestone-leader"
                      />
                      <text
                        x={lx}
                        y={labelY}
                        textAnchor={anchor}
                        className="cashflow-chart__milestone-label"
                        aria-hidden="true"
                      >
                        {mk.icon} {mk.label} · {mk.ms.display}
                      </text>
                    </g>
                  );
                })
              : beIdx >= 0 && (
                  <line
                    x1={xAt(beIdx)}
                    x2={xAt(beIdx)}
                    y1={padT}
                    y2={height - padB}
                    className="cashflow-chart__breakeven"
                    data-testid="breakeven-marker"
                  />
                )}
          </svg>

          {/* The dense monthly detail — aligned to the chart, and the chart's
              accessible data table. table-layout:fixed + the shared label gutter
              keep the columns under the chart's month bands. */}
          <table className="cashflow-table" data-testid="cashflow-table">
            <caption className="sr-only">Monthly cash-flow, months 0 to 12</caption>
            <thead>
              <tr>
                <th scope="col" className="cashflow-table__label">
                  Line item
                </th>
                {monthly.map((m) => (
                  <th scope="col" key={m.month} className="num">
                    Mo. {m.month}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label}>
                  <th scope="row" className="cashflow-table__label">
                    {r.label}
                  </th>
                  {monthly.map((m) => {
                    const cell = r.pick(m);
                    // #148: a loss reads as a loss — error color PAIRED with the
                    // server's parentheses (the non-color cue), never color alone.
                    return (
                      <td
                        key={m.month}
                        className="num"
                        data-negative={isNegative(cell) ? "true" : undefined}
                      >
                        {cell.display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* D5: the bottom "Cash low point … · Break-even …" figcaption is REMOVED —
          break-even lives on the chart + in the header metric bar, and the lowest
          cash balance reads from the chart's accessible label + the monthly table. */}

      {/* The keyboard/SR text alternative to the on-chart milestone labels (the
          visible legend LIST is gone; labels now sit on the chart). Visually hidden
          but exposed to assistive tech so an unreached milestone still reads its
          explicit N/A-with-reason, never a 0. */}
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
    </figure>
  );
}

// web/src/components/CashflowChart.tsx — hand-rolled SVG monthly cash-flow.
//
// The signature decision artifact: the cumulative-cash trajectory (the hero line)
// with a tinted "underwater" deficit area, monthly NET bars on a secondary scale,
// the cash-trough marker (which IS the capital required) and the break-even
// crossing — paired with the full M0–M12 data table that is BOTH the dense detail
// and the chart's accessible text alternative. No chart library; positioning is
// pure layout geometry, not a projection figure (PRD §13) — every shown number is
// the server's { display } string.
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

  const padT = 16;
  const padB = 26;
  const padL = 12;
  const padR = 12;
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

  const stepX = monthly.length > 1 ? plotW / (monthly.length - 1) : 0;
  const xAt = (i: number) => padL + i * stepX;

  // Monthly NET bars on a secondary scale anchored at the zero line.
  const nets = monthly.map((m) => m.net.raw);
  const maxAbsNet = Math.max(1, ...nets.map((n) => Math.abs(n)));
  const barAmp = plotH * 0.12;
  const barW = Math.max(3, stepX * 0.46);

  const linePts = monthly.map((m, i) => `${xAt(i)},${yLine(m.cumulativeCash.raw)}`).join(" ");
  const areaPath =
    `M ${xAt(0)},${zeroY} ` +
    monthly.map((m, i) => `L ${xAt(i)},${yLine(m.cumulativeCash.raw)}`).join(" ") +
    ` L ${xAt(monthly.length - 1)},${zeroY} Z`;

  // Trough = the most-negative cumulative position (the cash low point).
  let troughIdx = 0;
  for (let i = 1; i < monthly.length; i++) {
    if (monthly[i].cumulativeCash.raw < monthly[troughIdx].cumulativeCash.raw) troughIdx = i;
  }
  const trough = monthly[troughIdx];

  // Locate a milestone on the series by its server month value (raw), not array
  // position — robust if the series is ever not 1-based-contiguous. Returns -1
  // for an unreached (raw null) milestone so NO phantom marker is drawn at 0.
  const idxOf = (raw: number | null | undefined) =>
    raw == null ? -1 : monthly.findIndex((m) => m.month === raw);

  // The three distinct milestone markers (issue #117). Break-even falls back to
  // the legacy `breakevenMonth` prop when no milestones object is supplied, so
  // existing callers keep their single break-even line.
  const markers = milestones
    ? MILESTONE_META.map((meta) => {
        const ms: Milestone = milestones[meta.key];
        return { ...meta, ms, idx: idxOf(ms.raw) };
      }).filter((mk) => mk.idx >= 0)
    : [];

  // Break-even line shown even without a milestones object (back-compat).
  const beIdx = milestones ? idxOf(milestones.breakEven.raw) : idxOf(breakevenMonth);

  // X ticks: first, ~thirds, last — labeled by the server month index.
  const tickIdx = monthly.length
    ? Array.from(new Set([0, Math.round((monthly.length - 1) / 3), Math.round((2 * (monthly.length - 1)) / 3), monthly.length - 1]))
    : [];

  const beLabel = milestones
    ? milestones.breakEven.raw != null
      ? milestones.breakEven.display
      : "not within Year 1"
    : breakevenMonth != null && breakevenMonth >= 0
      ? `month ${breakevenMonth}`
      : "not within Year 1";

  return (
    <figure className="cashflow-chart" data-testid="cashflow-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        preserveAspectRatio="xMidYMid meet"
        aria-label={`Monthly cumulative cash. Low point ${trough.cumulativeCash.display} in month ${trough.month}; break-even ${beLabel}. Full figures in the table below.`}
      >
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

        {/* zero baseline */}
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

        {/* Distinct milestone markers (Grand Opening / Break-even / Payback).
            Each carries a distinct stroke class AND a distinct icon glyph so the
            three never rely on color alone (a11y). Server `display` labels the
            title; an unreached milestone is filtered out — never a 0 marker. */}
        {milestones
          ? markers.map((mk) => (
              <g
                key={mk.key}
                data-testid={mk.testid}
                className={`cashflow-chart__milestone cashflow-chart__milestone--${mk.key}`}
              >
                <title>{`${mk.label}: ${mk.ms.display}`}</title>
                <line
                  x1={xAt(mk.idx)}
                  x2={xAt(mk.idx)}
                  y1={padT}
                  y2={height - padB}
                  className="cashflow-chart__milestone-line"
                />
                <text
                  x={xAt(mk.idx)}
                  y={padT - 4}
                  className="cashflow-chart__milestone-icon"
                  aria-hidden="true"
                >
                  {mk.icon}
                </text>
              </g>
            ))
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

        {/* x-axis month ticks */}
        {tickIdx.map((i) => (
          <text key={`tick-${i}`} x={xAt(i)} y={height - 8} className="cashflow-chart__tick">
            M{monthly[i].month}
          </text>
        ))}
      </svg>

      <figcaption className="cashflow-chart__caption">
        Cash low point <strong className="num">{trough.cumulativeCash.display}</strong> in month{" "}
        {trough.month} · Break-even <strong>{beLabel}</strong>
      </figcaption>

      {/* Milestone callouts — the keyboard-accessible, text alternative to the
          on-chart markers. Each pairs a distinct icon (shape, not color alone)
          with the milestone name and the server's display string. An unreached
          milestone reads its explicit N/A-with-reason, never a 0. */}
      {milestones && (
        <ul className="cashflow-chart__milestones" data-testid="chart-milestones">
          {MILESTONE_META.map((meta) => {
            const ms: Milestone = milestones[meta.key];
            const reached = ms.raw != null;
            const when = reached ? ms.display : (ms.reason ?? ms.display);
            return (
              <li
                key={meta.key}
                className={`cashflow-chart__milestone-item cashflow-chart__milestone-item--${meta.key}`}
              >
                <span className="cashflow-chart__milestone-badge" aria-hidden="true">
                  {meta.icon}
                </span>
                <span className="cashflow-chart__milestone-name">{meta.label}</span>
                <span className="cashflow-chart__milestone-when">
                  {when}
                  {reached && ms.duration ? ` (${ms.duration})` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* The dense monthly detail — and the chart's accessible data table. */}
      <div className="cashflow-table__scroll">
        <table className="cashflow-table" data-testid="cashflow-table">
          <caption className="sr-only">Monthly cash-flow, months 0 to 12</caption>
          <thead>
            <tr>
              <th scope="col">Line item</th>
              {monthly.map((m) => (
                <th scope="col" key={m.month} className="num">
                  M{m.month}
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
    </figure>
  );
}

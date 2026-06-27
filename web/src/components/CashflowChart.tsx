// web/src/components/CashflowChart.tsx — hand-rolled SVG monthly cash-flow.
//
// The signature decision artifact: the cumulative-cash trajectory (the hero line)
// with a tinted "underwater" deficit area, monthly NET bars on a secondary scale,
// the cash-trough marker (which IS the capital required) and the break-even
// crossing — paired with the full M0–M12 data table that is BOTH the dense detail
// and the chart's accessible text alternative. No chart library; positioning is
// pure layout geometry, not a projection figure (PRD §13) — every shown number is
// the server's { display } string.
import type { MonthlyPoint } from "../api/viewModel";

export interface CashflowChartProps {
  monthly: MonthlyPoint[];
  breakevenMonth: number | null;
  width?: number;
  height?: number;
}

const ROWS: Array<{ label: string; pick: (m: MonthlyPoint) => { display: string } }> = [
  { label: "Revenue", pick: (m) => m.revenue },
  { label: "Expenses", pick: (m) => m.expenses },
  { label: "Net", pick: (m) => m.net },
  { label: "Cumulative cash", pick: (m) => m.cumulativeCash },
];

export function CashflowChart({
  monthly,
  breakevenMonth,
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

  // Break-even marker by the actual month value (server month index), not array
  // position — robust if the series is ever not 0-based-contiguous.
  const beIdx = breakevenMonth == null ? -1 : monthly.findIndex((m) => m.month === breakevenMonth);

  // X ticks: first, ~thirds, last — labeled by the server month index.
  const tickIdx = monthly.length
    ? Array.from(new Set([0, Math.round((monthly.length - 1) / 3), Math.round((2 * (monthly.length - 1)) / 3), monthly.length - 1]))
    : [];

  const beLabel =
    breakevenMonth != null && breakevenMonth >= 0
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

        {/* break-even crossing */}
        {beIdx >= 0 && (
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
                {monthly.map((m) => (
                  <td key={m.month} className="num">
                    {r.pick(m).display}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

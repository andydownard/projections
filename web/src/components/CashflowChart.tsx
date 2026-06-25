// web/src/components/CashflowChart.tsx — hand-rolled SVG monthly cash-flow.
//
// No chart library, no client math beyond pure layout geometry (positioning is
// not a projection figure — PRD §13). Plots cumulativeCash.raw across M0–M12 and
// marks the break-even month. Values are the server's; we only scale to pixels.
import type { MonthlyPoint } from "../api/viewModel";

export interface CashflowChartProps {
  monthly: MonthlyPoint[];
  breakevenMonth: number | null;
  width?: number;
  height?: number;
}

export function CashflowChart({
  monthly,
  breakevenMonth,
  width = 640,
  height = 220,
}: CashflowChartProps) {
  const pad = 8;
  const xs = monthly.map((m) => m.cumulativeCash.raw);
  const min = Math.min(0, ...xs);
  const max = Math.max(0, ...xs);
  const span = max - min || 1;
  const stepX = monthly.length > 1 ? (width - 2 * pad) / (monthly.length - 1) : 0;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);

  const points = monthly
    .map((m, i) => `${pad + i * stepX},${y(m.cumulativeCash.raw)}`)
    .join(" ");

  return (
    <figure
      className="cashflow-chart"
      data-testid="cashflow-chart"
      aria-label="Monthly cumulative cash"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* zero baseline */}
        <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} className="cashflow-chart__zero" />
        <polyline points={points} fill="none" className="cashflow-chart__line" />
        {breakevenMonth != null && breakevenMonth >= 0 && (
          <line
            x1={pad + breakevenMonth * stepX}
            x2={pad + breakevenMonth * stepX}
            y1={pad}
            y2={height - pad}
            className="cashflow-chart__breakeven"
            data-testid="breakeven-marker"
          />
        )}
      </svg>
    </figure>
  );
}

export default CashflowChart;

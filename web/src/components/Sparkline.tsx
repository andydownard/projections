// web/src/components/Sparkline.tsx — tiny hand-rolled SVG sparkline (v2 redesign).
//
// Renders Y1..Y5 annual net income as a trajectory line against a zero baseline,
// so profitability and loss periods read clearly at a glance on the list and
// detail pages. GEOMETRY/RENDERING ONLY — receives the numeric points from the
// server and the server's display label; does NO financial arithmetic (PRD §13).
// Consistent with the repo's hand-rolled-SVG-charts pattern (CashflowChart).
import type { SVGAttributes } from "react";

export interface SparklineProps {
  /** Y1..Y5 annual net income values from the server (may be negative). */
  points: number[];
  /** Server-formatted display string for the Y5 net income value. */
  y5Label?: string;
  /** Server display string per point (#320): when supplied, each point gets a
   *  hover target whose native <title> reads "Year {i+1}: {labels[i]}". Display
   *  strings only — no math (PRD §13). */
  labels?: string[];
  width?: number;
  height?: number;
  "aria-label"?: string;
}

// Internal padding constants
const PAD_T = 4;
const PAD_B = 4;
const PAD_L = 4;
const PAD_R = 44; // room for y5 label on the right

export function Sparkline({
  points,
  y5Label,
  labels,
  width = 120,
  height = 36,
  "aria-label": ariaLabel,
}: SparklineProps) {
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  // Compute the y-range including 0 so the baseline is always within the plot.
  const allValues = points.length > 0 ? [...points, 0] : [0, 1];
  const minV = Math.min(...allValues);
  const maxV = Math.max(...allValues);
  // When all values are equal (flat line, e.g. all 0 or all 100), avoid ÷0.
  const rangeV = maxV - minV || 1;

  // SVG y increases downward: maxV maps to the top (padT), minV to the bottom.
  const toY = (v: number): number => PAD_T + ((maxV - v) / rangeV) * plotH;

  // X positions: spread N points across the plot width.
  // Single point stays at the left edge; multiple points span left→right.
  const toX = (i: number): number =>
    PAD_L + (points.length > 1 ? (i / (points.length - 1)) * plotW : 0);

  const zeroY = toY(0);

  // Build the polyline points attribute string.
  const polylinePts = points.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");

  // The last point (Y5) is where we place the label.
  const lastIdx = Math.max(0, points.length - 1);
  const lastX = toX(lastIdx);
  const lastY = points.length > 0 ? toY(points[lastIdx]) : zeroY;

  // Default aria-label names the series Y1→Y5 and ends with the Y5 display value.
  const defaultAriaLabel = y5Label
    ? `Annual net income Year 1 to Year 5, ending at ${y5Label}`
    : "Annual net income Year 1 to Year 5";
  const svgAriaLabel = ariaLabel ?? defaultAriaLabel;

  const svgProps: SVGAttributes<SVGSVGElement> = {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": svgAriaLabel,
  };

  // Empty array: render a minimal SVG with just the baseline
  if (points.length === 0) {
    return (
      <svg {...svgProps} className="sparkline">
        <line
          data-testid="sparkline-baseline"
          x1={PAD_L}
          x2={width - PAD_R}
          y1={zeroY}
          y2={zeroY}
          className="sparkline__baseline"
        />
      </svg>
    );
  }

  return (
    <svg {...svgProps} className="sparkline">
      {/* Zero baseline: a horizontal line at net-income = 0 within the plotted
          range. Uses CSS token --spark-zero. Dips below 0 visibly cross it. */}
      <line
        data-testid="sparkline-baseline"
        x1={PAD_L}
        x2={width - PAD_R}
        y1={zeroY}
        y2={zeroY}
        className="sparkline__baseline"
      />

      {/* Trajectory polyline: Y1..Y5 net income. Uses CSS token --spark-line. */}
      {points.length > 1 && (
        <polyline
          points={polylinePts}
          fill="none"
          className="sparkline__line"
        />
      )}

      {/* Single-point: render as a small dot instead of a (degenerate) line */}
      {points.length === 1 && (
        <>
          <polyline
            points={`${toX(0)},${toY(points[0])} ${toX(0)},${toY(points[0])}`}
            fill="none"
            className="sparkline__line"
          />
        </>
      )}

      {/* Per-point hover targets (#320): a small invisible circle over each point
          whose native <title> shows "Year N: <server display>". A <title> is the
          accessible/native SVG tooltip — NOT a <text> element — so it never adds a
          visible label or trips the y5-label gate. Display strings only (no math). */}
      {labels &&
        points.map((v, i) => (
          <circle
            key={`pt-${i}`}
            data-testid={`sparkline-point-${i}`}
            className="sparkline__point"
            cx={toX(i)}
            cy={toY(v)}
            r={6}
          >
            <title>{`Year ${i + 1}: ${labels[i] ?? ""}`}</title>
          </circle>
        ))}

      {/* Y5 net-income label (server display string, e.g. "($12,340)" / "$1,200").
          Positioned to the right of the last point; aria-hidden because the label
          text is included in the SVG's aria-label. */}
      {y5Label && (
        <text
          x={lastX + 4}
          y={lastY + 4}
          className="sparkline__y5-label"
          aria-hidden="true"
        >
          {y5Label}
        </text>
      )}
    </svg>
  );
}

export default Sparkline;

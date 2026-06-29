// web/src/components/Sparkline.test.tsx — tiny SVG annual-net-income sparkline.
//
// DISPLAY/GEOMETRY ONLY — receives server-computed points; does NO math.
// Points are Y1..Y5 annual net income; the zero baseline makes dips below
// zero visually obvious. Tests cover rendering, a11y, and edge cases.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sparkline } from "./Sparkline";

// Helper: extract coordinate pairs from a polyline points attribute
function parsePolylinePoints(el: SVGPolylineElement): Array<{ x: number; y: number }> {
  return (el.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
}

describe("Sparkline", () => {
  // --- polyline geometry ---

  it("renders one polyline point per data point", () => {
    render(<Sparkline points={[1000, 2000, 3000, 4000, 5000]} />);
    const polyline = document.querySelector("polyline")!;
    expect(polyline).not.toBeNull();
    const pts = parsePolylinePoints(polyline);
    expect(pts).toHaveLength(5);
  });

  it("renders a polyline with 3 points for 3-point input", () => {
    render(<Sparkline points={[-500, 0, 800]} />);
    const pts = parsePolylinePoints(document.querySelector("polyline")!);
    expect(pts).toHaveLength(3);
  });

  // --- zero baseline ---

  it("renders the zero baseline element", () => {
    render(<Sparkline points={[1000, 2000, 3000, 4000, 5000]} />);
    expect(screen.getByTestId("sparkline-baseline")).toBeInTheDocument();
  });

  it("zero baseline is a horizontal line (y1 === y2)", () => {
    render(<Sparkline points={[1000, -500, 2000, 3000, 4000]} />);
    const baseline = screen.getByTestId("sparkline-baseline");
    const y1 = Number(baseline.getAttribute("y1"));
    const y2 = Number(baseline.getAttribute("y2"));
    expect(y1).toBe(y2);
  });

  // --- negative points below baseline ---

  it("a negative point's y-coordinate is below the baseline y-coordinate", () => {
    // Negative net income maps to a higher SVG y (SVG y increases downward)
    render(<Sparkline points={[1000, 2000, -500, 1000, 500]} />);
    const polyline = document.querySelector("polyline")!;
    const pts = parsePolylinePoints(polyline);
    const baseline = screen.getByTestId("sparkline-baseline");
    const baselineY = Number(baseline.getAttribute("y1"));
    // The negative point is at index 2
    expect(pts[2].y).toBeGreaterThan(baselineY);
  });

  it("all-negative points: all y-coords below the baseline", () => {
    render(<Sparkline points={[-100, -200, -300, -200, -100]} />);
    const polyline = document.querySelector("polyline")!;
    const pts = parsePolylinePoints(polyline);
    const baselineY = Number(screen.getByTestId("sparkline-baseline").getAttribute("y1"));
    for (const pt of pts) {
      expect(pt.y).toBeGreaterThanOrEqual(baselineY);
    }
  });

  // --- y5 label ---

  it("renders the y5Label string when provided", () => {
    render(<Sparkline points={[1000, 2000, 3000, 4000, 5000]} y5Label="$5,000" />);
    expect(screen.getByText("$5,000")).toBeInTheDocument();
  });

  it("omits the y5 label when not provided", () => {
    const { container } = render(<Sparkline points={[1000, 2000]} />);
    // No text element with a dollar-formatted label
    const texts = container.querySelectorAll("text");
    // The aria-label might be on the svg, but no visible y5 label text
    expect(texts).toHaveLength(0);
  });

  // --- accessibility ---

  it("has role=img on the SVG", () => {
    render(<Sparkline points={[1000, 2000, 3000, 4000, 5000]} />);
    const svg = document.querySelector("svg")!;
    expect(svg).toHaveAttribute("role", "img");
  });

  it("aria-label names the series Y1 to Y5 ending with y5Label", () => {
    render(
      <Sparkline points={[1000, 2000, 3000, 4000, 5000]} y5Label="$5,000" />,
    );
    const svg = document.querySelector("svg")!;
    const label = svg.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/year 1/i);
    expect(label).toMatch(/year 5/i);
    expect(label).toContain("$5,000");
  });

  it("custom aria-label overrides the default", () => {
    render(
      <Sparkline points={[1000]} aria-label="Net income trend" />,
    );
    expect(document.querySelector("svg")).toHaveAttribute("aria-label", "Net income trend");
  });

  // --- edge cases ---

  it("empty points array does not throw", () => {
    expect(() => render(<Sparkline points={[]} />)).not.toThrow();
  });

  it("single point does not throw", () => {
    expect(() => render(<Sparkline points={[5000]} />)).not.toThrow();
  });

  it("all-equal points renders a flat line (same y for all)", () => {
    render(<Sparkline points={[100, 100, 100]} />);
    const pts = parsePolylinePoints(document.querySelector("polyline")!);
    expect(pts.every((p) => p.y === pts[0].y)).toBe(true);
  });

  // --- per-point hover tooltips (#320 layout) ---

  it("renders a per-point hover target with a Year N: <label> <title> when labels are given", () => {
    render(
      <Sparkline
        points={[1000, 2000, 3000, 4000, 5000]}
        labels={["$1,000", "$2,000", "$3,000", "$4,000", "$5,000"]}
      />,
    );
    const points = document.querySelectorAll("[data-testid^='sparkline-point-']");
    expect(points).toHaveLength(5);
    const titles = Array.from(document.querySelectorAll("title")).map((t) => t.textContent);
    expect(titles).toContain("Year 1: $1,000");
    expect(titles).toContain("Year 5: $5,000");
  });

  it("adds no <text> elements when labels are given but no y5Label (titles are not text)", () => {
    const { container } = render(
      <Sparkline points={[1000, 2000]} labels={["$1,000", "$2,000"]} />,
    );
    // <title> is not a <text> element, so the existing y5-label gate still holds.
    expect(container.querySelectorAll("text")).toHaveLength(0);
  });
});

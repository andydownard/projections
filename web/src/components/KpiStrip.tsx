// web/src/components/KpiStrip.tsx — the "2nd tile set" (server KPIs), extracted.
//
// The high-level decision tiles (capital / break-even / payback) live in
// ProjectionTab; this is the SECOND tile set — the stored server `kpis[]` figures
// (Total revenue, Net profit, Labor ratio, …). Epic G (#40/#41) relocates it into
// the detail page's "KPIs" tab (edit) / inline below the projection (read). It is
// pure presentation: every figure is the server's { display } string (PRD §13, no
// client math); the negative cue is read from the server `raw` SIGN and paired with
// the server's parentheses, never color alone (#148).
import { isNegative } from "./displayLabels";
import type { Kpi } from "../api/viewModel";

export interface KpiStripProps {
  kpis: Kpi[];
}

export function KpiStrip({ kpis }: KpiStripProps) {
  return (
    <div className="kpis" data-testid="kpi-strip">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="kpi"
          data-testid={/^total revenue$/i.test(k.label) ? "kpi-revenue" : `kpi-${k.label}`}
        >
          <span className="kpi__label">{k.label}</span>
          <span className="kpi__value" data-negative={isNegative(k.value) ? "true" : undefined}>
            {k.value.display}
          </span>
          {k.sub && <span className="kpi__sub">{k.sub}</span>}
        </div>
      ))}
    </div>
  );
}

export default KpiStrip;

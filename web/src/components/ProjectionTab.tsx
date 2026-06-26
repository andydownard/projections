// web/src/components/ProjectionTab.tsx — the read-only Projection tab (M2 D3).
//
// Renders the Appendix-D view-model VERBATIM (PRD §13, CLAUDE.md hard rule):
//   - decision banner: reco chip carrying an ICON + TEXT (never color alone) +
//     headline + sub (DecisionBanner / RecoChip).
//   - three decision tiles (capital / break-even / cash-gap), each pairing the
//     server `metrics.*.display` value with its downside/confidence detail
//     (`reasonCapital` / `reasonBreakeven` / `reasonGap`).
//   - the hand-rolled monthly cash-flow SVG with a break-even marker (CashflowChart).
//   - the 3-year table with an Input/Computed/Overridden/Estimated legend and a
//     per-cell state class taken from the SERVER `row.class` (the client never
//     classifies a cell).
//
// NO client math: every figure is the server's { display } string. The cell-state
// class is a SEMANTIC token class (cell--input/computed/overridden/estimated) so
// meaning never depends on the brand layer and never relies on color alone — the
// legend names each state in text and the Estimated marker is an icon (tokens.css).
import { useState, type KeyboardEvent } from "react";

import { RecoChip } from "./RecoChip";
import { CashflowChart } from "./CashflowChart";
import type { Metrics, Row, ViewModel } from "../api/viewModel";

export interface ProjectionTabProps {
  vm: ViewModel;
  /** Live-region text for an autosave/recompute settle (a11y: recompute announced). */
  recomputeStatus?: string;
  /** Activate an editable (input) driver/override cell — keyboard + click. */
  onEditCell?: (node: string, year: number) => void;
}

interface TileDef {
  testid: string;
  /** Back-compat alias kept for the existing e2e/detail contract. */
  metricTestid: string;
  label: string;
  value: (m: Metrics) => { display: string };
  reason: (m: Metrics) => string | undefined;
}

const TILES: TileDef[] = [
  {
    testid: "tile-capital",
    metricTestid: "metric-capital",
    label: "Startup capital required",
    value: (m) => m.capital,
    reason: (m) => m.reasonCapital,
  },
  {
    testid: "tile-breakeven",
    metricTestid: "metric-breakeven",
    label: "Break-even (payback)",
    value: (m) => m.breakeven,
    reason: (m) => m.reasonBreakeven,
  },
  {
    testid: "tile-cashgap",
    metricTestid: "metric-cashgap",
    label: "First-year cash gap",
    value: (m) => m.cashGap,
    reason: (m) => m.reasonGap,
  },
];

const LEGEND: Array<{ cls: string; label: string }> = [
  { cls: "input", label: "Input" },
  { cls: "computed", label: "Computed" },
  { cls: "overridden", label: "Overridden" },
  { cls: "estimated", label: "Estimated" },
];

/** Stable, slugified node id for a row (e.g. "Net profit" -> "net_profit").
 *  Used for the back-compat `row-<slug>-y<year>` testid the detail/e2e read. */
function rowSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Pull the per-year share for the table header sub-label (display string only). */
function shareFor(rows: Row[], year: 1 | 2 | 3): string | null {
  const r = rows.find((row) => /share/i.test(row.label) && row.group === "drivers");
  const cell = r ? r[`y${year}` as "y1" | "y2" | "y3"] : null;
  return cell ? cell.display : null;
}

export function ProjectionTab({ vm, recomputeStatus = "", onEditCell }: ProjectionTabProps) {
  const { reco, metrics, kpis, monthly, breakevenMonth, rows } = vm;

  // Each decision tile's reason is a tappable "Why?" disclosure (touch-safe; no
  // hover). Independent toggles so a board member can compare reasons side by side.
  const [openReasons, setOpenReasons] = useState<Set<string>>(() => new Set());
  const toggleReason = (id: string) =>
    setOpenReasons((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="projection-tab" data-testid="projection-tab">
      {/* Recompute / autosave live-region — a settle is announced to SR users. */}
      <span data-testid="recompute-status" role="status" aria-live="polite" className="sr-status">
        {recomputeStatus}
      </span>

      {/* Decision banner — verdict (semantic reco chip: icon + TEXT, never color
          alone) + headline + sub, then the three decision tiles. The tiles ARE the
          banner's metric strip, each value paired with its downside/confidence
          reason string from the server (no duplicate metric surface). */}
      <section
        className="decision-banner"
        data-testid="decision-banner"
        data-tag={reco.tag}
        aria-label="Decision"
      >
        <div className="decision-banner__verdict">
          <RecoChip tag={reco.tag} />
          <div>
            <p className="decision-banner__headline">{reco.headline}</p>
            <p className="decision-banner__sub">{reco.sub}</p>
          </div>
        </div>

        <dl className="decision-tiles" data-testid="decision-tiles">
          {TILES.map((t) => (
            <div
              key={t.testid}
              className="decision-tile metric"
              data-testid={t.testid}
              data-metric={t.metricTestid}
            >
              {/* Back-compat hook: the existing detail/e2e contract reads
                  metric-capital / metric-breakeven / metric-cashgap. The tile IS
                  that metric, now enriched with its downside/confidence reason. */}
              <span data-testid={t.metricTestid} className="sr-only">
                {t.value(metrics).display}
              </span>
              <dt className="decision-tile__label">{t.label}</dt>
              <dd className="decision-tile__value num">{t.value(metrics).display}</dd>
              {t.reason(metrics) && (
                <div className="decision-tile__reason-wrap">
                  <button
                    type="button"
                    className="decision-tile__why"
                    aria-expanded={openReasons.has(t.testid)}
                    aria-controls={`${t.testid}-reason`}
                    onClick={() => toggleReason(t.testid)}
                  >
                    Why?
                  </button>
                  {openReasons.has(t.testid) && (
                    <p className="decision-tile__reason" id={`${t.testid}-reason`} role="note">
                      {t.reason(metrics)}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </dl>
      </section>

      {/* KPI strip — the stored server figures, rendered verbatim. */}
      <div className="kpis" data-testid="kpi-strip">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="kpi"
            data-testid={/^total revenue$/i.test(k.label) ? "kpi-revenue" : `kpi-${k.label}`}
          >
            <span className="kpi__label">{k.label}</span>
            <span className="kpi__value">{k.value.display}</span>
            {k.sub && <span className="kpi__sub">{k.sub}</span>}
          </div>
        ))}
      </div>

      <section className="projection-tab__cashflow" aria-label="Monthly launch cash-flow">
        <h3 className="projection-tab__heading">Monthly launch cash-flow — Year 1</h3>
        <CashflowChart monthly={monthly} breakevenMonth={breakevenMonth} />
      </section>

      <section className="projection-tab__rows" aria-label="3-year projection">
        <div className="projection-tab__rows-head">
          <h3 className="projection-tab__heading">3-year projection</h3>
          <ul className="table-legend" data-testid="table-legend" aria-label="Cell legend">
            {LEGEND.map((l) => (
              <li key={l.cls} className={`table-legend__item table-legend__item--${l.cls}`}>
                <span className={`swatch swatch--${l.cls}`} aria-hidden="true" />
                {l.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="projection-tab__scroll">
          <table className="three-year-table" data-testid="three-year-table">
            <caption className="sr-only">3-year projection</caption>
            <thead>
              <tr>
                <th scope="col">Line item</th>
                {([1, 2, 3] as const).map((y) => {
                  const share = shareFor(rows, y);
                  return (
                    <th scope="col" key={y} className="num">
                      Year {y}
                      {share && <span className="three-year-table__share">{share} share</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ThreeYearRow key={row.label} row={row} onEditCell={onEditCell} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ThreeYearRow({
  row,
  onEditCell,
}: {
  row: Row;
  onEditCell?: (node: string, year: number) => void;
}) {
  return (
    <tr>
      <th scope="row" className="three-year-table__label">
        {row.label}
      </th>
      {([1, 2, 3] as const).map((year) => (
        <Cell key={year} row={row} year={year} onEditCell={onEditCell} />
      ))}
    </tr>
  );
}

function Cell({
  row,
  year,
  onEditCell,
}: {
  row: Row;
  year: 1 | 2 | 3;
  onEditCell?: (node: string, year: number) => void;
}) {
  const value = row[`y${year}` as "y1" | "y2" | "y3"];
  const display = value ? value.display : "—";
  const cls = `cell cell--${row.class} num`;
  const testid = `cell-${row.label}-y${year}`;
  // Back-compat alias the detail page / e2e read (e.g. row-net_profit-y1).
  const rowTestid = `row-${rowSlug(row.label)}-y${year}`;

  // Editable (input/overridable component) cells are real buttons: keyboard
  // focusable, Enter/Space activatable. Derived/computed cells are read-only and
  // marked aria-disabled (also server-enforced as non-pinnable, PRD §14).
  if (row.editable) {
    const activate = () => onEditCell?.(row.label, year);
    const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    };
    return (
      <td className="cell-wrap">
        <button
          type="button"
          data-testid={testid}
          className={cls}
          onClick={activate}
          onKeyDown={onKey}
          aria-label={`${row.label}, Year ${year}: ${display}`}
        >
          {display}
        </button>
      </td>
    );
  }

  return (
    <td data-testid={testid} data-row-testid={rowTestid} className={cls} aria-disabled="true">
      {/* The slug alias is a hidden sibling so getByTestId(row-...) resolves to a
          node carrying the same aria-disabled state, without two attrs on one el. */}
      <span data-testid={rowTestid} aria-disabled="true" className="sr-only">
        {display}
      </span>
      {display}
    </td>
  );
}

export default ProjectionTab;

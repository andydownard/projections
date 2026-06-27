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
import { FieldChange, type FieldChangeActor } from "./FieldChange";
import { cashGapLabel, isNegative } from "./displayLabels";
import type { ServerValue } from "../api/client";
import type { Milestone, Row, ViewModel } from "../api/viewModel";

/** A recent change on one editable cell (PE7, #126). `previous` is the SERVER's
 *  prior display string (from the changed[] was→now diff / prior revision) —
 *  rendered verbatim, never computed here. Keyed by {@link fieldChangeKey}. */
export interface FieldChangeInfo {
  previous: string;
  by?: FieldChangeActor;
  reverted?: boolean;
}

/** The cell key shared by ProjectionTab and the detail page so the "recent
 *  change / was X / undo" affordance lines up with the cell it describes. Uses the
 *  row's DAG node when present, else its label (the onEditCell identity). */
export function fieldChangeKey(nodeOrLabel: string, year: number): string {
  return `${nodeOrLabel}#${year}`;
}

export interface ProjectionTabProps {
  vm: ViewModel;
  /** Live-region text for an autosave/recompute settle (a11y: recompute announced). */
  recomputeStatus?: string;
  /** Activate an editable (input) driver/override cell — keyboard + click. */
  onEditCell?: (node: string, year: number) => void;
  /** Recent per-field changes keyed by {@link fieldChangeKey} (PE7). */
  fieldChanges?: Record<string, FieldChangeInfo>;
  /** Per-field undo: revert THAT cell to its previous value via a forward PATCH
   *  (the parent issues it → a new revision). Omit to render the change display-only. */
  onUndoField?: (node: string, year: number) => void;
}

/** One decision tile, resolved from the server view-model. `value` is a server
 *  `{raw,display}` (money/month milestone) rendered verbatim — never re-derived. */
interface TileVM {
  testid: string;
  /** Back-compat alias kept for the existing e2e/detail contract. */
  metricTestid: string;
  label: string;
  value: ServerValue | Milestone;
  /** Tappable "Why?" disclosure (downside/confidence detail). */
  why?: string;
  /** Always-visible N/A explanation when the milestone is unreached (raw == null);
   *  never a bare, misleading "N/A" or a phantom 0 (#117). */
  naReason?: string;
  /** Apply the #148 negative color cue by the SIGN of server raw (money tiles). */
  negativeAware?: boolean;
}

/** Build the decision tiles from the view-model. Break-even and Payback are DISTINCT
 *  milestones and are never conflated (#193): Break-even is the operating-profit
 *  crossing; Payback (the recovered-investment month) is its own tile sourced from
 *  `milestones.payback`, mirroring the DecisionBanner. The cash-trough tile is
 *  sign-aware (#194) — a positive trough is a cushion, not a "gap". */
function buildTiles(vm: ViewModel): TileVM[] {
  const { metrics, milestones } = vm;
  const tiles: TileVM[] = [
    {
      testid: "tile-capital",
      metricTestid: "metric-capital",
      label: "Startup capital required",
      value: metrics.capital,
      why: metrics.reasonCapital,
      negativeAware: true,
    },
    {
      testid: "tile-breakeven",
      metricTestid: "metric-breakeven",
      label: "Break-even",
      // Prefer the milestone (carries its N/A-with-reason) when present; else the
      // legacy break-even MONTH metric. Either way this is break-even only.
      value: milestones ? milestones.breakEven : metrics.breakeven,
      why: metrics.reasonBreakeven,
      naReason: milestones?.breakEven.reason,
    },
  ];

  // Payback is a separate milestone (#193) — only when the server emits milestones.
  if (milestones) {
    tiles.push({
      testid: "tile-payback",
      metricTestid: "metric-payback",
      label: "Payback",
      value: milestones.payback,
      naReason: milestones.payback.reason,
    });
  }

  tiles.push({
    testid: "tile-cashgap",
    metricTestid: "metric-cashgap",
    label: cashGapLabel(metrics.cashGap),
    value: metrics.cashGap,
    why: metrics.reasonGap,
    negativeAware: true,
  });

  return tiles;
}

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

export function ProjectionTab({
  vm,
  recomputeStatus = "",
  onEditCell,
  fieldChanges,
  onUndoField,
}: ProjectionTabProps) {
  const { reco, kpis, monthly, breakevenMonth, rows } = vm;
  const tiles = buildTiles(vm);

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
          {tiles.map((t) => {
            // An unreached milestone (raw == null) is N/A — show its reason inline,
            // never a bare "N/A" or a misleading 0 (#117). data-negative is by SIGN.
            const isNa = t.value.raw == null;
            const negative =
              t.negativeAware && isNegative(t.value as ServerValue) ? "true" : undefined;
            return (
              <div
                key={t.testid}
                className="decision-tile metric"
                data-testid={t.testid}
                data-metric={t.metricTestid}
              >
                {/* Back-compat hook: the existing detail/e2e contract reads
                    metric-capital / metric-breakeven / metric-payback / metric-cashgap.
                    The tile IS that metric, enriched with its downside/confidence reason. */}
                <span data-testid={t.metricTestid} className="sr-only">
                  {t.value.display}
                </span>
                <dt className="decision-tile__label">{t.label}</dt>
                {/* #148: a loss (server raw < 0) gets the error color, PAIRED with
                    the server's parentheses (the non-color cue) — never color alone. */}
                <dd className="decision-tile__value num" data-negative={negative}>
                  {t.value.display}
                </dd>
                {/* Explicit N/A-with-reason (never a misleading 0) — always visible. */}
                {isNa && t.naReason && <p className="metric__reason">{t.naReason}</p>}
                {t.why && (
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
                    {/* Kept in the DOM (so aria-controls always resolves) but hidden
                        from view + a11y tree until expanded. */}
                    <p
                      className="decision-tile__reason"
                      id={`${t.testid}-reason`}
                      role="note"
                      hidden={!openReasons.has(t.testid)}
                    >
                      {t.why}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
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
            <span className="kpi__value" data-negative={isNegative(k.value) ? "true" : undefined}>
              {k.value.display}
            </span>
            {k.sub && <span className="kpi__sub">{k.sub}</span>}
          </div>
        ))}
      </div>

      <section className="projection-tab__cashflow" aria-label="Monthly launch cash-flow">
        <h3 className="projection-tab__heading">Monthly launch cash-flow — Year 1</h3>
        <CashflowChart monthly={monthly} breakevenMonth={breakevenMonth} milestones={vm.milestones} />
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
                <ThreeYearRow
                  key={row.label}
                  row={row}
                  onEditCell={onEditCell}
                  fieldChanges={fieldChanges}
                  onUndoField={onUndoField}
                />
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
  fieldChanges,
  onUndoField,
}: {
  row: Row;
  onEditCell?: (node: string, year: number) => void;
  fieldChanges?: Record<string, FieldChangeInfo>;
  onUndoField?: (node: string, year: number) => void;
}) {
  return (
    <tr>
      <th scope="row" className="three-year-table__label">
        {row.label}
      </th>
      {([1, 2, 3] as const).map((year) => (
        <Cell
          key={year}
          row={row}
          year={year}
          onEditCell={onEditCell}
          fieldChanges={fieldChanges}
          onUndoField={onUndoField}
        />
      ))}
    </tr>
  );
}

function Cell({
  row,
  year,
  onEditCell,
  fieldChanges,
  onUndoField,
}: {
  row: Row;
  year: 1 | 2 | 3;
  onEditCell?: (node: string, year: number) => void;
  fieldChanges?: Record<string, FieldChangeInfo>;
  onUndoField?: (node: string, year: number) => void;
}) {
  const value = row[`y${year}` as "y1" | "y2" | "y3"];
  const display = value ? value.display : "—";
  const cls = `cell cell--${row.class} num`;
  // #148: flag losses (server raw < 0) for the error-color cue, kept PAIRED with
  // the server's parentheses so meaning is never carried by color alone.
  const negative = isNegative(value) ? "true" : undefined;
  const testid = `cell-${row.label}-y${year}`;
  // Back-compat alias the detail page / e2e read (e.g. row-net_profit-y1).
  const rowTestid = `row-${rowSlug(row.label)}-y${year}`;

  // PE7: a recent change on this editable cell (Penny or manual). The cell's own
  // value stays prominent (the button); FieldChange adds the badge + subtle "was X"
  // + per-field undo. The node identity matches onEditCell (row.node ?? row.label).
  const nodeId = row.node ?? row.label;
  const change = row.editable ? fieldChanges?.[fieldChangeKey(nodeId, year)] : undefined;

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
      <td className="cell-wrap" data-changed={change ? "true" : undefined}>
        <button
          type="button"
          data-testid={testid}
          className={cls}
          data-negative={negative}
          // Recent-change prominence (not color alone — the FieldChange badge
          // carries icon + text). Inline so it never collides with tokens.css.
          style={change ? { fontWeight: 700, outline: "2px solid #35644f", outlineOffset: 1 } : undefined}
          onClick={activate}
          onKeyDown={onKey}
          aria-label={`${row.label}, Year ${year}: ${display}`}
        >
          {display}
        </button>
        {change && (
          <FieldChange
            label={`${row.label}, Year ${year}`}
            current={display}
            previous={change.previous}
            by={change.by}
            reverted={change.reverted}
            showCurrent={false}
            onUndo={onUndoField ? () => onUndoField(nodeId, year) : undefined}
          />
        )}
      </td>
    );
  }

  return (
    <td
      data-testid={testid}
      data-row-testid={rowTestid}
      className={cls}
      data-negative={negative}
      aria-disabled="true"
    >
      {/* The slug alias is a hidden sibling so getByTestId(row-...) resolves to a
          node carrying the same aria-disabled state, without two attrs on one el. */}
      <span data-testid={rowTestid} aria-disabled="true" className="sr-only">
        {display}
      </span>
      {display}
    </td>
  );
}

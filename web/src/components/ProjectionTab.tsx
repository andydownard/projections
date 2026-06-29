// web/src/components/ProjectionTab.tsx — the Projection panel of the owner detail
// page (Epic G, #39/#40).
//
// Renders the Appendix-D view-model VERBATIM (PRD §13, CLAUDE.md hard rule). Epic G
// reflows the OWNER detail page and de-duplicates the decision:
//   - NO verdict block. The reco chip / headline / sub (and the "raise cash" /
//     "Why?" reasons) are SUPPRESSED on the owner detail page — the verdict survives
//     only as the high-level tiles here, and travels verbatim on /r/<slug> + the
//     Board Packet (reco{tag,headline,sub} stays in computed_json). (#39/#40)
//   - 3 high-level tiles ONLY: Startup capital (label drops "required"), Break-even,
//     Payback. The first-year cash-gap tile is HIDDEN (metrics.cashGap stays in
//     computed_json). (#39)
//   - vertical order: 3-year table (TOP) → high-level tiles → first-year cash-flow
//     detail (chart + monthly table). (#40)
//   - the 3-year table with an Input/Computed/Overridden/Estimated legend and a
//     per-cell state class taken from the SERVER `row.class` (the client never
//     classifies a cell).
//
// The "2nd tile set" (server kpis[]) moved OUT to KpiStrip (the KPIs tab). NO client
// math: every figure is the server's { display } string.
import { useRef, useState, type KeyboardEvent } from "react";

import { CashflowChart } from "./CashflowChart";
import { FieldChange, type FieldChangeActor } from "./FieldChange";
import { isNegative } from "./displayLabels";
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
  /** Commit a new value for an editable (input/override) cell — fired when the
   *  inline editor the cell opens on activation (click / Enter / Space) settles.
   *  `node` is the DAG node identity (`row.node ?? row.label`) the override
   *  contract keys on; `value` is the raw string the owner typed. Omit to render
   *  the editable cells read-only (no inline editor mounts). */
  onEditCell?: (node: string, year: number, value: string) => void;
  /** Recent per-field changes keyed by {@link fieldChangeKey} (PE7). */
  fieldChanges?: Record<string, FieldChangeInfo>;
  /** Per-field undo: revert THAT cell to its previous value via a forward PATCH
   *  (the parent issues it → a new revision). Omit to render the change display-only. */
  onUndoField?: (node: string, year: number) => void;
}

/** One high-level decision tile, resolved from the server view-model. `value` is a
 *  server `{raw,display}` (money/month milestone) rendered verbatim — never
 *  re-derived. The downside/confidence "Why?" reason is SUPPRESSED on the owner
 *  detail page (#40) — only the explicit N/A-with-reason for an unreached milestone
 *  survives (#117). */
interface TileVM {
  testid: string;
  /** Back-compat alias kept for the existing e2e/detail contract. */
  metricTestid: string;
  label: string;
  value: ServerValue | Milestone;
  /** Always-visible N/A explanation when the milestone is unreached (raw == null);
   *  never a bare, misleading "N/A" or a phantom 0 (#117). */
  naReason?: string;
  /** Apply the #148 negative color cue by the SIGN of server raw (money tiles). */
  negativeAware?: boolean;
}

/** Build the 3 high-level decision tiles from the view-model (Epic G #39). The
 *  first-year cash-gap tile is intentionally OMITTED — metrics.cashGap stays in
 *  computed_json (packet / role view / narrative) but is not a tile here. Break-even
 *  and Payback are DISTINCT milestones and are never conflated (#193). */
function buildTiles(vm: ViewModel): TileVM[] {
  const { metrics, milestones } = vm;
  const tiles: TileVM[] = [
    {
      testid: "tile-capital",
      metricTestid: "metric-capital",
      // #39: drop "required" — the tile reads "Startup capital".
      label: "Startup capital",
      value: metrics.capital,
      negativeAware: true,
    },
    {
      testid: "tile-breakeven",
      metricTestid: "metric-breakeven",
      label: "Break-even",
      // Prefer the milestone (carries its N/A-with-reason) when present; else the
      // legacy break-even MONTH metric. Either way this is break-even only.
      value: milestones ? milestones.breakEven : metrics.breakeven,
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
  const { monthly, breakevenMonth, rows } = vm;
  const tiles = buildTiles(vm);

  const tilesStrip = (
    // The high-level decision tiles. The `decision-banner` testid is preserved (the
    // detail/e2e contract reads it), but the verdict chip/headline/sub are GONE —
    // the decision is no longer repeated on the owner detail page (#39/#40).
    <section
      className="decision-banner decision-banner--tiles-only"
      data-testid="decision-banner"
      aria-label="Key decision metrics"
    >
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
                  metric-capital / metric-breakeven / metric-payback. */}
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
            </div>
          );
        })}
      </dl>
    </section>
  );

  return (
    <div className="projection-tab" data-testid="projection-tab">
      {/* Recompute / autosave live-region — a settle is announced to SR users. */}
      <span data-testid="recompute-status" role="status" aria-live="polite" className="sr-status">
        {recomputeStatus}
      </span>

      {/* (1) 3-year projection — moved to the TOP (#40). */}
      <section className="projection-tab__rows" aria-label="3-year projection">
        <div className="projection-tab__rows-head">
          <h2 className="projection-tab__heading">3-year projection</h2>
          <ul className="table-legend" data-testid="table-legend" aria-label="Cell legend">
            {LEGEND.map((l) => (
              <li key={l.cls} className={`table-legend__item table-legend__item--${l.cls}`}>
                <span className={`swatch swatch--${l.cls}`} aria-hidden="true" />
                {l.label}
              </li>
            ))}
          </ul>
        </div>

        {/* A relative wrap so a right-edge scroll-hint fade can pin to the scroll
            viewport on narrow screens where Year 2/3 don't fit — paired with sticky
            row labels so the horizontal scroll reads clearly, not "clipped" (QA P2). */}
        <div className="projection-tab__scroll-wrap">
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
        </div>
      </section>

      {/* (2) High-level decision tiles — below the 3-year summary (#40). */}
      {tilesStrip}

      {/* (3) First-year cash-flow detail — below the 3-year (#40). The chart's
          months align to the monthly table's columns (see CashflowChart). */}
      <section className="projection-tab__cashflow" aria-label="First-year cash flow">
        <h2 className="projection-tab__heading">First-year cash flow</h2>
        <CashflowChart monthly={monthly} breakevenMonth={breakevenMonth} milestones={vm.milestones} />
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
  onEditCell?: (node: string, year: number, value: string) => void;
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
  onEditCell?: (node: string, year: number, value: string) => void;
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
    // Activating the cell opens an inline editor so the owner can change the value
    // right in the table (the #284-regression fix: the cell button used to be a
    // dead no-op). Commit pins the typed value through the host's override contract
    // (onEditCell → PATCH overrides.set / inputs); a §12.2 guardrail then slides
    // Penny out for the note. The editor only mounts when a commit seam is wired.
    const editable = !!onEditCell;
    return (
      <EditableCell
        nodeId={nodeId}
        label={row.label}
        year={year}
        display={display}
        raw={value ? value.raw : 0}
        cls={cls}
        testid={testid}
        negative={negative}
        change={change}
        canEdit={editable}
        onEditCell={onEditCell}
        onUndoField={onUndoField}
      />
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

// An editable component/driver cell: a keyboard-focusable button that, on activation
// (click / Enter / Space), swaps to an inline editor so the owner can change the value
// in place. Committing (Enter or blur) raises onEditCell with the DAG node identity +
// the typed value; the host PATCHes it through the EXISTING override contract and a
// §12.2 guardrail then slides Penny out for the note. Escape cancels. With no
// onEditCell wired the cell stays a focusable button whose activation is a no-op
// (read-only), so the legacy keyboard-focusable contract holds either way. Extracted
// from Cell so the edit-state hooks are unconditional (Rules of Hooks).
function EditableCell({
  nodeId,
  label,
  year,
  display,
  raw,
  cls,
  testid,
  negative,
  change,
  canEdit,
  onEditCell,
  onUndoField,
}: {
  nodeId: string;
  label: string;
  year: 1 | 2 | 3;
  display: string;
  raw: number;
  cls: string;
  testid: string;
  negative?: "true";
  change?: FieldChangeInfo;
  canEdit: boolean;
  onEditCell?: (node: string, year: number, value: string) => void;
  onUndoField?: (node: string, year: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Guards a single edit session so an Enter-commit immediately followed by the
  // input's unmount blur never fires the override PATCH twice.
  const openRef = useRef(false);

  const start = () => {
    if (!canEdit) return;
    openRef.current = true;
    setEditing(true);
  };
  const cancel = () => {
    openRef.current = false;
    setEditing(false);
  };
  const commit = (next: string) => {
    if (!openRef.current) return;
    openRef.current = false;
    setEditing(false);
    const trimmed = next.trim();
    // Only pin when the owner actually changed the value (never a no-op override).
    if (trimmed !== "" && trimmed !== String(raw)) onEditCell?.(nodeId, year, trimmed);
  };

  if (editing) {
    return (
      <td className="cell-wrap">
        <input
          data-testid={`${testid}-input`}
          className={cls}
          defaultValue={String(raw)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          inputMode="decimal"
          aria-label={`${label}, Year ${year} value`}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      </td>
    );
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      start();
    }
  };
  return (
    <td className="cell-wrap" data-changed={change ? "true" : undefined}>
      <button
        type="button"
        data-testid={testid}
        className={cls}
        data-negative={negative}
        // Recent-change prominence (not color alone — the FieldChange badge carries
        // icon + text). Inline so it never collides with tokens.css.
        style={change ? { fontWeight: 700, outline: "2px solid #35644f", outlineOffset: 1 } : undefined}
        onClick={start}
        onKeyDown={onKey}
        aria-label={`${label}, Year ${year}: ${display}`}
      >
        {display}
      </button>
      {change && (
        <FieldChange
          label={`${label}, Year ${year}`}
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

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
import { presentYears, type Row, type YearKey, type ViewModel } from "../api/viewModel";

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
  /** I4 (#322): clear a pin straight from the cell (PATCH overrides.clear → recompute
   *  → new revision). When wired, an overridden cell shows a small "reset to calculated"
   *  affordance so a pin can be cleared without the (flag-gated) override audit UI. */
  onResetCell?: (node: string, year: number) => void;
}

const LEGEND: Array<{ cls: string; label: string }> = [
  { cls: "input", label: "Input" },
  { cls: "computed", label: "Computed" },
  { cls: "overridden", label: "Overridden" },
  { cls: "estimated", label: "Estimated" },
];

/** Stable, slugified node id for a row (e.g. "Net income" -> "net_income").
 *  Used for the back-compat `row-<slug>-y<year>` testid the detail/e2e read. */
function rowSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function ProjectionTab({
  vm,
  recomputeStatus = "",
  onEditCell,
  fieldChanges,
  onUndoField,
  onResetCell,
}: ProjectionTabProps) {
  const { monthly, breakevenMonth, rows } = vm;

  // Year-count-agnostic: a stored 3-year snapshot carries only y1..y3; a 2.6.0
  // snapshot carries y1..y5. Derive the columns to render from the rows so the
  // SAME table renders 3 or 5 years with no recompute (Decision 5 / E1).
  const years = presentYears(rows);
  const horizonLabel = `${years.length}-year projection`;

  // I2 (#322): the orange "overridden" highlight is derived CLIENT-SIDE from
  // vm.overrides per (node,year) — a pure presentational set lookup, no viewmodel
  // change. Keying on "{node}#{year}" means only the pinned cell lights up, never
  // the whole row (the server marks the WHOLE row class "overridden" when any year
  // is pinned; we narrow it here so the orange doesn't bleed across the row).
  const overrideKeys = new Set(
    (vm.overrides ?? []).map((o) => fieldChangeKey(o.node, o.year)),
  );

  return (
    <div className="projection-tab" data-testid="projection-tab">
      {/* Recompute / autosave live-region — a settle is announced to SR users. */}
      <span data-testid="recompute-status" role="status" aria-live="polite" className="sr-status">
        {recomputeStatus}
      </span>

      {/* The annual projection — Year 1 … Year N (N = 3 or 5). */}
      <section className="projection-tab__rows" aria-label={horizonLabel}>
        <div className="projection-tab__rows-head">
          <h2 className="projection-tab__heading">{horizonLabel}</h2>
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
            viewport on narrow screens where later years don't fit — paired with
            sticky row labels so the horizontal scroll reads clearly (QA P2). */}
        <div className="projection-tab__scroll-wrap">
          <div className="projection-tab__scroll">
            <table className="three-year-table" data-testid="three-year-table">
              <caption className="sr-only">{horizonLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Line item</th>
                {/* D7: the "% share" sub-label under each year header is REMOVED. */}
                {years.map((y) => (
                  <th scope="col" key={y} className="num">
                    Year {y}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ThreeYearRow
                  key={row.label}
                  row={row}
                  years={years}
                  onEditCell={onEditCell}
                  fieldChanges={fieldChanges}
                  onUndoField={onUndoField}
                  onResetCell={onResetCell}
                  overrideKeys={overrideKeys}
                />
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </section>

      {/* First-year cash-flow detail. The chart's months align to the monthly
          table's columns (see CashflowChart). */}
      <section className="projection-tab__cashflow" aria-label="First-year cash flow">
        <h2 className="projection-tab__heading">First-year cash flow</h2>
        <CashflowChart monthly={monthly} breakevenMonth={breakevenMonth} milestones={vm.milestones} />
      </section>
    </div>
  );
}

function ThreeYearRow({
  row,
  years,
  onEditCell,
  fieldChanges,
  onUndoField,
  onResetCell,
  overrideKeys,
}: {
  row: Row;
  years: number[];
  onEditCell?: (node: string, year: number, value: string) => void;
  fieldChanges?: Record<string, FieldChangeInfo>;
  onUndoField?: (node: string, year: number) => void;
  onResetCell?: (node: string, year: number) => void;
  overrideKeys: Set<string>;
}) {
  return (
    <tr>
      <th scope="row" className="three-year-table__label">
        {row.label}
      </th>
      {years.map((year) => (
        <Cell
          key={year}
          row={row}
          year={year}
          onEditCell={onEditCell}
          fieldChanges={fieldChanges}
          onUndoField={onUndoField}
          onResetCell={onResetCell}
          overrideKeys={overrideKeys}
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
  onResetCell,
  overrideKeys,
}: {
  row: Row;
  year: number;
  onEditCell?: (node: string, year: number, value: string) => void;
  fieldChanges?: Record<string, FieldChangeInfo>;
  onUndoField?: (node: string, year: number) => void;
  onResetCell?: (node: string, year: number) => void;
  overrideKeys: Set<string>;
}) {
  const value = row[`y${year}` as YearKey];
  const display = value ? value.display : "—";
  // PE7: the node identity matches onEditCell (row.node ?? row.label).
  const nodeId = row.node ?? row.label;
  // I2 (#322): the orange "overridden" highlight is per (node,year) from vm.overrides,
  // NOT the row-level server class — so it never bleeds across the whole row. A cell
  // the server marked row-level "overridden" but that is NOT the pinned (node,year)
  // falls back to its natural pinnable "input" class (a pin only ever lands on a
  // pinnable component cell, whose un-pinned class is "input").
  const isOverridden = overrideKeys.has(fieldChangeKey(nodeId, year));
  const effClass = isOverridden
    ? "overridden"
    : row.class === "overridden"
      ? "input"
      : row.class;
  const cls = `cell cell--${effClass} num`;
  // #148: flag losses (server raw < 0) for the error-color cue, kept PAIRED with
  // the server's parentheses so meaning is never carried by color alone.
  const negative = isNegative(value) ? "true" : undefined;
  const testid = `cell-${row.label}-y${year}`;
  // Back-compat alias the detail page / e2e read (e.g. row-net_income-y1).
  const rowTestid = `row-${rowSlug(row.label)}-y${year}`;

  // PE7: a recent change on this editable cell (Penny or manual). The cell's own
  // value stays prominent (the button); FieldChange adds the badge + subtle "was X"
  // + per-field undo.
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
        isOverridden={isOverridden}
        onEditCell={onEditCell}
        onUndoField={onUndoField}
        onResetCell={onResetCell}
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
  isOverridden,
  onEditCell,
  onUndoField,
  onResetCell,
}: {
  nodeId: string;
  label: string;
  year: number;
  display: string;
  raw: number;
  cls: string;
  testid: string;
  negative?: "true";
  change?: FieldChangeInfo;
  canEdit: boolean;
  isOverridden: boolean;
  onEditCell?: (node: string, year: number, value: string) => void;
  onUndoField?: (node: string, year: number) => void;
  onResetCell?: (node: string, year: number) => void;
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
      {/* D6: the hand cursor + hover edit-icon appear ONLY when the cell is actually
          editable (`cell--editable`); a read-only editable-typed cell (no commit seam)
          stays a focusable button but gets cursor:default + aria-disabled so it never
          looks clickable when it can't be (the dead-hand bug). */}
      <button
        type="button"
        data-testid={testid}
        className={canEdit ? `${cls} cell--editable` : cls}
        data-negative={negative}
        aria-disabled={canEdit ? undefined : "true"}
        // Recent-change prominence (not color alone — the FieldChange badge carries
        // icon + text). Inline so it never collides with tokens.css.
        style={change ? { fontWeight: 700, outline: "2px solid #35644f", outlineOffset: 1 } : undefined}
        onClick={start}
        onKeyDown={onKey}
        aria-label={`${label}, Year ${year}: ${display}`}
      >
        {display}
      </button>
      {/* I4 (#322): a small inline "reset to calculated" on an OVERRIDDEN cell clears
          the pin without the (flag-gated) override audit UI. Shown only when the host
          wires onResetCell (edit mode). A sibling button (never nested in the cell
          button), so a click resets without opening the inline editor. */}
      {isOverridden && onResetCell && (
        <button
          type="button"
          className="cell-reset"
          data-testid={`cell-reset-${nodeId}-y${year}`}
          aria-label={`Reset ${label}, Year ${year} to the calculated value`}
          title="Reset to calculated"
          onClick={() => onResetCell(nodeId, year)}
        >
          <span aria-hidden="true">↺</span>
        </button>
      )}
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

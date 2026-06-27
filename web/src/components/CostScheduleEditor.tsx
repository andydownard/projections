// web/src/components/CostScheduleEditor.tsx — wave-3 timed cost-schedule editor.
//
// The interactive editor for wizard step 4 (Spec §5): an opening anchor (target
// opening date + opening month #) plus rows of { category, month >= 1, amount }
// with add/remove. It only COLLECTS rows and renders any server-formatted
// totals/display strings — it does NOT compute totals or derived numbers
// (PRD §13 / CLAUDE.md hard rule: server is the math + formatting authority).
// Inline validation mirrors the server contract (month >= 1, amount >= 0,
// opening_month# >= 1) purely for UX; the server remains authoritative.
//
// PE7 (#126): each row field renders the shared FieldChange affordance when Penny
// (or a manual edit) recently moved it — a "changed by Penny" badge (icon + text),
// a subtle "was X", and a per-field undo. `previous` is the SERVER's prior display
// string, rendered verbatim — the editor never computes a number.
import { FieldChange, type FieldChangeActor } from "./FieldChange";
import type { CostScheduleRow } from "../wizard/shareHelper";

/** A server-emitted formatted value: the raw never drives client math; only the
 * display string is rendered (so the editor can surface server totals as-is). */
export interface FormattedValue {
  raw: number;
  display: string;
}

/** One server-formatted total/summary line to render verbatim (optional). */
export interface CostScheduleTotal {
  label: string;
  value: FormattedValue;
}

/** The editable fields a recent change can land on (keys the {@link changeKey}). */
export type CostScheduleField = "category" | "month" | "amount";

/** A recent change on one cost-row field (PE7). `previous` is the SERVER's prior
 *  display string ("was $45,000"), rendered verbatim. */
export interface CostFieldChange {
  previous: string;
  by?: FieldChangeActor;
  reverted?: boolean;
}

/** Key a recent change to a row field: `"<rowIndex>:<field>"`. */
export function changeKey(index: number, field: CostScheduleField): string {
  return `${index}:${field}`;
}

export interface CostScheduleEditorProps {
  rows: CostScheduleRow[];
  openingMonthNumber: number;
  targetOpeningDate: string;
  onAddRow: () => void;
  onUpdateRow: (index: number, patch: Partial<CostScheduleRow>) => void;
  onRemoveRow: (index: number) => void;
  onChangeOpeningMonth: (value: number) => void;
  onChangeTargetDate: (value: string) => void;
  /** Server-formatted totals (optional). Rendered verbatim — never computed
   * client-side. Absent until the server compute runs. */
  totals?: CostScheduleTotal[];
  /** Recent per-field changes keyed by {@link changeKey} (PE7). */
  changes?: Record<string, CostFieldChange>;
  /** Per-field undo: revert THAT row field to its previous value via a forward
   *  PATCH (the parent issues it → a new revision). Omit → display-only. */
  onUndoChange?: (index: number, field: CostScheduleField) => void;
}

/** Inline-only validation mirroring the server contract (no math, just gating
 * hints). The server stays authoritative. */
function isValidMonth(month: number): boolean {
  return Number.isFinite(month) && Number.isInteger(month) && month >= 1;
}

function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

export function CostScheduleEditor({
  rows,
  openingMonthNumber,
  targetOpeningDate,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
  onChangeOpeningMonth,
  onChangeTargetDate,
  totals,
  changes,
  onUndoChange,
}: CostScheduleEditorProps) {
  const openingInvalid = !isValidMonth(openingMonthNumber);

  /** Render the recent-change affordance for one row field, if it changed. The
   *  input above already shows the value (showCurrent=false). */
  function renderChange(index: number, field: CostScheduleField, current: string) {
    const change = changes?.[changeKey(index, field)];
    if (!change) return null;
    return (
      <FieldChange
        label={`Cost row ${index + 1} ${field}`}
        current={current}
        previous={change.previous}
        by={change.by}
        reverted={change.reverted}
        showCurrent={false}
        onUndo={onUndoChange ? () => onUndoChange(index, field) : undefined}
      />
    );
  }

  return (
    <div data-testid="cost-schedule-editor">
      <fieldset className="wizard__cost-schedule">
        <legend>Opening anchor</legend>
        <p className="wizard__helper">
          Months 1 through (opening month − 1) are pre-opening. Place each cost on
          the project month it lands — before or after opening.
        </p>

        <label className="wizard__field">
          Target opening date
          <input
            type="month"
            data-testid="opening-date"
            value={targetOpeningDate}
            onChange={(e) => onChangeTargetDate(e.target.value)}
          />
        </label>

        <label className="wizard__field">
          Grand-opening month #
          <input
            type="number"
            min={1}
            step={1}
            data-testid="opening-month"
            aria-invalid={openingInvalid || undefined}
            aria-describedby={openingInvalid ? "opening-month-error" : undefined}
            value={Number.isFinite(openingMonthNumber) ? openingMonthNumber : ""}
            onChange={(e) => onChangeOpeningMonth(Number(e.target.value))}
          />
        </label>
        {openingInvalid && (
          <p
            id="opening-month-error"
            role="alert"
            className="wizard__note"
            data-testid="opening-month-error"
          >
            Opening month must be 1 or greater.
          </p>
        )}
      </fieldset>

      <fieldset className="wizard__cost-schedule">
        <legend>Timed startup costs</legend>
        {rows.length === 0 ? (
          <p className="list-empty" data-testid="cost-schedule-empty">
            No cost rows yet. Add a row to schedule a startup cost.
          </p>
        ) : (
          <ul className="wizard__cost-rows">
            {rows.map((row, i) => {
              const monthInvalid = !isValidMonth(row.month);
              const amountInvalid = !isValidAmount(row.amount);
              return (
                <li key={i} className="wizard__cost-row" data-testid="cost-row">
                  <label className="wizard__field">
                    Category
                    <input
                      type="text"
                      aria-label={`Cost row ${i + 1} category`}
                      value={row.category}
                      onChange={(e) => onUpdateRow(i, { category: e.target.value })}
                    />
                    {renderChange(i, "category", row.category)}
                  </label>
                  <label className="wizard__field">
                    Month #
                    <input
                      type="number"
                      min={1}
                      step={1}
                      aria-label={`Cost row ${i + 1} month`}
                      aria-invalid={monthInvalid || undefined}
                      value={Number.isFinite(row.month) ? row.month : ""}
                      onChange={(e) => onUpdateRow(i, { month: Number(e.target.value) })}
                    />
                    {renderChange(i, "month", String(row.month))}
                  </label>
                  <label className="wizard__field">
                    Amount ($)
                    <input
                      type="number"
                      min={0}
                      aria-label={`Cost row ${i + 1} amount`}
                      aria-invalid={amountInvalid || undefined}
                      value={Number.isFinite(row.amount) ? row.amount : ""}
                      onChange={(e) => onUpdateRow(i, { amount: Number(e.target.value) })}
                    />
                    {renderChange(i, "amount", String(row.amount))}
                  </label>
                  {(monthInvalid || amountInvalid) && (
                    <p role="alert" className="wizard__note" data-testid="cost-row-error">
                      {monthInvalid
                        ? "Month must be 1 or greater."
                        : "Amount must be 0 or greater."}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-label={`Remove cost row ${i + 1}`}
                    onClick={() => onRemoveRow(i)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" className="btn" onClick={onAddRow} data-testid="add-cost-row">
          Add cost row
        </button>
      </fieldset>

      {totals && totals.length > 0 && (
        <dl className="wizard__summary" data-testid="cost-schedule-totals">
          {totals.map((total) => (
            <div key={total.label}>
              <dt>{total.label}</dt>
              {/* Server-formatted display string rendered verbatim — no client math. */}
              <dd data-testid={`cost-schedule-total-${total.label}`}>{total.value.display}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export default CostScheduleEditor;

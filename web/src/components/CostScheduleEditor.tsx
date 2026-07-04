// web/src/components/CostScheduleEditor.tsx — the startup-costs ROWS × MONTHS grid.
//
// Decision #31 (Epic D, #263): line-items are ROWS, project months 1–12 are COLUMNS,
// with a TOTAL column on the right and a totals row beneath. The persisted schema
// stays the flat `{category, month, amount}` array — this editor is a FRONTEND PIVOT
// (web/src/wizard/costMatrix.ts), so multiple month-entries for one category collapse
// onto a single grid row and every edit maps back to a new flat array (no engine /
// schema / migration change). It only COLLECTS rows and RENDERS the server's totals.
//
// NO-CLIENT-MATH (PRD §13 / CLAUDE.md hard rule): the row / column / grand totals come
// from POST /api/cost-schedule/preview as `{raw, display}` (decision #15) and are
// rendered verbatim — the client never sums.
//
// #33: an "Add row" control + a trash-can ICON per row (not a text button).
// #34: one month column is the grand-opening column (faint brand wash); pre-opening
// months are styled subtly; a draggable handle labelled "grand opening" sets the
// opening month on drop over a column, with an arrow-key equivalent (WCAG) on the
// handle exposed as an accessible slider.
import type { KeyboardEvent } from "react";

import type { CostSchedulePreview } from "../api/costSchedule";
import { NumberField } from "./NumberField";
import {
  addCategoryRow,
  DEFAULT_MONTH_COUNT,
  pivotToMatrix,
  removeCategory,
  renameCategory,
  setCellAmount,
} from "../wizard/costMatrix";
import type { CostScheduleRow } from "../wizard/shareHelper";

const TOTAL_PLACEHOLDER = "—";

export interface CostScheduleEditorProps {
  /** The flat, persisted cost schedule (unchanged schema). */
  rows: CostScheduleRow[];
  /** The grand-opening project month (the highlighted, draggable column). */
  openingMonthNumber: number;
  /** Number of month columns (default 12). */
  monthCount?: number;
  /** Server-computed `{raw, display}` totals (decision #15). Null until the preview
   *  responds — totals are presentation, never a gate, so the grid renders without. */
  totals?: CostSchedulePreview | null;
  /** Emit the next flat array after any cell / category / row edit. */
  onChangeRows: (rows: CostScheduleRow[]) => void;
  /** Set the grand-opening month (drag drop or keyboard on the handle). */
  onChangeOpeningMonth: (month: number) => void;
}

/** A small inline trash-can glyph (decoration only; the button carries the label). */
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6 2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V3h3a.5.5 0 0 1 0 1h-.54l-.7 8.36A1.5 1.5 0 0 1 10.27 14H5.73a1.5 1.5 0 0 1-1.49-1.64L3.54 4H3a.5.5 0 0 1 0-1h3v-.5ZM5 4l.69 8.28a.5.5 0 0 0 .5.46h3.62a.5.5 0 0 0 .5-.46L11 4H5Zm2 1.5a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5Zm-1.5 0a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm4 0a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Z"
      />
    </svg>
  );
}

export function CostScheduleEditor({
  rows,
  openingMonthNumber,
  monthCount = DEFAULT_MONTH_COUNT,
  totals,
  onChangeRows,
  onChangeOpeningMonth,
}: CostScheduleEditorProps) {
  const opening =
    Number.isFinite(openingMonthNumber) && openingMonthNumber >= 1
      ? Math.min(Math.trunc(openingMonthNumber), monthCount)
      : 1;
  const months = Array.from({ length: monthCount }, (_unused, i) => i + 1);
  const matrix = pivotToMatrix(rows, monthCount);

  // Server totals indexed for O(1) lookup; rendered verbatim (display strings only).
  // Both arrays get the FULL optional chain (`totals?.rowTotals?.map`, not just
  // `totals?.rowTotals.map`): a partial /preview response can arrive with a truthy
  // `totals` object but a missing rowTotals/columnTotals array, and the bare
  // `.map` on `undefined` threw synchronously during render (an intermittent
  // uncaught TypeError under parallel test runs, and a potential prod crash on a
  // partial response) — the grid must degrade to the placeholder, never throw.
  const rowTotalByCategory = new Map(totals?.rowTotals?.map((t) => [t.category, t.total.display]));
  const colTotalByMonth = new Map(totals?.columnTotals?.map((t) => [t.month, t.total.display]));
  const grandDisplay = totals?.grandTotal?.display ?? TOTAL_PLACEHOLDER;

  function columnClass(month: number): string {
    if (month === opening) return "cost-matrix__col--opening";
    if (month < opening) return "cost-matrix__col--pre";
    return "";
  }

  function onCellAmountChange(category: string, month: number, value: number | null) {
    onChangeRows(setCellAmount(rows, category, month, value));
  }

  function onRename(from: string, to: string) {
    onChangeRows(renameCategory(rows, from, to));
  }

  function onAddRow() {
    onChangeRows(addCategoryRow(rows, opening));
  }

  function onRemove(category: string) {
    onChangeRows(removeCategory(rows, category));
  }

  // The grand-opening handle: a slider with an arrow-key equivalent to dragging it
  // across columns (WCAG 2.1.1 — keyboard-operable). Home/End jump to the bounds.
  function onHandleKey(e: KeyboardEvent<HTMLSpanElement>) {
    let next = opening;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = opening + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = opening - 1;
        break;
      case "Home":
        next = 1;
        break;
      case "End":
        next = monthCount;
        break;
      default:
        return;
    }
    e.preventDefault();
    next = Math.min(Math.max(1, next), monthCount);
    if (next !== opening) onChangeOpeningMonth(next);
  }

  const handle = (
    <span
      role="slider"
      tabIndex={0}
      draggable
      data-testid="grand-opening-handle"
      className="cost-matrix__go-handle"
      aria-label="Grand opening month"
      aria-valuemin={1}
      aria-valuemax={monthCount}
      aria-valuenow={opening}
      aria-valuetext={`Month ${opening}`}
      onDragStart={(e) => {
        // The only draggable element is this handle; a drop on any column header means
        // "make that column the grand-opening month" (the drop reads the month, not
        // dataTransfer, so it works without a rich DnD payload).
        e.dataTransfer?.setData("text/plain", "grand-opening");
      }}
      onKeyDown={onHandleKey}
    >
      <span aria-hidden="true" className="cost-matrix__go-grip">
        ⠿
      </span>
      grand opening
    </span>
  );

  return (
    <section className="cost-matrix" aria-labelledby="cost-matrix-heading">
      <div className="cost-matrix__head">
        <h3 id="cost-matrix-heading" className="cost-matrix__title">
          Itemized startup costs
        </h3>
        <p className="cost-matrix__hint" id="cost-matrix-hint">
          Each line-item lands on the project month it’s spent. Drag the{" "}
          <strong>grand opening</strong> marker — or use the arrow keys on it — to set
          which month you open; months before it are pre-opening.
        </p>
      </div>

      <div className="cost-matrix__scroll" role="region" aria-label="Startup costs grid" tabIndex={0}>
        <table className="cost-matrix__table" data-testid="cost-schedule-editor">
          <thead>
            {/* Row 1: grand-opening label above its column */}
            <tr className="cost-matrix__go-row" aria-hidden="true">
              <td /> {/* corner */}
              {months.map((m) => (
                // #320: the FULL column header accepts the drop — this go-row cell
                // (where the handle visibly sits) is a drop target too, so releasing
                // anywhere over the column header sets the grand-opening month. The
                // keyboard equivalent stays on the handle's slider (WCAG), so this
                // aria-hidden, mouse-only target adds no a11y obligation.
                <td
                  key={m}
                  data-testid={`go-col-${m}`}
                  className={`cost-matrix__go-cell ${columnClass(m)}`.trim()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onChangeOpeningMonth(m);
                  }}
                >
                  {m === opening && handle}
                </td>
              ))}
              <td /> {/* total */}
              <td /> {/* remove */}
            </tr>
            {/* Row 2: month labels */}
            <tr>
              <th scope="col" className="cost-matrix__corner">
                Line item
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  scope="col"
                  data-testid={`cost-col-${m}`}
                  className={`cost-matrix__month cost-matrix__month--right ${columnClass(m)}`.trim()}
                  aria-label={
                    m === opening
                      ? `Month ${m} — grand opening`
                      : m < opening
                        ? `Month ${m} — pre-opening`
                        : `Month ${m}`
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onChangeOpeningMonth(m);
                  }}
                >
                  <span className="cost-matrix__month-label">Mo. {m}</span>
                </th>
              ))}
              <th scope="col" className="cost-matrix__total-head">
                Total
              </th>
              <th scope="col" className="cost-matrix__remove-head">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {matrix.length === 0 ? (
              <tr>
                <td colSpan={monthCount + 3} className="cost-matrix__empty" data-testid="cost-schedule-empty">
                  No line-items yet. Add a row to schedule a startup cost.
                </td>
              </tr>
            ) : (
              matrix.map((row, i) => (
                <tr key={i} data-testid="cost-row" className="cost-matrix__row">
                  <th scope="row" className="cost-matrix__rowhead">
                    <input
                      type="text"
                      className="cost-matrix__name"
                      aria-label={`Line item ${i + 1} name`}
                      value={row.category}
                      onChange={(e) => onRename(row.category, e.target.value)}
                    />
                  </th>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.month}
                      className={`cost-matrix__cell ${columnClass(cell.month)}`.trim()}
                    >
                      <NumberField
                        value={cell.amount || null}
                        onChange={(v) => onCellAmountChange(row.category, cell.month, v)}
                        unit="$"
                        unitPosition="prefix"
                        thousands
                        min={0}
                        decimals={2}
                        aria-label={`Line item ${i + 1} month ${cell.month} cost`}
                      />
                    </td>
                  ))}
                  <td
                    className="cost-matrix__row-total"
                    data-testid={`row-total-${i}`}
                  >
                    {rowTotalByCategory.get(row.category) ?? TOTAL_PLACEHOLDER}
                  </td>
                  <td className="cost-matrix__remove-cell">
                    <button
                      type="button"
                      className="cost-matrix__trash"
                      aria-label={`Remove ${row.category || `line item ${i + 1}`}`}
                      onClick={() => onRemove(row.category)}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>

          <tfoot>
            <tr className="cost-matrix__totals">
              <th scope="row" className="cost-matrix__totals-label">
                Total
              </th>
              {months.map((m) => (
                <td
                  key={m}
                  data-testid={`col-total-${m}`}
                  className={`cost-matrix__col-total ${columnClass(m)}`.trim()}
                >
                  {colTotalByMonth.get(m) ?? ""}
                </td>
              ))}
              <td className="cost-matrix__grand" data-testid="cost-grand-total">
                {grandDisplay}
              </td>
              <td className="cost-matrix__remove-cell" />
            </tr>
          </tfoot>
        </table>
      </div>

      <button type="button" className="btn cost-matrix__add" onClick={onAddRow} data-testid="add-cost-row">
        + Add row
      </button>
    </section>
  );
}

export default CostScheduleEditor;

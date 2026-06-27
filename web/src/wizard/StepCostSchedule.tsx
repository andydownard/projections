// web/src/wizard/StepCostSchedule.tsx — wizard step 4: opening anchor + costs.
//
// BASIC anchor inputs (target opening date + opening month #) plus a minimal
// timed cost list (category + month + amount). The rich timed-row editor is
// delivered by the cost-schedule-editor ticket (wave 3), which enhances this
// component; the shared state (useWizardState) is built so it inserts without
// rework. Totals are derived SERVER-side — no client math (PRD §13 / Spec §5).
import type { WizardState } from "./useWizardState";

export function StepCostSchedule({ state }: { state: WizardState }) {
  const rows = state.costSchedule;

  return (
    <section className="wizard-step" aria-labelledby="step-cost-heading">
      <h2 id="step-cost-heading" className="wizard-step__heading">
        Cost schedule
      </h2>
      <p className="wizard-step__lede">
        When does the store open, and what are the timed startup costs? Pre-opening
        months are real months in the projection — place each cost on the project
        month it lands.
      </p>

      <label className="wizard__field">
        Target opening date
        <input
          type="month"
          value={state.draft.targetOpeningDate ?? ""}
          onChange={(e) => state.set("targetOpeningDate", e.target.value)}
        />
      </label>

      <label className="wizard__field">
        Grand-opening month #
        <input
          type="number"
          min={1}
          value={state.draft.openingMonthNumber ?? 1}
          onChange={(e) => state.set("openingMonthNumber", Number(e.target.value))}
        />
      </label>

      <fieldset className="wizard__cost-schedule">
        <legend>Startup cost schedule</legend>
        <ul className="wizard__cost-rows">
          {rows.map((row, i) => (
            <li key={i} className="wizard__cost-row" data-testid="cost-row">
              <label className="wizard__field">
                Category
                <input
                  type="text"
                  value={row.category}
                  onChange={(e) => state.updateCostRow(i, { category: e.target.value })}
                />
              </label>
              <label className="wizard__field">
                Month #
                <input
                  type="number"
                  min={1}
                  value={row.month}
                  onChange={(e) => state.updateCostRow(i, { month: Number(e.target.value) })}
                />
              </label>
              <label className="wizard__field">
                Amount ($)
                <input
                  type="number"
                  min={0}
                  value={row.amount}
                  onChange={(e) => state.updateCostRow(i, { amount: Number(e.target.value) })}
                />
              </label>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label={`Remove cost row ${i + 1}`}
                onClick={() => state.removeCostRow(i)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={() => state.addCostRow()}>
          Add cost row
        </button>
      </fieldset>
    </section>
  );
}

export default StepCostSchedule;

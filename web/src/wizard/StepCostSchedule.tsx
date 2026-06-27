// web/src/wizard/StepCostSchedule.tsx — wizard step 4: opening anchor + costs.
//
// Embeds the wave-3 CostScheduleEditor (timed rows + opening anchor) and feeds
// it from useWizardState. The editor only collects rows; totals are derived
// SERVER-side — no client math (PRD §13 / Spec §5).
import { CostScheduleEditor } from "../components/CostScheduleEditor";
import type { WizardState } from "./useWizardState";

export function StepCostSchedule({ state }: { state: WizardState }) {
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

      <CostScheduleEditor
        rows={state.costSchedule}
        openingMonthNumber={state.draft.openingMonthNumber ?? 1}
        targetOpeningDate={state.draft.targetOpeningDate ?? ""}
        onAddRow={state.addCostRow}
        onUpdateRow={state.updateCostRow}
        onRemoveRow={state.removeCostRow}
        onChangeOpeningMonth={(v) => state.set("openingMonthNumber", v)}
        onChangeTargetDate={(v) => state.set("targetOpeningDate", v)}
      />
    </section>
  );
}

export default StepCostSchedule;

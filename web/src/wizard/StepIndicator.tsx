// web/src/wizard/StepIndicator.tsx — wizard breadcrumb navigation (W1 redesign).
//
// Full-width underlined breadcrumbs (replaces the numbered-pill `.wizard-steps`
// design). Equal-flex segments; current step = brand-primary 2px underline + bold;
// any step <= furthestReached is clickable (lets users navigate without losing work).
// The draft survives because CreateProjectionPage never unmounts the wizard hook.
import { STEP_LABELS, STEPS, type StepKey } from "./useWizardState";

export interface StepIndicatorProps {
  current: number;
  furthestReached: number;
  onJump?: (i: number) => void;
}

export function StepIndicator({ current, furthestReached, onJump }: StepIndicatorProps) {
  return (
    <nav className="wizard-breadcrumb" aria-label="Create projection steps">
      {STEPS.map((key: StepKey, i) => {
        const isCurrent = i === current;
        const clickable = i <= furthestReached && i !== current && !!onJump;
        const label = STEP_LABELS[key];
        return (
          <div
            key={key}
            className={[
              "wizard-breadcrumb__item",
              isCurrent ? "wizard-breadcrumb__item--current" : "",
              i < current ? "wizard-breadcrumb__item--done" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-current={isCurrent ? "step" : undefined}
            data-testid={`step-indicator-${key}`}
          >
            {clickable ? (
              <button
                type="button"
                className="wizard-breadcrumb__btn"
                onClick={() => onJump(i)}
                aria-label={label}
              >
                {label}
              </button>
            ) : (
              <span className="wizard-breadcrumb__label">{label}</span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default StepIndicator;

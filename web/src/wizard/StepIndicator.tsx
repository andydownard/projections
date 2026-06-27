// web/src/wizard/StepIndicator.tsx — the wizard's step progress indicator.
//
// An accessible ordered list of the steps with the current one marked
// aria-current. Completed steps are clickable (jump back); future steps are
// not yet reachable (gating lives in useWizardState). Purely presentational.
import { STEP_LABELS, STEPS, type StepKey } from "./useWizardState";

export interface StepIndicatorProps {
  current: number;
  onJump?: (i: number) => void;
}

export function StepIndicator({ current, onJump }: StepIndicatorProps) {
  return (
    <nav className="wizard-steps" aria-label="Create projection steps">
      <ol className="wizard-steps__list">
        {STEPS.map((key: StepKey, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          const label = STEP_LABELS[key];
          const clickable = i < current && !!onJump;
          return (
            <li
              key={key}
              className={`wizard-steps__item wizard-steps__item--${state}`}
              aria-current={i === current ? "step" : undefined}
              data-testid={`step-indicator-${key}`}
            >
              {clickable ? (
                <button
                  type="button"
                  className="wizard-steps__btn"
                  onClick={() => onJump(i)}
                >
                  <span className="wizard-steps__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  {label}
                </button>
              ) : (
                <span className="wizard-steps__label">
                  <span className="wizard-steps__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default StepIndicator;

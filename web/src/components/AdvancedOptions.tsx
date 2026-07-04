// web/src/components/AdvancedOptions.tsx — the shared, controlled disclosure for
// "advanced" / power-user settings (Wave 2 Task 2.1). Compact (closed) by
// default; every wizard step's advanced group AND the Settings tab render from
// this one component, grouped by paramGroups.ts's shared taxonomy.
//
// Fully controlled: `open`/`onToggle` live in the caller (useWizardState's
// advancedOpen map) — never as component-local state, because a step-local
// useState would forget the state on every unmount (steps unmount on
// Next/Back; CreateProjectionPage renders one Step*.tsx at a time).
//
// The native <details>/<summary> toggle is intentionally suppressed
// (preventDefault on both click and Enter/Space keydown) so the DOM's open
// attribute never fights the controlled `open` prop — the parent's state is
// the single source of truth, and this component only ever *requests* a new
// state via onToggle.
import { Children, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export interface AdvancedOptionsProps {
  /** Disclosure label; defaults to "Advanced options". */
  label?: string;
  /** Controlled open/closed state — the caller owns it. */
  open: boolean;
  /** Fired with the NEW desired open state on toggle (click or Enter/Space). */
  onToggle: (open: boolean) => void;
  children: ReactNode;
}

export function AdvancedOptions({
  label = "Advanced options",
  open,
  onToggle,
  children,
}: AdvancedOptionsProps) {
  const count = Children.count(children);

  const requestToggle = () => onToggle(!open);

  // Suppress the browser's native open/close so the controlled `open` prop
  // stays the single source of truth; report the desired new state instead.
  const handleClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    requestToggle();
  };

  // jsdom/most test environments don't synthesize a click from Enter/Space on
  // a <summary>, and real browsers that do will have their synthesized click
  // suppressed by this same preventDefault — so this never double-toggles.
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      requestToggle();
    }
  };

  return (
    <details className="advanced-options" data-testid="advanced-options" open={open}>
      <summary
        className="advanced-options__summary"
        tabIndex={0}
        aria-expanded={open}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {label}
        <span className="advanced-options__badge">{count} settings</span>
      </summary>
      {open && <div className="advanced-options__grid">{children}</div>}
    </details>
  );
}

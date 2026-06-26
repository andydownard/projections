// web/src/components/useModalDialog.ts — shared dialog keyboard behavior.
//
// Gives a modal: Escape-to-close, initial focus on a chosen control, and a
// Tab focus-trap that keeps keyboard focus inside the dialog container. Used by
// SaveConflictModal and FeedbackModal so both behave identically (rank #1 fix).
import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface UseModalDialogOptions {
  /** The dialog root that scopes the focus trap. */
  containerRef: RefObject<HTMLElement | null>;
  /** Control to focus on mount; falls back to the first focusable element. */
  initialFocusRef: RefObject<HTMLElement | null>;
  /** Invoked when the user presses Escape (if provided). */
  onEscape?: () => void;
}

export function useModalDialog({
  containerRef,
  initialFocusRef,
  onEscape,
}: UseModalDialogOptions): void {
  // Focus the requested control on mount; if it is missing or disabled, fall
  // back to the first focusable descendant so focus always enters the dialog.
  useEffect(() => {
    const target = initialFocusRef.current;
    if (target && !(target as HTMLButtonElement).disabled) {
      target.focus();
      return;
    }
    focusableWithin(containerRef.current)[0]?.focus();
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableWithin(containerRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const container = containerRef.current;

      if (event.shiftKey) {
        if (active === first || !container || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [containerRef, onEscape]);
}

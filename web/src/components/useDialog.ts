// web/src/components/useDialog.ts — shared modal a11y for the two dialogs.
//
// Both the Idea Fab FeedbackModal (role=dialog) and the 409 SaveConflictModal
// (role=alertdialog) need the same modal behavior, so it lives here once (DRY):
//   • autofocus the first focusable control when the dialog opens,
//   • trap Tab/Shift+Tab inside the panel (focus never escapes to the page),
//   • lock background scroll while open,
//   • restore focus to the element that opened the dialog on close,
//   • Escape closes — but ONLY when an onClose is provided. The save-conflict
//     alertdialog is a forced choice (reload/overwrite/save-as-copy) with no
//     dismiss affordance, so it passes no onClose and Escape is intentionally
//     inert there (a11y: an alertdialog shouldn't vanish without a decision).
//
// Returns a ref to attach to the dialog root; the trap queries it live on each
// Tab so it stays correct as the panel's contents change (e.g. the feedback
// form swapping to its success view).
import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement>(onClose?: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    // Remember the trigger so focus can return to it when the dialog closes.
    const trigger = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Move focus into the dialog (first control, else the panel itself).
    const first = focusable()[0];
    if (first) first.focus();
    else {
      root.tabIndex = -1;
      root.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || !root.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !root.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      trigger?.focus?.();
    };
  }, [onClose]);

  return ref;
}

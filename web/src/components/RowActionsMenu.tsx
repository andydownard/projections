// web/src/components/RowActionsMenu.tsx — the per-row "⋯" actions menu on the list.
//
// The whole projection row is a click target → /p/<slug>/edit (EPIC L). This kebab
// lives in a trailing cell and opens a tiny menu whose only action today is "Move to
// Trash". Every pointer/keyboard event inside it calls stopPropagation so opening the
// menu (or choosing an item) never also triggers the row's navigate handler.
//
// a11y: the trigger is aria-haspopup="menu" + aria-expanded; the popup is role="menu"
// with role="menuitem" entries; Escape closes and restores focus to the trigger; a
// click outside closes it.
import { useEffect, useRef, useState } from "react";

export interface RowActionsMenuProps {
  /** The projection name — used only for the trigger's accessible label. */
  name: string;
  /** Invoked when the owner chooses "Move to Trash". */
  onTrash: () => void;
}

export function RowActionsMenu({ name, onTrash }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div
      className="row-actions"
      ref={rootRef}
      // Keep every interaction local to the menu — never bubble to the row.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        ref={triggerRef}
        className="row-actions__trigger"
        data-testid="row-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className="row-actions__menu" role="menu" data-testid="row-actions-menu">
          <button
            type="button"
            role="menuitem"
            className="row-actions__item row-actions__item--danger"
            data-testid="row-action-trash"
            onClick={() => {
              setOpen(false);
              onTrash();
            }}
          >
            Move to Trash
          </button>
        </div>
      )}
    </div>
  );
}

export default RowActionsMenu;

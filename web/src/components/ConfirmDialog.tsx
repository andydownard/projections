// web/src/components/ConfirmDialog.tsx — a small reusable confirm dialog.
//
// Used for reversible-but-meaningful actions (e.g. "Move to Trash"). For the
// IRREVERSIBLE permanent delete, use ConfirmPurgeDialog (type-to-confirm) instead
// — the DESTRUCTIVE rule wants a stronger gate there.
//
// role="alertdialog" (a forced choice that interrupts the flow); a11y (focus trap,
// autofocus, Escape-to-cancel, scroll lock, focus restore) is handled by useDialog.
// Rendered through a portal to <body> so it overlays the whole app.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface ConfirmDialogProps {
  /** Heading text (labels the dialog for screen readers). */
  title: string;
  /** Body content — typically a sentence naming the projection. */
  children: ReactNode;
  /** The confirm button label (e.g. "Move to Trash"). */
  confirmLabel: string;
  /** Visual weight of the confirm button. "danger" tints it with --error. */
  tone?: "default" | "danger";
  /** Disables the buttons while the mutation is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = "default",
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const dialogRef = useDialog<HTMLDivElement>(busy ? undefined : onClose);

  return createPortal(
    <div
      ref={dialogRef}
      className="confirm-dialog"
      data-testid="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      style={{ zIndex: Z.feedbackScrim }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {title}
        </h2>
        <div className="confirm-dialog__body">{children}</div>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="btn"
            data-testid="confirm-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={tone === "danger" ? "btn btn--danger" : "btn btn--primary"}
            data-testid="confirm-accept"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ConfirmDialog;

// web/src/components/ConfirmPurgeDialog.tsx — the STRONG confirm for permanent delete.
//
// Permanent delete is irreversible: it erases the projection AND cascades to every
// revision, narrative and Penny transcript (#202). The DESTRUCTIVE rule requires a
// stronger gate than a single click, so the owner must TYPE the projection's exact
// name to arm the "Delete permanently" button. A plain misclick can never purge.
//
// role="alertdialog"; a11y (focus trap, autofocus on the input, Escape, scroll lock,
// focus restore) via useDialog. Rendered through a portal to <body>.
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface ConfirmPurgeDialogProps {
  /** The projection name the owner must type to confirm. */
  name: string;
  /** Disables controls while the purge is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmPurgeDialog({
  name,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmPurgeDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const dialogRef = useDialog<HTMLDivElement>(busy ? undefined : onClose);

  // Match on the trimmed value so trailing whitespace doesn't trip the owner up,
  // but the text itself must match exactly (case-sensitive).
  const armed = typed.trim() === name.trim() && name.trim().length > 0;

  return createPortal(
    <div
      ref={dialogRef}
      className="confirm-dialog confirm-purge"
      data-testid="confirm-purge-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-purge-title"
      aria-describedby="confirm-purge-warning"
      style={{ zIndex: Z.feedbackScrim }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 id="confirm-purge-title" className="confirm-dialog__title">
          Delete permanently
        </h2>
        <p id="confirm-purge-warning" className="confirm-purge__warning">
          This cannot be undone. It permanently erases <strong>{name}</strong> and all
          of its saved versions, notes, and Penny chat. The Excel and share links stop
          working.
        </p>
        <label className="confirm-purge__label" htmlFor={inputId}>
          Type <strong>{name}</strong> to confirm
        </label>
        <input
          id={inputId}
          className="confirm-purge__input"
          data-testid="confirm-purge-input"
          type="text"
          value={typed}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && armed && !busy) onConfirm();
          }}
        />
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="btn"
            data-testid="confirm-purge-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            data-testid="confirm-purge-accept"
            onClick={onConfirm}
            disabled={!armed || busy}
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ConfirmPurgeDialog;

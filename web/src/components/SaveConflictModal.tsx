// web/src/components/SaveConflictModal.tsx — the 409 optimistic-concurrency modal.
//
// A stale PATCH (the other editor saved first) surfaces this modal (API_SPEC §1.4,
// PRD §19.4). The client tracked the server `version` and never blind-overwrites:
// the user chooses Reload latest / Overwrite / Save as copy.
//
// Rendered through a portal to <body> so it overlays the whole app. It is an
// alertdialog with NO dismiss affordance — the conflict must be resolved by one
// of the three choices — so useDialog gets no onClose and Escape/backdrop are
// intentionally inert; focus is still trapped, scroll locked, and the safe
// "Reload latest" option is autofocused. The accessible name comes from the
// heading via aria-labelledby.
import { createPortal } from "react-dom";

import { useDialog } from "./useDialog";

export interface SaveConflictModalProps {
  onReload: () => void;
  onOverwrite: () => void;
  onSaveAsCopy: () => void;
  message?: string;
  /** POST …/duplicate is OWNER-ONLY. When this device holds no owner token (an
   *  editor-link holder), Save-as-copy is guaranteed to 403 — so it is disabled with
   *  an explanatory tooltip rather than dangled as a dead button. Defaults to enabled
   *  so the shared modal keeps offering it in the common owner case. */
  canSaveAsCopy?: boolean;
  saveAsCopyTitle?: string;
  /** True while a chosen resolution (reload/overwrite/save-as-copy) is in flight.
   *  Disables every action so a double-click can't fire a second POST …/duplicate or
   *  a second force-save (wave-3 w1). Defaults to false. */
  busy?: boolean;
}

export function SaveConflictModal({
  onReload,
  onOverwrite,
  onSaveAsCopy,
  message,
  canSaveAsCopy = true,
  saveAsCopyTitle = "Requires the owner account",
  busy = false,
}: SaveConflictModalProps) {
  const dialogRef = useDialog<HTMLDivElement>();

  return createPortal(
    <div
      ref={dialogRef}
      className="conflict-modal"
      data-testid="save-conflict-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
    >
      <div className="conflict-modal__panel">
        <h2 id="conflict-modal-title" className="conflict-modal__title">
          This projection changed elsewhere
        </h2>
        <p className="conflict-modal__body">
          {message ||
            "Someone else saved a newer version. Choose how to resolve your unsaved changes."}
        </p>
        <div className="conflict-modal__actions">
          <button type="button" className="btn btn--primary" onClick={onReload} disabled={busy}>
            Reload latest
          </button>
          <button type="button" className="btn" onClick={onOverwrite} disabled={busy}>
            Overwrite
          </button>
          <button
            type="button"
            className="btn"
            onClick={onSaveAsCopy}
            disabled={!canSaveAsCopy || busy}
            title={canSaveAsCopy ? undefined : saveAsCopyTitle}
          >
            Save as copy
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

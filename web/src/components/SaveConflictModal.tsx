// web/src/components/SaveConflictModal.tsx — the 409 optimistic-concurrency modal.
//
// A stale PATCH (the other editor saved first) surfaces this modal (API_SPEC §1.4,
// PRD §19.4). The client tracked the server `version` and never blind-overwrites:
// the user chooses Reload latest / Overwrite / Save as copy.
export interface SaveConflictModalProps {
  onReload: () => void;
  onOverwrite: () => void;
  onSaveAsCopy: () => void;
  message?: string;
}

export function SaveConflictModal({
  onReload,
  onOverwrite,
  onSaveAsCopy,
  message,
}: SaveConflictModalProps) {
  return (
    <div
      className="conflict-modal"
      data-testid="save-conflict-modal"
      role="alertdialog"
      aria-modal="true"
      aria-label="Save conflict"
    >
      <div className="conflict-modal__panel">
        <h2 className="conflict-modal__title">This projection changed elsewhere</h2>
        <p className="conflict-modal__body">
          {message ||
            "Someone else saved a newer version. Choose how to resolve your unsaved changes."}
        </p>
        <div className="conflict-modal__actions">
          <button type="button" onClick={onReload}>
            Reload latest
          </button>
          <button type="button" onClick={onOverwrite}>
            Overwrite
          </button>
          <button type="button" onClick={onSaveAsCopy}>
            Save as copy
          </button>
        </div>
      </div>
    </div>
  );
}

export default SaveConflictModal;

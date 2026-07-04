// web/src/components/TrashConfirmDialog.tsx — the shared "Move to Trash?" confirm
// (#324: trash-confirm-copy-duplicated). ListPage and ProjectionDetail both gate the
// soft delete behind the SAME confirm copy; this wraps ConfirmDialog so the title,
// confirm label, danger tone, and body sentence are defined exactly once.
import { ConfirmDialog } from "./ConfirmDialog";

export interface TrashConfirmDialogProps {
  /** The projection name shown in the confirm sentence. */
  name: string;
  /** Disables the buttons while the trash mutation is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function TrashConfirmDialog({ name, busy, onConfirm, onClose }: TrashConfirmDialogProps) {
  return (
    <ConfirmDialog
      title="Move to Trash?"
      confirmLabel="Move to Trash"
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      Move <strong>{name}</strong> to Trash. You can restore it later from the Trash view.
    </ConfirmDialog>
  );
}

export default TrashConfirmDialog;

// web/src/components/FeedbackModal.tsx — redacted bug/idea report (PRD §22).
//
// The success surface shows ONLY the server's random support_id (SUP-…). The
// outbound payload carries NO view_slug / token / financial field — redaction is
// server-enforced (app/routers/feedback.py); this modal also warns the user not
// to paste sensitive financial details, and never echoes a resolvable link.
//
// Rendered through a portal to <body> so it overlays the whole app (and never
// inflates the sticky <header> that hosts the Idea Fab trigger). a11y lives in
// useDialog: focus trap, autofocus, Escape-to-close, scroll lock, and focus
// restore to the trigger. The accessible name comes from the panel heading via
// aria-labelledby (role=dialog).
import { useState } from "react";
import { createPortal } from "react-dom";

import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface FeedbackModalProps {
  /** Submit handler -> returns the server support_id (SUP-…). */
  onSubmit: (input: { title: string; description: string }) => Promise<string>;
  onClose: () => void;
}

export function FeedbackModal({ onSubmit, onClose }: FeedbackModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [supportId, setSupportId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  async function send() {
    setSubmitting(true);
    try {
      const id = await onSubmit({ title, description });
      setSupportId(id);
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="feedback-modal"
      data-testid="feedback-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-modal-title"
      // Spec B §10 / issue #129: the feedback modal layers ABOVE both side panels
      // (Penny 52 / Override Inspector 51). Inline so it overrides the shared
      // tokens.css base without a cross-agent stylesheet edit (the PE1 pattern).
      style={{ zIndex: Z.feedbackScrim }}
      // Click on the scrim (outside the panel) dismisses; Escape does too.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="feedback-modal__panel">
        {supportId ? (
          <div data-testid="feedback-success" className="feedback-modal__success">
            <h2 id="feedback-modal-title">Feedback received</h2>
            <p>Thanks — your report was filed.</p>
            <p>
              Reference: <strong>{supportId}</strong>
            </p>
            <p className="feedback-modal__note">
              Quote this support ID to our team. We never attach your projection.
            </p>
            <div className="feedback-modal__actions">
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <form
            className="feedback-modal__form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <h2 id="feedback-modal-title">Send feedback</h2>
            <p className="feedback-modal__warning">
              Please don’t include sensitive financial details — this report does not
              attach your projection.
            </p>
            <label>
              Title
              <input
                aria-label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                aria-label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="feedback-modal__actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={submitting || !title.trim()}
              >
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

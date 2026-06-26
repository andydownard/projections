// web/src/components/FeedbackModal.tsx — redacted bug/idea report (PRD §22).
//
// The success surface shows ONLY the server's random support_id (SUP-…). The
// outbound payload carries NO view_slug / token / financial field — redaction is
// server-enforced (app/routers/feedback.py); this modal also warns the user not
// to paste sensitive financial details, and never echoes a resolvable link.
import { useState } from "react";

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

  async function send() {
    setSubmitting(true);
    try {
      const id = await onSubmit({ title, description });
      setSupportId(id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="feedback-modal"
      data-testid="feedback-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
    >
      <div className="feedback-modal__panel">
        {supportId ? (
          <div data-testid="feedback-success" className="feedback-modal__success">
            <p>Thanks — your report was filed.</p>
            <p>
              Reference: <strong>{supportId}</strong>
            </p>
            <p className="feedback-modal__note">
              Quote this support ID to our team. We never attach your projection.
            </p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <form
            className="feedback-modal__form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <h2>Send feedback</h2>
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
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" disabled={submitting || !title.trim()}>
                Send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

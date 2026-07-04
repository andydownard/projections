// web/src/components/FeedbackModal.tsx — redacted bug/idea report (PRD §22).
//
// One modal, two shapes:
//   • kind="bug"  (default) — Title + Description + "don't paste financials"
//     warning. Used by the saved-projection "Feedback" action. On success it
//     shows a panel with the server's random support_id (SUP-…).
//   • kind="idea" — the App suggestion (topbar lightbulb). One unlabeled
//     textarea with placeholder "Make the app better by…". No email field —
//     the server derives the submitter's identity from the Clerk JWT (AS2).
//     On success: close immediately + showToast (AS4); support_id never shown.
//
// The outbound payload carries NO view_slug / token / financial field —
// redaction is server-enforced (app/routers/feedback.py).
//
// Rendered through a portal to <body> so it overlays the whole app (and never
// inflates the sticky <header> that hosts the topbar trigger). a11y lives in
// useDialog: focus trap, autofocus, Escape-to-close, scroll lock, and focus
// restore to the trigger. The accessible name comes from the panel heading via
// aria-labelledby (role=dialog).
import { useState } from "react";
import { createPortal } from "react-dom";

import { useToast } from "./Toast";
import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface FeedbackModalProps {
  /** "bug" (default) = Title + Description + warning; "idea" = unlabeled textarea. */
  kind?: "bug" | "idea";
  /**
   * Submit handler → returns the server support_id (SUP-…).
   * For "idea": receives only { description }. email is server-derived from the
   * Clerk JWT and never collected from the client (AS2). email? is kept in the
   * type signature for backward compatibility with callers that introspect it.
   */
  onSubmit: (input: {
    title?: string;
    description: string;
    email?: string;
  }) => Promise<string>;
  onClose: () => void;
}

export function FeedbackModal({ kind = "bug", onSubmit, onClose }: FeedbackModalProps) {
  const isIdea = kind === "idea";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [supportId, setSupportId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Task 2.5 (audit P0, same catch treatment as CreateProjectionPage's Generate): a
  // failed submit must never throw an unhandled rejection or silently do nothing —
  // the title/description draft stays intact so Send can simply be clicked again.
  const [sendError, setSendError] = useState<string | null>(null);
  const { showToast } = useToast();
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  // An idea only needs a description; a bug report needs a title to triage.
  const canSend = (isIdea ? description : title).trim().length > 0;

  async function send() {
    setSubmitting(true);
    setSendError(null);
    try {
      const id = await onSubmit(
        isIdea
          ? { description }              // AS2: no email — server derives from JWT
          : { title, description },
      );
      if (isIdea) {
        // AS4: close immediately + toast. Never show support_id for the idea path.
        onClose();
        showToast("Thanks! Your suggestion makes the app better.");
      } else {
        setSupportId(id);
      }
    } catch {
      setSendError("Couldn't send feedback — please try again.");
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
          // Bug-path success panel. The idea path never reaches here — it
          // calls onClose() + showToast() and lets the parent unmount the modal.
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
            {/* AS1: idea title = "App suggestion"; bug title = "Send feedback" */}
            <h2 id="feedback-modal-title">{isIdea ? "App suggestion" : "Send feedback"}</h2>
            {!isIdea && (
              <p className="feedback-modal__warning">
                Please don't include sensitive financial details — this report does not
                attach your projection.
              </p>
            )}
            {!isIdea && (
              <label>
                Title
                <input
                  aria-label="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            )}
            {/*
              AS3: idea = one unlabeled textarea with placeholder (no visible label
              and no warning); bug = labeled "Description" textarea.
              Both have an accessible name for WCAG 2.1 AA: the idea textarea uses
              aria-label; the bug textarea gets its name from the wrapping <label>.
            */}
            {isIdea ? (
              <textarea
                aria-label="Your suggestion"
                placeholder="Make the app better by…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            ) : (
              <label>
                Description
                <textarea
                  aria-label="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            )}
            {/* AS2: email input removed from idea path — server derives from Clerk JWT */}
            {sendError && (
              <p className="feedback-modal__error" role="alert" data-testid="feedback-error">
                {sendError}
              </p>
            )}
            <div className="feedback-modal__actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={submitting || !canSend}
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

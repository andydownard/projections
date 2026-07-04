// web/src/components/ShareModal.tsx — the unified "Share" affordance (EPIC SHARE,
// owner Decision 12).
//
// One modal, two links the owner can hand out:
//   • READ-ONLY link — the /p/<slug> view_slug URL a board member/funder opens with
//     NO account. That read-only view already offers the .xlsx + Word .docx downloads
//     (both export endpoints authorize by view_slug alone), so a recipient can pull
//     the workbook and the board packet without logging in.
//   • EDITABLE link — /p/<slug>/edit#<edit-token>. The edit capability rides the URL
//     FRAGMENT only (Regression #10 — a secret NEVER lands in a path/query/log) and is
//     scrubbed from the address bar after the recipient's first read (route.ts). The
//     edit token is held in localStorage on the OWNER's device only; when it isn't
//     present (a different device / cleared storage) the panel shows the read-only link
//     alone and NEVER fabricates a token.
//
// The owner token is never surfaced here. Rendered through a portal to <body> so it
// overlays the whole app; a11y (focus trap, autofocus, Escape, scroll lock, focus
// restore) lives in useDialog. Copy feedback reuses the global useToast() — but
// ONLY on an actual clipboard-write success (audit P2: the modal used to toast
// "Link copied" unconditionally, even when navigator.clipboard.writeText REJECTED,
// which lies to the owner about whether the link ever reached their clipboard). A
// rejected write instead renders an inline "Press Ctrl+C to copy" hint next to that
// link's field, which is still focused/selected for a manual copy.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useToast } from "./Toast";
import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface ShareModalProps {
  /** The projection's view_slug (the read-only lookup key). */
  slug: string;
  /** The edit capability for this projection, or null when not held on this device. */
  editToken: string | null;
  onClose: () => void;
}

/** Build an absolute URL from the current origin (display only; no secret in path). */
function readOnlyUrl(slug: string): string {
  return `${window.location.origin}/p/${slug}`;
}

/** The editable deep link — the token in the FRAGMENT, never the path or query. */
function editUrl(slug: string, editToken: string): string {
  return `${window.location.origin}/p/${slug}/edit#${editToken}`;
}

export function ShareModal({ slug, editToken, onClose }: ShareModalProps) {
  const { showToast } = useToast();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const readOnlyRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  // Which link's clipboard write most recently REJECTED (honesty fix, audit P2):
  // only that link's row shows the manual "Press Ctrl+C to copy" hint, and only
  // until a write for that same link succeeds.
  const [copyFailed, setCopyFailed] = useState<{ readonly: boolean; edit: boolean }>({
    readonly: false,
    edit: false,
  });

  async function copy(kind: "readonly" | "edit", url: string, field: HTMLInputElement | null) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Do NOT toast success on a rejected write — that would tell the owner the
        // link is on their clipboard when it is not. Surface the manual fallback
        // instead; the field is still selected below so Ctrl+C works immediately.
        field?.focus();
        field?.select();
        setCopyFailed((s) => ({ ...s, [kind]: true }));
        return;
      }
      setCopyFailed((s) => ({ ...s, [kind]: false }));
      showToast("Link copied");
      return;
    }
    // No Clipboard API (older/insecure context): select so the user can copy by
    // hand. NOTHING reached the clipboard, so "Link copied" would be a lie — show
    // the same inline manual-copy hint as the reject path (3.5 review, honesty rule).
    field?.focus();
    field?.select();
    setCopyFailed((s) => ({ ...s, [kind]: true }));
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="share-modal"
      data-testid="share-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      // Layer above the side panels, same tier as the feedback modal (Spec B §10).
      style={{ zIndex: Z.feedbackScrim }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="share-modal__panel">
        <h2 id="share-modal-title">Share this projection</h2>

        {/* Read-only link — the board/funder view, no account needed. */}
        <div className="share-modal__link">
          <label className="share-modal__link-label" htmlFor="share-readonly-link">
            Read-only link
          </label>
          <p className="share-modal__link-help">
            Anyone with this link can view the decision and download the Excel workbook
            and Word board packet. No account needed.
          </p>
          <div className="share-modal__link-row">
            <input
              id="share-readonly-link"
              ref={readOnlyRef}
              className="share-modal__link-input"
              data-testid="share-readonly-link"
              type="text"
              readOnly
              value={readOnlyUrl(slug)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn"
              data-testid="share-copy-readonly"
              onClick={() => void copy("readonly", readOnlyUrl(slug), readOnlyRef.current)}
            >
              Copy
            </button>
          </div>
          {copyFailed.readonly && (
            <p className="share-modal__link-help" data-testid="share-copy-readonly-manual">
              Press Ctrl+C to copy
            </p>
          )}
        </div>

        {/* Editable link — only when this device holds the edit token. */}
        <div className="share-modal__link">
          <label className="share-modal__link-label" htmlFor="share-edit-link">
            Editable link
          </label>
          {editToken ? (
            <>
              <p className="share-modal__link-help">
                Anyone with this link can edit the inputs and assumptions. Share it only
                with people you trust to change the numbers.
              </p>
              <div className="share-modal__link-row">
                <input
                  id="share-edit-link"
                  ref={editRef}
                  className="share-modal__link-input"
                  data-testid="share-edit-link"
                  type="text"
                  readOnly
                  value={editUrl(slug, editToken)}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="btn"
                  data-testid="share-copy-edit"
                  onClick={() => void copy("edit", editUrl(slug, editToken), editRef.current)}
                >
                  Copy
                </button>
              </div>
              {copyFailed.edit && (
                <p className="share-modal__link-help" data-testid="share-copy-edit-manual">
                  Press Ctrl+C to copy
                </p>
              )}
            </>
          ) : (
            <p className="share-modal__link-help" data-testid="share-edit-unavailable">
              The editable link is only available on the device where this projection was
              created. Open it there to copy the editable link.
            </p>
          )}
        </div>

        <div className="share-modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ShareModal;

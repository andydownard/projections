// web/src/components/ShareModal.tsx — the "Share" affordance (EPIC SHARE,
// owner Decision 12).
//
// This project has no authentication (owner decision, 2026-09-13): there is only
// one link — /p/<slug> — and it is fully viewable AND editable by anyone who opens
// it. No read-only/editable distinction, no token of any kind.
//
// Rendered through a portal to <body> so it overlays the whole app; a11y (focus
// trap, autofocus, Escape, scroll lock, focus restore) lives in useDialog. Copy
// feedback reuses the global useToast() — but ONLY on an actual clipboard-write
// success (audit P2: the modal used to toast "Link copied" unconditionally, even
// when navigator.clipboard.writeText REJECTED, which lies about whether the link
// ever reached the clipboard). A rejected write instead renders an inline "Press
// Ctrl+C to copy" hint next to the field, which is still focused/selected for a
// manual copy.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useToast } from "./Toast";
import { useDialog } from "./useDialog";
import { Z } from "./sidePanels";

export interface ShareModalProps {
  /** The projection's view_slug. */
  slug: string;
  onClose: () => void;
}

/** Build an absolute URL from the current origin. */
function shareUrl(slug: string): string {
  return `${window.location.origin}/p/${slug}`;
}

export function ShareModal({ slug, onClose }: ShareModalProps) {
  const { showToast } = useToast();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const linkRef = useRef<HTMLInputElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy(url: string, field: HTMLInputElement | null) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Do NOT toast success on a rejected write — that would tell the caller the
        // link is on their clipboard when it is not. Surface the manual fallback
        // instead; the field is still selected below so Ctrl+C works immediately.
        field?.focus();
        field?.select();
        setCopyFailed(true);
        return;
      }
      setCopyFailed(false);
      showToast("Link copied");
      return;
    }
    // No Clipboard API (older/insecure context): select so the user can copy by
    // hand. NOTHING reached the clipboard, so "Link copied" would be a lie — show
    // the same inline manual-copy hint as the reject path (3.5 review, honesty rule).
    field?.focus();
    field?.select();
    setCopyFailed(true);
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

        <div className="share-modal__link">
          <label className="share-modal__link-label" htmlFor="share-link">
            Link
          </label>
          <p className="share-modal__link-help">
            Anyone with this link can view and edit this projection, and download the
            Excel workbook and Word board packet. No account needed.
          </p>
          <div className="share-modal__link-row">
            <input
              id="share-link"
              ref={linkRef}
              className="share-modal__link-input"
              data-testid="share-link"
              type="text"
              readOnly
              value={shareUrl(slug)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn"
              data-testid="share-copy"
              onClick={() => void copy(shareUrl(slug), linkRef.current)}
            >
              Copy
            </button>
          </div>
          {copyFailed && (
            <p className="share-modal__link-help" data-testid="share-copy-manual">
              Press Ctrl+C to copy
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

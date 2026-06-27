// web/src/components/TopBar.tsx — the single shared top bar on every route (W1).
//
// One consistent header everywhere (home/list, wizard, detail, role view). The
// left cluster is identical on every route: the Thriftly wordmark (links home),
// a thin divider, and the brand text "Store Projections". The right cluster
// carries the Idea Fab lightbulb — a keyboard-accessible docked button that
// opens the existing FeedbackModal (Enter/click opens, Esc closes, focus
// restores to the trigger on close). Model-version / save-state chips remain
// detail-page-only and are passed in by that page.
//
// The bar renders the view-model and computes NOTHING. The version chip text
// comes verbatim from the server (computed_json.model_version), never derived on
// the client, and only renders once a projection is loaded (no permanent
// "model —" placeholder). Feedback redaction is server-enforced; this component
// reuses FeedbackModal unchanged and never sends a view_slug/token/financial
// field (PRD §22).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { submitFeedback } from "../api/feedback";
import { FeedbackModal } from "./FeedbackModal";
import { ThriftlyLogo } from "./ThriftlyLogo";

export type SaveState = "saved" | "saving" | "error" | "idle";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Save failed — retry",
  idle: "",
};

export interface TopBarProps {
  modelVersion?: string;
  saveState?: SaveState;
  children?: ReactNode;
}

// Inlined lightbulb glyph; inherits color via currentColor (brand layer).
function LightbulbIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" />
    </svg>
  );
}

export function TopBar({ modelVersion, saveState = "idle", children }: TopBarProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeFeedback = useCallback(() => {
    setShowFeedback(false);
    // Restore focus to the docked trigger so keyboard users aren't dropped to
    // the top of the document (a11y).
    triggerRef.current?.focus();
  }, []);

  // Esc closes the feedback modal and restores focus to the lightbulb.
  useEffect(() => {
    if (!showFeedback) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFeedback();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showFeedback, closeFeedback]);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__inner">
        <a className="topbar__home" href="/" aria-label="Thriftly home">
          <ThriftlyLogo className="topbar__logo" />
        </a>
        <span className="topbar__brand">Store Projections</span>
        <span className="topbar__spacer" aria-hidden="true" />
        {modelVersion && (
          <span className="chip" data-testid="version-chip" aria-label="model version">
            {`model ${modelVersion}`}
          </span>
        )}
        {saveState !== "idle" && (
          <span
            className="chip"
            data-testid="save-label"
            role="status"
            aria-live="polite"
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
        {children}
        <button
          ref={triggerRef}
          type="button"
          data-testid="idea-fab"
          aria-label="Send feedback"
          aria-haspopup="dialog"
          aria-expanded={showFeedback}
          onClick={() => setShowFeedback(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "36px",
            height: "36px",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            background: "var(--surface)",
            color: "var(--brand-primary)",
            cursor: "pointer",
          }}
        >
          <LightbulbIcon />
        </button>
      </div>

      {showFeedback && (
        <FeedbackModal
          onClose={closeFeedback}
          onSubmit={async (input) => {
            const res = await submitFeedback({
              title: input.title,
              description: input.description,
              type: "idea",
              route: window.location.pathname,
            });
            return res.support_id;
          }}
        />
      )}
    </header>
  );
}

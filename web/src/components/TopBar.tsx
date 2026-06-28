// web/src/components/TopBar.tsx — the single shared top bar on every route (W1).
//
// One consistent header everywhere (home/list, wizard, detail, role view). The
// left cluster is identical on every route: the Thriftly wordmark (links home),
// a thin divider, and the brand text "Store Projections". The right cluster
// carries the "App suggestion" button — a keyboard-accessible docked button that
// opens the existing FeedbackModal (Enter/click opens, Esc closes, focus
// restores to the trigger on close). The save-state chip remains detail-page-only
// and is passed in by that page.
//
// The model_version is NO LONGER DISPLAYED in the UI (#38). It is still stamped on
// computed_json (the engine versioning contract + the "new model available"
// upgrade affordance) — only the chip render is gone; no data changed.
//
// The bar renders the view-model and computes NOTHING. Feedback redaction is
// server-enforced; this component opens FeedbackModal in idea mode (a
// description, no title) and never sends a view_slug/token/financial field
// (PRD §22).
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { submitFeedback } from "../api/feedback";
import { clerkActive } from "../auth/clerkToken";
import { FeedbackModal } from "./FeedbackModal";
import { ThriftlyLogo } from "./ThriftlyLogo";

// The owner sign-in / account affordance is loaded ONLY when the Clerk satellite
// is active (lazy ⇒ the Clerk import path is never executed in the ship-dark
// default). It mounts inside the active <ClerkProvider> that RootProviders adds.
const OwnerAuthControls = lazy(() => import("../auth/OwnerAuthControls"));

export type SaveState = "saved" | "saving" | "error" | "idle";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Save failed — retry",
  idle: "",
};

export interface TopBarProps {
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

export function TopBar({ saveState = "idle", children }: TopBarProps) {
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
        {clerkActive() && (
          <Suspense fallback={null}>
            <OwnerAuthControls />
          </Suspense>
        )}
        <button
          ref={triggerRef}
          type="button"
          className="idea-fab"
          data-testid="idea-fab"
          aria-label="Send feedback"
          aria-haspopup="dialog"
          aria-expanded={showFeedback}
          onClick={() => setShowFeedback(true)}
        >
          <LightbulbIcon />
          <span aria-hidden="true">App suggestion</span>
        </button>
      </div>

      {showFeedback && (
        <FeedbackModal
          kind="idea"
          onClose={closeFeedback}
          onSubmit={async (input) => {
            const res = await submitFeedback({
              description: input.description,
              email: input.email,
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

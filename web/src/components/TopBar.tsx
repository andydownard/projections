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
  /**
   * Minimal chrome for the signed-out sign-in page (SIGNIN-2): only the wordmark
   * + "Store Projections" divider. No save chip, no spacer, no App-suggestion
   * button, and no owner sign-in control. The full chrome returns on the
   * signed-in branch (the gate renders the full TopBar there).
   */
  minimal?: boolean;
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
      {/* Canonical Lucide "lightbulb" geometry — a distinct glass dome over the
          screw-base lines, not the prior balloon-on-a-stick shape (#319). */}
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5C17.7 10.2 18 9 18 7.5a6 6 0 1 0-12 0c0 1.5.4 2.7 1.5 4 .8.8 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  );
}

export function TopBar({ saveState = "idle", children, minimal = false }: TopBarProps) {
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

  // Minimal sign-in-page chrome (SIGNIN-2): wordmark + brand only. Hooks above run
  // unconditionally; this just trims the right cluster. The full chrome returns on
  // the signed-in branch where the gate renders <TopBar /> without `minimal`.
  if (minimal) {
    return (
      <header className="topbar" role="banner">
        <div className="topbar__inner">
          <a className="topbar__home" href="/" aria-label="Thriftly home">
            <ThriftlyLogo className="topbar__logo" />
          </a>
          <span className="topbar__brand">Store Projections</span>
        </div>
      </header>
    );
  }

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
        <button
          ref={triggerRef}
          type="button"
          className="idea-fab"
          data-testid="idea-fab"
          // The accessible name MATCHES the visible label "App suggestion" (WCAG
          // 2.5.3 Label in Name): the old aria-label "Send feedback" mismatched the
          // visible text. The lightbulb stays decorative (aria-hidden).
          aria-label="App suggestion"
          aria-haspopup="dialog"
          aria-expanded={showFeedback}
          onClick={() => setShowFeedback(true)}
        >
          <LightbulbIcon />
          <span aria-hidden="true">App suggestion</span>
        </button>
        {/* The Clerk block renders LAST so the account avatar / UserMenu is the
            RIGHTMOST element (#319). Mounted only when the satellite is active. */}
        {clerkActive() && (
          <Suspense fallback={null}>
            <OwnerAuthControls />
          </Suspense>
        )}
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

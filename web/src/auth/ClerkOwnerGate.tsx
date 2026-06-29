// web/src/auth/ClerkOwnerGate.tsx — the FORCED owner sign-in gate (Phase 0 B2 /
// Epic #318).
//
// Wraps an OWNER surface's content (home / wizard / detail-EDIT). App renders ONLY
// this gate on an owner surface when the Clerk satellite is active, passing in the
// full chrome (topBar) and the general-help Penny node. When the owner is signed
// IN, the gate renders today's chrome verbatim ({topBar}{content}{penny}). When
// signed OUT, the page content is replaced by a clean sign-in page — a MINIMAL
// header (wordmark only), the branded "Sign in with Rally" action, and a 3-step
// explainer — with NO Penny (SIGNIN-1). The content is not reachable without
// signing in ("forced"); a signed-IN owner is never trapped (fail-safe).
//
// This is one of the few modules that import @clerk/clerk-react. App lazy-loads it
// and mounts it ONLY when clerkActive() is true, so the ship-dark path (no
// VITE_CLERK_PUBLISHABLE_KEY) never executes the Clerk import — @clerk/clerk-react
// stays code-split out of the booted bundle (mirrors RootProviders / TopBar).
//
// Viewers are unaffected: App never wraps a VIEWER surface (role share, read-only
// /p/<slug>, not-found) in this gate, so capability share-links stay login-free.
import { SignedIn, SignedOut, useClerk } from "@clerk/clerk-react";
import { useEffect, useRef, type ReactNode } from "react";

import { RallyLogo } from "../components/RallyLogo";
import { TopBar } from "../components/TopBar";
import { takePostSignInRedirect } from "./postSignInRedirect";
import { signInRedirectTarget } from "./signInRedirect";

// Replays a captured shared deep link AFTER sign-in (EPIC #323). Rendered inside
// <SignedIn>, it reads-and-clears the sessionStorage destination once (a ref guard +
// the clear-on-read make it fire a single time, so it never loops). If the recipient
// is not already there it SPA-navigates to the shared projection — handling the case
// where Clerk's redirect landed them on the home list instead of the share link.
function PostSignInRedirect() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const dest = takePostSignInRedirect();
    if (!dest) return;
    const current = window.location.pathname + window.location.search;
    if (dest !== current) {
      window.history.pushState(null, "", dest);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, []);
  return null;
}

// 3-step explainer glyphs (SIGNIN-5). Hand-inlined Lucide geometry, currentColor,
// aria-hidden (the step text carries the meaning) — matches the project's
// inline-icon convention.
function StepGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function MapPinGlyph() {
  return (
    <StepGlyph>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </StepGlyph>
  );
}

function SlidersGlyph() {
  return (
    <StepGlyph>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </StepGlyph>
  );
}

function LineChartGlyph() {
  return (
    <StepGlyph>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="m19 9-5 5-4-4-3 3" />
    </StepGlyph>
  );
}

// The signed-out screen. The Sign-in button builds its target via
// clerk.buildSignInUrl({ redirectUrl }) — Clerk appends __clerk_synced so the
// cross-apex satellite session round-trips, and the explicit redirectUrl (the
// current page, fragment stripped — see signInRedirectTarget) is carried to the
// primary as redirect_url so it returns the owner to THIS satellite (SIGNIN-4).
// Satellite sign-in MUST redirect to the primary (an embedded <SignIn> is
// impossible on a satellite), so this button only navigates. NEVER hardcode that
// URL. We do NOT auto-redirect (avoids redirect loops); the owner clicks to sign in.
//
// NOTE (email magic link): for the redirect_url to survive a magic-link sign-in
// that COMPLETES on the primary, the PRIMARY (rallytasks.com) Clerk instance must
// list https://projections.thriftly.com among its allowed redirect origins and
// keep "Require the same device and browser" ON. That is primary/dashboard config
// the satellite cannot set; the satellite already passes the correct redirect_url.
function SignInGate() {
  const clerk = useClerk();
  const btnRef = useRef<HTMLButtonElement>(null);

  // Move focus to the primary action so keyboard / screen-reader users land on the
  // one thing to do here (a11y).
  useEffect(() => {
    btnRef.current?.focus();
  }, []);

  return (
    <section className="owner-gate" aria-labelledby="owner-gate-title">
      <h1 id="owner-gate-title" className="owner-gate__title">
        Sign in to continue
      </h1>
      <ol className="owner-gate__steps">
        <li className="owner-gate__step">
          <span className="owner-gate__step-icon">
            <MapPinGlyph />
          </span>
          <span className="owner-gate__step-text">
            Penny AI works with you to select the location and make donation
            projections.
          </span>
        </li>
        <li className="owner-gate__step">
          <span className="owner-gate__step-icon">
            <SlidersGlyph />
          </span>
          <span className="owner-gate__step-text">
            You tweak startup costs. Have a proposal? Share it with Penny and she
            will help.
          </span>
        </li>
        <li className="owner-gate__step">
          <span className="owner-gate__step-icon">
            <LineChartGlyph />
          </span>
          <span className="owner-gate__step-text">Get 5-year projections.</span>
        </li>
      </ol>
      {/* The visible label is "Sign in with " + the Rally wordmark (which itself
          reads "Rally"); the literal word is NOT repeated in the text. The button's
          accessible name is supplied by aria-label so screen-reader users still hear
          "Sign in with Rally" while the decorative wordmark stays aria-hidden — one
          "Rally", WCAG 2.5.3 Label-in-Name satisfied. */}
      <button
        ref={btnRef}
        type="button"
        className="owner-gate__sign-in"
        aria-label="Sign in with Rally"
        onClick={() =>
          window.location.assign(
            clerk.buildSignInUrl({ redirectUrl: signInRedirectTarget() }),
          )
        }
      >
        <span>Sign in with</span>
        <RallyLogo className="rally-mark" />
      </button>
    </section>
  );
}

export default function ClerkOwnerGate({
  topBar,
  penny,
  children,
}: {
  topBar: ReactNode;
  penny: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SignedIn>
        <PostSignInRedirect />
        {topBar}
        <main id="main" className="app__main" tabIndex={-1}>
          {children}
        </main>
        {penny}
      </SignedIn>
      <SignedOut>
        <TopBar minimal />
        <main id="main" className="app__main" tabIndex={-1}>
          <SignInGate />
        </main>
      </SignedOut>
    </>
  );
}

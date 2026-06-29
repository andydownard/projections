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
// cross-apex satellite session round-trips, and the explicit redirectUrl returns
// the magic-link to this satellite (SIGNIN-4). Satellite sign-in MUST redirect to
// the primary (an embedded <SignIn> is impossible on a satellite), so this button
// only navigates. NEVER hardcode that URL. We do NOT auto-redirect (avoids
// redirect loops); the owner clicks to sign in.
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
      <p className="owner-gate__body">
        This page is for the projection owner. Sign in to create and edit your
        projections. Shared view and role links never need a sign-in.
      </p>
      <button
        ref={btnRef}
        type="button"
        className="owner-gate__sign-in"
        onClick={() =>
          window.location.assign(
            clerk.buildSignInUrl({ redirectUrl: window.location.href }),
          )
        }
      >
        <RallyLogo className="rally-mark" />
        <span>Sign in with Rally</span>
      </button>
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

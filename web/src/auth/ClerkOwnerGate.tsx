// web/src/auth/ClerkOwnerGate.tsx — the FORCED owner sign-in gate (Phase 0 B2).
//
// Wraps an OWNER surface's content (home / wizard / detail-EDIT). When the Clerk
// satellite is active and the owner is signed OUT, the page content is replaced by
// a clean "Sign in to continue" screen — the content is not reachable without
// signing in ("forced"). A signed-IN owner sees the content normally, so the gate
// can NEVER trap a signed-in owner (fail-safe).
//
// This is the ONLY new module that imports @clerk/clerk-react. App lazy-loads it
// and mounts it ONLY when clerkActive() is true, so the ship-dark path (no
// VITE_CLERK_PUBLISHABLE_KEY) never executes the Clerk import — @clerk/clerk-react
// stays code-split out of the booted bundle (mirrors RootProviders / TopBar).
//
// Viewers are unaffected: App never wraps a VIEWER surface (role share, read-only
// /p/<slug>, not-found) in this gate, so capability share-links stay login-free.
import { SignedIn, SignedOut, useClerk } from "@clerk/clerk-react";
import { useEffect, useRef, type ReactNode } from "react";

// The signed-out screen. The Sign-in button builds its target via
// clerk.buildSignInUrl() — Clerk appends __clerk_synced so the cross-apex
// satellite session round-trips. NEVER hardcode that URL. We do NOT auto-redirect
// (avoids redirect loops); the owner clicks to sign in.
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
        onClick={() => window.location.assign(clerk.buildSignInUrl())}
      >
        Sign in
      </button>
    </section>
  );
}

export default function ClerkOwnerGate({ children }: { children: ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <SignInGate />
      </SignedOut>
    </>
  );
}

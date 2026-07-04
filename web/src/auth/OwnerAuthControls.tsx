// web/src/auth/OwnerAuthControls.tsx — the owner sign-in / account affordance.
//
// Rendered (lazy) by the TopBar only when the Clerk satellite is active, and only
// inside the active <ClerkProvider>. A signed-out owner sees a "Sign in with
// Rally" button that navigates to the PRIMARY via clerk.buildSignInUrl({
// redirectUrl }) — Clerk appends __clerk_synced so the cross-apex satellite
// session round-trips, and the explicit redirectUrl (the current page, fragment
// stripped via signInRedirectTarget) is carried as redirect_url so the primary
// returns the owner to this satellite (SIGNIN-4). NEVER hardcode that URL (plan
// §2C.3). A signed-in owner sees the account avatar (UserMenu).
//
// Viewers are unaffected: this is an optional owner control in the header, never a
// gate — share-link routes still render with no login.
import { SignedIn, SignedOut, useClerk } from "@clerk/clerk-react";

import { RallyLogo } from "../components/RallyLogo";
import { UserMenu } from "../components/UserMenu";
import { signInRedirectTarget } from "./signInRedirect";

export default function OwnerAuthControls() {
  const clerk = useClerk();
  return (
    <div className="owner-auth" data-testid="owner-auth">
      <SignedOut>
        {/* Visible label = "Sign in with " + the Rally wordmark (no duplicate
            literal "Rally"); aria-label carries the accessible name so SR users
            still hear "Sign in with Rally" with the mark aria-hidden (WCAG 2.5.3). */}
        <button
          type="button"
          className="owner-auth__sign-in"
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
      </SignedOut>
      <SignedIn>
        <UserMenu />
      </SignedIn>
    </div>
  );
}

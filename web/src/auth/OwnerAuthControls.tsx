// web/src/auth/OwnerAuthControls.tsx — the owner sign-in / account affordance.
//
// Rendered (lazy) by the TopBar only when the Clerk satellite is active, and only
// inside the active <ClerkProvider>. A signed-out owner sees a "Sign in with
// Rally" button that navigates to the PRIMARY via clerk.buildSignInUrl({
// redirectUrl }) — Clerk appends __clerk_synced so the cross-apex satellite
// session round-trips, and the explicit redirectUrl returns the magic-link to
// this satellite (SIGNIN-4). NEVER hardcode that URL (plan §2C.3). A signed-in
// owner sees the account avatar (UserMenu).
//
// Viewers are unaffected: this is an optional owner control in the header, never a
// gate — share-link routes still render with no login.
import { SignedIn, SignedOut, useClerk } from "@clerk/clerk-react";

import { RallyLogo } from "../components/RallyLogo";
import { UserMenu } from "../components/UserMenu";

export default function OwnerAuthControls() {
  const clerk = useClerk();
  return (
    <div className="owner-auth" data-testid="owner-auth">
      <SignedOut>
        <button
          type="button"
          className="owner-auth__sign-in"
          onClick={() =>
            window.location.assign(
              clerk.buildSignInUrl({ redirectUrl: window.location.href }),
            )
          }
        >
          <RallyLogo className="rally-mark" />
          <span>Sign in with Rally</span>
        </button>
      </SignedOut>
      <SignedIn>
        <UserMenu />
      </SignedIn>
    </div>
  );
}

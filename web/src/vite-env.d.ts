/// <reference types="vite/client" />

// Typed build-time env for the Vite SPA. Clerk is OFF with VITE_CLERK_PUBLISHABLE_KEY
// unset — the app builds and boots with no Clerk code path. When set, Clerk is
// ALSO gated at runtime on the hostname (auth/clerkToken.clerkEnabledForHost) —
// projections.rallytasks.com only; projections.thriftly.com never mounts Clerk
// regardless of this key, since both domains are served by the same build. All
// values are public (browser-exposed) config — the SPA never holds a Clerk secret
// (verify-only backend).
interface ImportMetaEnv {
  /** pk_live_… / pk_test_… — SAME instance as rallytasks.com. Unset ⇒ Clerk off. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** "true" enables the overrides AUDIT apparatus (audit list + justification capture
   *  in Penny). Default OFF (#322 I4) — inline cell editing + the per-cell highlight +
   *  the inline reset stay on regardless. */
  readonly VITE_OVERRIDES_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

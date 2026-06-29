/// <reference types="vite/client" />

// Typed build-time env for the Vite SPA. The Clerk satellite is SHIP-DARK: with
// VITE_CLERK_PUBLISHABLE_KEY unset the app builds and boots exactly as today and
// no Clerk code path runs. All values are public (browser-exposed) config — the
// SPA never holds a Clerk secret (verify-only backend, plan §2C.1).
interface ImportMetaEnv {
  /** pk_live_… / pk_test_… — SAME instance as rallytasks.com. Unset ⇒ Clerk off. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** Satellite host for <ClerkProvider domain>. Default "thriftly.com". */
  readonly VITE_CLERK_DOMAIN?: string;
  /** Primary sign-in URL for <ClerkProvider signInUrl>. Default rallytasks.com. */
  readonly VITE_CLERK_SIGN_IN_URL?: string;
  /** CSV of origins the satellite may redirect back to (allowedRedirectOrigins). */
  readonly VITE_ALLOWED_REDIRECT_ORIGINS?: string;
  /** "true" enables the overrides AUDIT apparatus (audit list + justification capture
   *  in Penny). Default OFF (#322 I4) — inline cell editing + the per-cell highlight +
   *  the inline reset stay on regardless. */
  readonly VITE_OVERRIDES_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

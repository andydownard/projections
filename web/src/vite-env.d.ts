/// <reference types="vite/client" />

// Typed build-time env for the Vite SPA. This project has no authentication
// (owner decision, 2026-09-13).
interface ImportMetaEnv {
  /** "true" enables the overrides AUDIT apparatus (audit list + justification capture
   *  in Penny). Default OFF (#322 I4) — inline cell editing + the per-cell highlight +
   *  the inline reset stay on regardless. */
  readonly VITE_OVERRIDES_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

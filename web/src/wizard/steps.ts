// web/src/wizard/steps.ts — the wizard's step set + slug helpers.
//
// The ONE source of truth for the ordered wizard steps, their human labels, and
// the route-slug ↔ step mapping. Both the wizard state hook (useWizardState) and
// the path router (router/route.ts) import from here so a step slug is validated
// against a single list — no drift between the cursor and the URL.
//
// Epic B (#261): each wizard step is its OWN route — /wizard/<step-slug> — so
// browser Back/Forward navigate between steps and each step is deep-linkable.
//
// W15 (redesign v2): the former "households" and "donor-market" steps are merged
// into a single "configure-donations" step. Order is now:
// Address → Square footage → Configure donations → Startup costs.
// Square footage precedes configure-donations; there is NO Review step — the last
// step's primary button is "Generate projections".

/** The ordered wizard steps (W15 redesign). */
export const STEPS = [
  "address",
  "square-footage",
  "configure-donations",
  "startup-costs",
] as const;
export type StepKey = (typeof STEPS)[number];

// Each label is the imperative action the step asks for; the step headings in each
// Step*.tsx mirror these. UI copy never says "trade area" (owner Decision 8 — the
// API/code identifier `trade_area` is unchanged).
export const STEP_LABELS: Record<StepKey, string> = {
  address: "Select address",
  "square-footage": "Set square footage",
  "configure-donations": "Configure donations",
  "startup-costs": "Set startup costs",
};

/** Type guard: is `s` one of the known step slugs? Used by the router to reject an
 *  unknown /wizard/<slug> (→ redirect to the first/furthest-valid step). */
export function isStepKey(s: string): s is StepKey {
  return (STEPS as readonly string[]).includes(s);
}

/** Parse a step slug out of a /wizard/<slug> pathname. Returns the StepKey for a
 *  recognized slug, else null (bare /wizard, an unknown slug, or a non-wizard path).
 *  Null signals the caller to canonicalize/redirect to a valid step. */
export function stepFromPath(pathname: string): StepKey | null {
  const m = pathname.match(/^\/wizard\/([^/]+)\/?$/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  return isStepKey(slug) ? slug : null;
}

/** The canonical pathname for a step (no search/fragment). */
export function pathForStep(step: StepKey): string {
  return `/wizard/${step}`;
}

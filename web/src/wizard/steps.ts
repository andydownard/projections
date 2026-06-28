// web/src/wizard/steps.ts — the wizard's step set + slug helpers.
//
// The ONE source of truth for the ordered wizard steps, their human labels, and
// the route-slug ↔ step mapping. Both the wizard state hook (useWizardState) and
// the path router (router/route.ts) import from here so a step slug is validated
// against a single list — no drift between the cursor and the URL.
//
// Epic B (#261): each wizard step is its OWN route — /wizard/<step-slug> — so
// browser Back/Forward navigate between steps and each step is deep-linkable.

/** The ordered wizard steps (Spec §3). "space" (Size & rent, feature #245) sits
 * between trade-area and donor-market: it needs the resolved location (for the
 * rent research pre-fill) and feeds occupancy into the donor-driven projection. */
export const STEPS = ["store", "trade-area", "space", "donor-market", "cost", "review"] as const;
export type StepKey = (typeof STEPS)[number];

// Each label is an imperative VERB phrase (not a bare noun) so a non-finance ED
// reads the indicator as an action to take — "Name your store", not "Store".
// The step headings in each Step*.tsx mirror these exactly.
export const STEP_LABELS: Record<StepKey, string> = {
  store: "Name your store",
  "trade-area": "Find your trade area",
  space: "Size & rent your space",
  "donor-market": "Set donor shares",
  cost: "Plan your costs",
  review: "Review & generate",
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

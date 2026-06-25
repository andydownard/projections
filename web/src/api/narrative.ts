// web/src/api/narrative.ts — epic-N N7: the narrative GET/PUT client (API_SPEC §6.1).
//
// GET returns the stored prose + staleness + the SERVER-built grounded_figures
// (canonical display variants — the client never re-derives a figure with a
// regex, N3). PUT saves the user-edited body_md and carries Authorization:
// Bearer + If-Match like every mutation (API_SPEC §1.3); the token rides only in
// the header (PRD §20). The server allowlist-sanitizes body_md before storage
// (stored-XSS -> localStorage-token-theft defense, SECURITY.md §5) and fail-closed
// grounding-validates it: an ungrounded hand-typed figure -> 409 grounding_failed,
// surfaced here as a typed error so the editor can flag the offending tokens.

const BASE = "/api";

/** One server-built canonical grounded figure + its blessed display variants (N3). */
export interface GroundedFigure {
  raw: number;
  display: string;
  variants: string[];
}

/** A single was->now change row (the ONE shared formatter shape, N11). */
export interface WasNow {
  field?: string;
  label?: string;
  was: string;
  now: string;
  sign?: string;
}

export type EditOrigin = "ai" | "human" | null;

export interface Narrative {
  body_md: string;
  edited: boolean;
  edit_origin: EditOrigin;
  computed_hash: string | null;
  stale: boolean;
  stale_diff: WasNow[];
  grounded_figures: GroundedFigure[];
  ai_disabled: boolean;
  updated_at: string | null;
}

export interface PutNarrativeResult {
  body_md: string;
  edited: boolean;
  edit_origin: EditOrigin;
  computed_hash: string;
}

/** Thrown on 409 grounding_failed; carries the ungrounded figures for surfacing. */
export class GroundingFailedError extends Error {
  ungroundedFigures: string[];
  constructor(ungroundedFigures: string[]) {
    super("grounding_failed");
    this.name = "GroundingFailedError";
    this.ungroundedFigures = ungroundedFigures;
  }
}

export async function getNarrative({ viewSlug }: { viewSlug: string }): Promise<Narrative> {
  const resp = await fetch(`${BASE}/projections/${viewSlug}/narrative`);
  if (!resp.ok) {
    throw new Error(`GET narrative ${viewSlug} failed: ${resp.status}`);
  }
  return (await resp.json()) as Narrative;
}

export interface PutNarrativeArgs {
  viewSlug: string;
  token: string;
  version: number;
  bodyMd: string;
}

export async function putNarrative({
  viewSlug,
  token,
  version,
  bodyMd,
}: PutNarrativeArgs): Promise<PutNarrativeResult> {
  const resp = await fetch(`${BASE}/projections/${viewSlug}/narrative`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "If-Match": String(version),
    },
    body: JSON.stringify({ body_md: bodyMd }),
  });

  if (resp.status === 409) {
    const body = (await resp.json()) as { detail?: { error?: string; ungrounded_figures?: string[] } };
    const detail = body.detail ?? {};
    if (detail.error === "grounding_failed") {
      throw new GroundingFailedError(detail.ungrounded_figures ?? []);
    }
    throw new Error("narrative conflict");
  }
  if (!resp.ok) {
    throw new Error(`PUT narrative ${viewSlug} failed: ${resp.status}`);
  }
  return (await resp.json()) as PutNarrativeResult;
}

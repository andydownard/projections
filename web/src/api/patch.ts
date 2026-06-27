// web/src/api/patch.ts — SLICE 4: the autosave PATCH client (API_SPEC §4.4).
//
// Every mutation carries Authorization: Bearer <token> + If-Match: <version>
// (API_SPEC §1.3). The token travels only in the header — never the URL
// path/query/log (PRD §20, CLAUDE.md hard rule). The new version comes back as
// the ETag header; a stale write returns 409 with the server's current state
// (API_SPEC §1.4), which we surface as a typed PatchConflictError for the
// autosave reducer's reload / overwrite / save-as-copy flow.
//
// No client-side math (PRD §13): `body` is a partial of the editable surface and
// the response view-model is rendered verbatim.

import type { ConflictBody } from "../state/autosaveReducer";

const BASE = "/api";

/** A partial of the editable surface (API_SPEC §4.4): assumptions/inputs/overrides/name. */
export interface PatchBody {
  assumptions?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  overrides?: { set?: unknown[]; clear?: unknown[] };
  name?: string;
}

export interface PatchArgs {
  viewSlug: string;
  token: string;
  version: number;
  body: PatchBody;
}

export interface PatchResult {
  /** The new version (from the ETag header). Drives the next If-Match. */
  version: number;
  /** The recomputed view-model (§3). Rendered verbatim — the client computes nothing. */
  viewModel: unknown;
}

/** Thrown on a 409 stale mutation; carries the server's current state for recovery. */
export class PatchConflictError extends Error {
  conflict: ConflictBody;
  constructor(conflict: ConflictBody) {
    super(conflict.message ?? "version_conflict");
    this.name = "PatchConflictError";
    this.conflict = conflict;
  }
}

/** Parse the quoted ETag (`"8"`) into the integer version; fall back to the body. */
function versionFromEtag(resp: Response, body: unknown): number {
  const etag = resp.headers.get("ETag");
  if (etag) {
    const n = Number.parseInt(etag.replace(/"/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  const v = (body as { version?: unknown })?.version;
  return typeof v === "number" ? v : NaN;
}

export async function patchProjection({
  viewSlug,
  token,
  version,
  body,
}: PatchArgs): Promise<PatchResult> {
  const resp = await fetch(`${BASE}/projections/${viewSlug}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "If-Match": String(version),
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 409) {
    // The live server raises 409 via FastAPI `HTTPException(detail={...})`, which
    // serializes as `{ "detail": {...} }` (API_SPEC §1.4). Read the NESTED envelope
    // (a flat body is tolerated too — older mocks / a future flat handler) so the
    // recovery fields (`current_version`, `current_state`) survive the parse. The
    // flat read left them `undefined`, so Overwrite re-sent the STALE If-Match and
    // the owner could never force-save (#188).
    const body = (await resp.json()) as { detail?: ConflictBody } & Partial<ConflictBody>;
    const conflict = (body.detail ?? (body as ConflictBody)) as ConflictBody;
    throw new PatchConflictError(conflict);
  }
  if (!resp.ok) {
    throw new Error(`PATCH ${viewSlug} failed: ${resp.status}`);
  }

  const viewModel = await resp.json();
  return { version: versionFromEtag(resp, viewModel), viewModel };
}

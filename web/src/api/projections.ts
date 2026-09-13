// web/src/api/projections.ts — the global projections list (API_SPEC §4.1).
//
// This project has no authentication of any kind (owner decision, 2026-09-13): the
// list is GLOBAL — every projection in the database, unfiltered. No client-side
// math: list rows arrive as { raw, display } and are rendered verbatim.

import type { ServerValue } from "./client";
import type { PatchBody } from "./patch";

export type RecoTag =
  | "proceed"
  | "revise"
  | "find_cheaper_rent"
  | "raise_cash"
  | "delay"
  | "do_not_proceed";

/** A milestone display value from the server — `raw` is the project-month number
 *  or null when the milestone is unreached; `display` is the server-formatted string
 *  ("Month 12" / "N/A"). The client renders `display` verbatim (no client math). */
export interface MilestoneValue {
  raw: number | null;
  display: string;
}

export interface ProjectionListItem {
  view_slug: string;
  name: string;
  /** City / geography name for the location column (server-formatted). */
  location: string;
  /** Annual net income Y1..Y5 — 5-element array of {raw, display} from the server.
   *  Powers the list row sparkline (no client math). */
  income_series: ServerValue[];
  /** Year-5 net income {raw, display} — shown as the sparkline's Y5 label. */
  y5_income: ServerValue;
  /** Capital required {raw, display} — shown in red (the money you must raise). */
  capital_required: ServerValue;
  /** Payback period — server-formatted display string (e.g. "Month 25" / "N/A"). */
  payback: MilestoneValue;
  /** Break-even month — server-formatted display string (e.g. "Month 5" / "N/A"). */
  breakeven: MilestoneValue;
  /** The semantic go/no-go recommendation enum (audit P2: the v2 redesign dropped
   *  this from the list UI, but the server never stopped emitting it — see
   *  GET /api/projections `reco_tag` — so the list silently lost its headline
   *  decision cue for the "decision-and-funding tool, not a calculator" ICP). The
   *  client maps enum -> CSS token via RecoChip; the API never sends hex. */
  reco_tag: RecoTag;
  status: string;
  version: number;
  updated_at: string;
}

export interface ProjectionListResponse {
  projections: ProjectionListItem[];
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${path}`);
  }
  return (await resp.json()) as T;
}

/** The global list — every projection in the database. */
export async function listProjections(): Promise<ProjectionListResponse> {
  return request<ProjectionListResponse>("/projections");
}

/** The create-shaped response of POST …/{slug}/duplicate. */
export interface DuplicateResult {
  view_slug: string;
  version: number;
  name: string;
}

/**
 * The real "Save as copy" (API_SPEC §4.5): POST …/{slug}/duplicate copies the
 * projection into a FRESH server row (new id / view_slug, one revision) and
 * applies the optional `patch` (the conflicted edit) to the copy before compute,
 * so the user's unsaved change lands on the fork instead of being dropped. No
 * client math: the copy's view-model is computed server-side and rendered
 * verbatim after navigation.
 */
export async function duplicateProjection(
  viewSlug: string,
  patch?: PatchBody,
): Promise<DuplicateResult> {
  const resp = await fetch(`${BASE}/projections/${viewSlug}/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch ? { patch } : {}),
  });
  if (!resp.ok) {
    throw new Error(`duplicate ${viewSlug} failed: ${resp.status}`);
  }
  return (await resp.json()) as DuplicateResult;
}

/** The Trash view's list — trashed projections only (API_SPEC §4.8). */
export async function listTrashed(): Promise<ProjectionListResponse> {
  return request<ProjectionListResponse>("/projections?trashed=true");
}

// ─── Lifecycle mutations: trash / restore / purge (API_SPEC §4.8) ───────────────
// All three carry If-Match (optimistic concurrency, unrelated to auth). A stale
// version ⇒ HTTP 409, surfaced as a typed LifecycleConflictError so the UI can
// tell the caller to refresh rather than silently lose the change.

export interface LifecycleArgs {
  viewSlug: string;
  /** The version the client last saw — sent as If-Match for optimistic concurrency. */
  version: number;
}

/** Thrown on a 409 stale lifecycle mutation; carries the server's current version. */
export class LifecycleConflictError extends Error {
  currentVersion?: number;
  constructor(currentVersion?: number) {
    super("version_conflict");
    this.name = "LifecycleConflictError";
    this.currentVersion = currentVersion;
  }
}

/** Parse the integer version from the ETag header, falling back to the body. */
function versionFromResponse(resp: Response, body: unknown): number {
  const etag = resp.headers?.get?.("ETag");
  if (etag) {
    const n = Number.parseInt(etag.replace(/"/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  const v = (body as { version?: unknown })?.version;
  return typeof v === "number" ? v : NaN;
}

async function lifecycleFetch(
  method: "POST" | "DELETE",
  path: string,
  version: number,
): Promise<Response> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "If-Match": String(version) },
  });
  if (resp.status === 409) {
    const body = (await resp.json().catch(() => ({}))) as {
      detail?: { current_version?: number };
      current_version?: number;
    };
    const detail = body.detail ?? body;
    throw new LifecycleConflictError(detail?.current_version);
  }
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${path}`);
  }
  return resp;
}

/** Soft-delete (move to Trash). Returns the new version. */
export async function trashProjection({ viewSlug, version }: LifecycleArgs): Promise<number> {
  const resp = await lifecycleFetch("POST", `/projections/${viewSlug}/trash`, version);
  const body = await resp.json().catch(() => ({}));
  return versionFromResponse(resp, body);
}

/** Restore a trashed projection. Returns the new version. */
export async function restoreProjection({ viewSlug, version }: LifecycleArgs): Promise<number> {
  const resp = await lifecycleFetch("POST", `/projections/${viewSlug}/restore`, version);
  const body = await resp.json().catch(() => ({}));
  return versionFromResponse(resp, body);
}

/** Permanently erase a trashed projection and all its data (irreversible, 204). */
export async function purgeProjection({ viewSlug, version }: LifecycleArgs): Promise<void> {
  await lifecycleFetch("DELETE", `/projections/${viewSlug}`, version);
}

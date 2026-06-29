// web/src/api/projections.ts — owner-scoped list + owner-token storage (API_SPEC §4.1).
//
// The list is OWNER-SCOPED: every request carries Authorization: Bearer
// <owner_token> and the server filters by owner_token_hash — there is no global
// index (PRD §20). The owner token lives in localStorage (CLAUDE.md access model);
// it is never put in a URL path/query and never logged. No client-side math: list
// rows arrive as { raw, display } and are rendered verbatim. getOwnerToken/
// setOwnerToken are the single accessor for the localStorage owner-token key — the
// create flow (CreateProjectionPage) persists the minted token through
// setOwnerToken, and ProjectionDetail reads it via getOwnerToken.

import { authHeader } from "./authHeader";
import type { ServerValue } from "./client";

export const OWNER_TOKEN_KEY = "projections.owner_token";

export function getOwnerToken(): string | null {
  return localStorage.getItem(OWNER_TOKEN_KEY);
}

export function setOwnerToken(token: string): void {
  localStorage.setItem(OWNER_TOKEN_KEY, token);
}

// ─── Per-projection edit token (EPIC SHARE) ─────────────────────────────────────
// The edit token is the one-time edit capability POST /projections returns (hashed
// at rest on the server, re-derivable nowhere). It carries the SAME secrecy posture
// as the owner token, so it lives in the SAME store — localStorage on the owner's
// device — never in a URL path/query and never logged. The Share affordance reads it
// back to build the editable deep link, where the token rides the URL FRAGMENT only
// (/p/<slug>/edit#<edit-token>). Keyed per view_slug so each projection keeps its own
// capability. Absent (a different device / cleared storage) ⇒ the Share panel offers
// the read-only link only and never fabricates a token.

const EDIT_TOKEN_PREFIX = "projections.edit_token.";

/** The localStorage key holding the edit token for one projection. */
export function editTokenKey(viewSlug: string): string {
  return `${EDIT_TOKEN_PREFIX}${viewSlug}`;
}

export function getEditToken(viewSlug: string): string | null {
  return localStorage.getItem(editTokenKey(viewSlug));
}

export function setEditToken(viewSlug: string, token: string): void {
  localStorage.setItem(editTokenKey(viewSlug), token);
}

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

/**
 * Owner-scoped list. The owner identity comes from authHeader(): a Clerk session
 * JWT when the satellite is active + signed in, else the localStorage owner token.
 * Without any owner identity there is nothing to list (owner-scoped, no global
 * index, PRD §20) — so we short-circuit to an empty list without hitting the API.
 */
export async function listProjections(): Promise<ProjectionListResponse> {
  const headers = await authHeader();
  if (!headers.Authorization) {
    return { projections: [] };
  }
  return request<ProjectionListResponse>("/projections", { headers });
}

/**
 * The Trash view's list — owner-scoped, trashed projections only (API_SPEC §4.8).
 * Same owner-identity rule as listProjections: no owner identity ⇒ nothing to list.
 */
export async function listTrashed(): Promise<ProjectionListResponse> {
  const headers = await authHeader();
  if (!headers.Authorization) {
    return { projections: [] };
  }
  return request<ProjectionListResponse>("/projections?trashed=true", { headers });
}

// ─── Lifecycle mutations: trash / restore / purge (API_SPEC §4.8) ───────────────
// All three are OWNER-ONLY and carry If-Match (optimistic concurrency). The token
// rides the Authorization header only (never the URL/path/query/log — Regression
// #10). A stale version ⇒ HTTP 409, surfaced as a typed LifecycleConflictError so
// the UI can tell the owner to refresh rather than silently lose the change.

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
  const headers = await authHeader();
  if (!headers.Authorization) {
    // No owner identity on this device → the server would 403 owner_required.
    throw new Error("owner_required");
  }
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers, "If-Match": String(version) },
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

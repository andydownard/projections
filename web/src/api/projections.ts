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
import type { PatchBody } from "./patch";

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

/** The create-shaped response of POST …/{slug}/duplicate. `owner_token` is present
 *  only for a Clerk/anonymous owner (a capability owner joins their existing
 *  workspace, so none is minted). */
export interface DuplicateResult {
  view_slug: string;
  version: number;
  name: string;
  edit_token?: string;
  owner_token?: string;
}

/**
 * The real "Save as copy" (API_SPEC §4.5): POST …/{slug}/duplicate copies the
 * projection into a FRESH server row (new id / view_slug / edit token, one revision)
 * and applies the optional `patch` (the conflicted edit) to the copy before compute,
 * so the user's unsaved change lands on the fork instead of being dropped. Owner-only
 * — the Bearer travels in the header, never the URL (PRD §20). No client math: the
 * copy's view-model is computed server-side and rendered verbatim after navigation.
 */
export async function duplicateProjection(
  viewSlug: string,
  token: string,
  patch?: PatchBody,
): Promise<DuplicateResult> {
  const resp = await fetch(`${BASE}/projections/${viewSlug}/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch ? { patch } : {}),
  });
  if (!resp.ok) {
    throw new Error(`duplicate ${viewSlug} failed: ${resp.status}`);
  }
  return (await resp.json()) as DuplicateResult;
}

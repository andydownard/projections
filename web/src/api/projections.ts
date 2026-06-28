// web/src/api/projections.ts — owner-scoped list + owner-token storage (API_SPEC §4.1).
//
// The list is OWNER-SCOPED: every request carries Authorization: Bearer
// <owner_token> and the server filters by owner_token_hash — there is no global
// index (PRD §20). The owner token lives in localStorage (CLAUDE.md access model);
// it is never put in a URL path/query and never logged. No client-side math: list
// rows arrive as { raw, display } and are rendered verbatim. getOwnerToken/
// setOwnerToken are the single accessor for the localStorage owner-token key — the
// create pages persist the minted token through setOwnerToken (see WizardPage /
// CreateProjectionPage), and ProjectionDetail reads it via getOwnerToken.

import type { ServerValue } from "./client";

export const OWNER_TOKEN_KEY = "projections.owner_token";

export function getOwnerToken(): string | null {
  return localStorage.getItem(OWNER_TOKEN_KEY);
}

export function setOwnerToken(token: string): void {
  localStorage.setItem(OWNER_TOKEN_KEY, token);
}

export type RecoTag =
  | "proceed"
  | "revise"
  | "find_cheaper_rent"
  | "raise_cash"
  | "delay"
  | "do_not_proceed";

export interface ProjectionListItem {
  view_slug: string;
  name: string;
  location: string;
  basis: string;
  y1_revenue: ServerValue;
  y1_net: ServerValue;
  capital_required: ServerValue;
  reco_tag: RecoTag;
  status: string;
  version: number;
  updated_at: string;
  /** lat/lng for the row mini-map; null/undefined when no address was resolved. */
  coords?: { lat: number; lng: number } | null;
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

/** Owner-scoped list. Without an owner token there is nothing to list (no global index). */
export async function listProjections(): Promise<ProjectionListResponse> {
  const token = getOwnerToken();
  if (!token) {
    return { projections: [] };
  }
  return request<ProjectionListResponse>("/projections", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// web/src/api/client.ts — typed API client + the no-client-math contract.
//
// The server is the SINGLE math authority (PRD §13, CLAUDE.md hard rule). The
// client renders the server view-model and NEVER computes a projection figure.
// Every money/percent field arrives as { raw, display }; the client renders
// `display` verbatim (the server is the single formatting authority).

export const NO_CLIENT_MATH = true as const;

export interface ServerValue {
  raw: number;
  display: string;
}

/** Render a server-formatted value. Pass-through ONLY — no re-derivation. */
export function formatFromServer(v: ServerValue): string {
  return v.display;
}

export interface HealthResponse {
  status: string;
  build_sha: string;
  model_version: string;
  db: string;
  litestream: string;
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

export const api = {
  health: () => request<HealthResponse>("/health"),
};

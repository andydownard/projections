// web/src/api/places.ts — typed client for the server-proxied Places + Census
// endpoints (app/routers/places.py). The browser only ever sees predictions and
// the derived trade area + provenance; the Google/Census keys stay server-side.

export interface Prediction {
  description: string;
  place_id: string;
}

export interface HouseholdsAlternative {
  geography_name: string;
  fips: string;
  households: number;
  moe: number | null;
}

export interface TradeAreaResolved {
  location: {
    place_id: string;
    lat: number;
    lng: number;
    formatted_address: string;
  };
  trade_area: {
    basis: string;
    households: number;
    geography_name: string;
    geography_fips: string;
    acs_vintage: string;
    households_source: string;
    moe: number | null;
    alternatives: Record<string, HouseholdsAlternative>;
  };
  evidence: {
    field: string;
    label: string;
    value: number;
    method: string;
    source: string;
    source_date: string;
    confidence: string;
    geography: string;
  };
}

export type ResolveErrorKind = "location_not_found" | "census_unavailable" | "network";

export class ResolveError extends Error {
  kind: ResolveErrorKind;
  constructor(kind: ResolveErrorKind) {
    super(kind);
    this.kind = kind;
  }
}

/** A per-search session token (Places billing groups autocomplete + the resolve). */
export function newSessionToken(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export async function placesAutocomplete(
  query: string,
  sessionToken?: string,
): Promise<Prediction[]> {
  const resp = await fetch("/api/places/autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, session_token: sessionToken }),
  });
  if (!resp.ok) return [];
  const body = (await resp.json()) as { predictions?: Prediction[] };
  return body.predictions ?? [];
}

export async function placesResolve(
  placeId: string,
  basis: string,
  sessionToken?: string,
): Promise<TradeAreaResolved> {
  let resp: Response;
  try {
    resp = await fetch("/api/places/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_id: placeId, basis, session_token: sessionToken }),
    });
  } catch {
    throw new ResolveError("network");
  }
  if (resp.ok) return (await resp.json()) as TradeAreaResolved;
  const kind: ResolveErrorKind =
    resp.status === 503 ? "census_unavailable" : "location_not_found";
  throw new ResolveError(kind);
}

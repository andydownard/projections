// web/src/api/research.ts — typed client for POST /api/research (API_SPEC §7.2,
// feature #245 M3.3 rent-research slice). The browser NEVER fetches market sources
// or calls a model itself: the server fetches SSRF-hardened snippets and runs the
// extract-only LLM grounding, then returns a representative `$/sq ft` with a
// verified-vs-estimated badge + sources. The client renders the server's result
// verbatim and computes nothing (PRD §13 / CLAUDE.md LLM-GROUNDING).

/** One server-fetched market-rent source (extract-only; the URL was fetched). */
export interface RentSource {
  url: string;
  title?: string;
  source_date?: string;
  source_tier?: string;
}

/** The POST /api/research 200 body (API_SPEC §7.2). `rent_per_sqft` is the
 *  representative pre-fill (the $12 regional benchmark when AI-off / ungrounded);
 *  `verified` is true only when a fetched source survived AND confidence != low —
 *  it drives the wizard's verified-vs-estimated badge (icon + text, never color). */
export interface RentResearch {
  rent_per_sqft: number | null;
  estimate: number | null;
  low: number | null;
  high: number | null;
  rent_type: string;
  opex: number | null;
  basis: string;
  confidence: string;
  verified: boolean;
  /** "verified" | "estimated" — the server's provenance for the rent figure. */
  provenance: string;
  sources: RentSource[];
  ai_enabled: boolean;
  cached?: boolean;
}

export interface ResearchRentArgs {
  buildingSqft: number;
  /** The resolved geo object from /api/places/resolve (preferred), or… */
  location?: Record<string, unknown> | null;
  /** …a plain location label string. */
  locationLabel?: string;
  /** Lease basis the rent is quoted on; defaults to "nnn" (API_SPEC §7.2). */
  basis?: "nnn" | "gross";
  /** Optional owner token for the per-token rate-limit bucket (hashed server-side). */
  token?: string;
}

/**
 * Ask the server for a representative market rent ($/sq ft) for a resolved location.
 * Throws on a non-2xx response (incl. 429 rate-limit) so the caller can degrade to
 * the manual benchmark — research failures NEVER block the wizard (API_SPEC §19.2).
 */
export async function researchRent(args: ResearchRentArgs): Promise<RentResearch> {
  const body: Record<string, unknown> = {
    building_sqft: String(args.buildingSqft),
    basis: args.basis ?? "nnn",
  };
  if (args.location != null) body.location = args.location;
  if (args.locationLabel) body.location_label = args.locationLabel;
  if (args.token) body.token = args.token;

  const resp = await fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`research failed: ${resp.status}`);
  return (await resp.json()) as RentResearch;
}

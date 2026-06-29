// web/src/api/costSchedule.ts — the POST /api/cost-schedule/preview client (#15).
//
// The pre-Generate startup-costs grid renders row / column / grand totals, but the
// client NEVER sums (NO-CLIENT-MATH / SERVER). It POSTs the flat rows it is editing
// and the server (the one summing + formatting authority) returns each aggregate as
// `{raw, display}` — the grid renders `display` verbatim. There is no projection yet,
// so the endpoint is unauthenticated and read-only (per-IP rate-limited server-side).
import type { ServerValue } from "./client";
import type { CostScheduleRow } from "../wizard/shareHelper";

/** Per-category row total (insertion order matches the grid's row order). */
export interface CostRowTotal {
  category: string;
  total: ServerValue;
}

/** Per-month column total (ascending by month). */
export interface CostColumnTotal {
  month: number;
  total: ServerValue;
}

/** The server preview response: every aggregate as `{raw, display}` (decision #15). */
export interface CostSchedulePreview {
  rowTotals: CostRowTotal[];
  columnTotals: CostColumnTotal[];
  grandTotal: ServerValue;
  modelVersion: string;
  computeSchemaVersion: string;
}

export interface PreviewArgs {
  rows: ReadonlyArray<CostScheduleRow>;
  /** Only scales the seeded default fallback when `rows` is empty (server-side). */
  buildingSqft?: number | string | null;
  signal?: AbortSignal;
}

/**
 * Ask the server for the startup-costs grid totals (row / column / grand).
 *
 * Sends only the flat `{category, month, amount}` rows; the server sums + formats and
 * returns `{raw, display}` aggregates the grid renders verbatim. The client computes
 * NOTHING. Rejects on a non-2xx so the caller can keep the last good totals (or show
 * a blank total) — totals are presentation, never a gate.
 */
export async function previewCostSchedule({
  rows,
  buildingSqft,
  signal,
}: PreviewArgs): Promise<CostSchedulePreview> {
  const body: Record<string, unknown> = {
    cost_schedule: rows.map((r) => ({
      category: r.category,
      month: r.month,
      amount: r.amount,
    })),
  };
  if (buildingSqft != null && buildingSqft !== "") {
    body.building_sqft = String(buildingSqft);
  }

  const resp = await fetch("/api/cost-schedule/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`cost-schedule preview ${resp.status}`);
  }
  return (await resp.json()) as CostSchedulePreview;
}

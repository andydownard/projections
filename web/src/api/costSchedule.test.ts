import { afterEach, describe, expect, it, vi } from "vitest";

import { previewCostSchedule } from "./costSchedule";

// The POST /api/cost-schedule/preview client (decision #15). It SHAPES the flat rows
// into the request and returns the server's {raw, display} totals verbatim — the
// client never sums (NO-CLIENT-MATH / SERVER).

const PREVIEW = {
  rowTotals: [{ category: "Equipment", total: { raw: 50000, display: "$50,000" } }],
  columnTotals: [{ month: 1, total: { raw: 45000, display: "$45,000" } }],
  grandTotal: { raw: 110000, display: "$110,000" },
  modelVersion: "2.5.0",
  computeSchemaVersion: "1.3.0",
};

function jsonResponse(b: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("previewCostSchedule", () => {
  it("POSTs the flat rows to /api/cost-schedule/preview and returns server totals verbatim", async () => {
    let captured: { url: string; method?: string; body: Record<string, unknown> } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      captured = {
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(PREVIEW);
    });

    const out = await previewCostSchedule({
      rows: [{ category: "Equipment", month: 1, amount: 45000 }],
    });

    expect(captured!.url).toContain("/api/cost-schedule/preview");
    expect(captured!.method).toBe("POST");
    expect(captured!.body.cost_schedule).toEqual([
      { category: "Equipment", month: 1, amount: 45000 },
    ]);
    // Returned verbatim — the client did not re-derive any display string.
    expect(out.grandTotal).toEqual({ raw: 110000, display: "$110,000" });
    expect(out.rowTotals[0].total.display).toBe("$50,000");
  });

  it("only sends building_sqft (as a string) when provided", async () => {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(PREVIEW);
    });

    await previewCostSchedule({ rows: [], buildingSqft: 12500 });
    expect(body.building_sqft).toBe("12500");

    await previewCostSchedule({ rows: [] });
    expect(body.building_sqft).toBeUndefined();
  });

  it("rejects on a non-2xx (totals are presentation, never a gate)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse({}, 429));
    await expect(previewCostSchedule({ rows: [] })).rejects.toThrow(/429/);
  });
});

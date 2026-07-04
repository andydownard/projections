// web/src/components/SettingsTab.test.tsx — EPIC D / D11: the merged "Key metrics &
// drivers" grid. Derived KPIs render read-only (server display verbatim); editable
// drivers render a <NumberField> whose HUMAN value (e.g. "60" for 60%) divides by the
// scale to the engine raw at the PATCH boundary. Editing debounces a PATCH carrying
// If-Match (API_SPEC §1.3); a 409 shows a conflict banner (reload / overwrite / save
// as copy). D12: the steady-state "Saved automatically" text is gone.
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsTab } from "./SettingsTab";
import { PatchConflictError } from "../api/patch";
import type { Kpi } from "../api/viewModel";

const sv = (raw: number, display: string) => ({ raw, display });

function settingsViewModel() {
  return {
    laborPct: sv(0.6, "60%"),
    marketingPct: sv(0.0375, "3.8%"),
    suppliesPct: sv(0.05, "5%"),
    cardPct: sv(0.02, "2%"),
    payrollTaxPct: sv(0.075, "7.5%"),
    salvagePct: sv(0.008, "0.8%"),
    escalator: sv(0.03, "3%"),
    shareY1: sv(0.06, "6%"),
    shareY2: sv(0.08, "8%"),
    shareY3: sv(0.1, "10%"),
  };
}

// A schema-1.6.0 snapshot carrying EVERY newly exposed knob, so all five wizard
// groups render (Task 3.1). fixedAnnual is a single-line dict (accumulates
// server-side); leaseType is a display-only chip.
function fullSettingsViewModel() {
  return {
    ...settingsViewModel(),
    shareY4: sv(0.11, "11%"),
    shareY5: sv(0.12, "12%"),
    donationValue: sv(50, "$50"),
    basket: sv(17.08, "$17.08"),
    donationsPerHouseholdPerYear: sv(3, "3"),
    reserveBuffer: sv(25000, "$25,000"),
    sensitivityDelta: sv(0.1, "10%"),
    // Seeded ≠ the value each test types, so fireEvent.change is a genuine edit
    // (React's input value tracker suppresses a same-value change event).
    nnnOpexAnnual: sv(120, "$120"),
    buildingSqft: sv(12500, "12,500"),
    salesfloorPct: sv(0.8, "80%"),
    rentPerSqft: sv(14.5, "$14.50"),
    utilitiesPerSqft: sv(2.23, "$2.23"),
    fixedAnnual: {
      "Insurance liability": 5000,
      "Internet, Phones": 2400,
      "Pest control": 550,
      "Repairs/maintenance": 3000,
      "Security system": 1200,
    },
    leaseType: "gross",
  };
}

/** Expand a collapsible settings group (collapsed by default) by clicking its summary. */
function expandGroup(sectionId: string) {
  fireEvent.click(screen.getByTestId(`settings-group-${sectionId}`));
}

const kpis: Kpi[] = [
  { label: "Total revenue", value: { raw: 426911, display: "$426,911" }, sub: "Year 1" },
  { label: "Net income", value: { raw: -44433, display: "($44,433)" }, sub: "Year 1" },
  { label: "Labor ratio", value: { raw: 0.6, display: "60.0%" } },
];

function renderTab(overrides: Partial<Parameters<typeof SettingsTab>[0]> = {}) {
  const onPatch = overrides.onPatch ?? vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
  const props = {
    settings: settingsViewModel(),
    version: 7,
    onPatch,
    debounceMs: 10,
    ...overrides,
  };
  render(<SettingsTab {...props} />);
  return { onPatch };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("SettingsTab — merged grid renders KPIs + driver fields (D11)", () => {
  it("shows the primary donor-share drivers ungrouped at the top (always visible)", () => {
    renderTab();
    // three explicit share inputs (PRD §7.1 — no auto-midpoint) — NOT collapsed.
    expect(screen.getByLabelText(/year 1 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 share/i)).toBeInTheDocument();
  });

  it("moves the cost %s + escalator into their collapsed groups (revealed on expand)", () => {
    renderTab();
    // Collapsed by default — the moved drivers are not in the DOM yet.
    expect(screen.queryByLabelText(/labor/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/escalator/i)).not.toBeInTheDocument();

    expandGroup("cost-structure");
    expect(screen.getByLabelText(/labor/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/marketing/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/supplies/i)).toBeInTheDocument();

    expandGroup("rent-lease");
    expect(screen.getByLabelText(/escalator/i)).toBeInTheDocument();
  });

  it("renders the donation drivers when present (E2): $/donation ungrouped, basket + donations/yr in the donation group", () => {
    renderTab({ settings: fullSettingsViewModel() });
    // Shares Y4/Y5 + $/donation stay at the top (primary drivers).
    expect(screen.getByLabelText(/year 4 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 5 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/per donation/i)).toBeInTheDocument();
    // Basket + donations/donor MOVED into the (collapsed) Donation economics group.
    expect(screen.queryByLabelText(/average basket/i)).not.toBeInTheDocument();
    expandGroup("donation-econ");
    expect(screen.getByLabelText(/average basket/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/donations . donor/i)).toBeInTheDocument();
  });

  it("renders the derived KPIs READ-ONLY with the server display string verbatim (no client math)", () => {
    renderTab({ kpis });
    expect(screen.getByTestId("kpi-revenue")).toHaveTextContent("$426,911");
    expect(screen.getByTestId("kpi-Labor ratio")).toHaveTextContent("60.0%");
    // The derived KPI cells are not editable fields.
    expect(screen.getByTestId("kpi-revenue").querySelector("input")).toBeNull();
  });

  it("seeds a percent driver from raw × 100 (60% raw 0.6 → field value 60)", () => {
    renderTab();
    expandGroup("cost-structure");
    expect(screen.getByLabelText(/labor/i)).toHaveValue("60.00");
  });

  it("D12: does not show the 'Saved automatically' steady-state text", () => {
    renderTab();
    expect(screen.queryByText(/saved automatically/i)).not.toBeInTheDocument();
  });
});

describe("SettingsTab — grouped by wizard steps (Task 3.1)", () => {
  it("renders one collapsible group per PARAM_GROUP in wizard step order with '{step} — {group}' headings (timing skipped — no detail controls)", () => {
    renderTab({ settings: fullSettingsViewModel() });
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      "Set square footage — Space & occupancy rates",
      "Configure donations — Donation economics",
      "Set startup costs — Rent & lease",
      "Set startup costs — Operating cost structure",
      "Set startup costs — Funding & capital",
    ]);
  });

  it("loads each group collapsed — the group's fields are hidden until the summary is expanded", () => {
    renderTab({ settings: fullSettingsViewModel() });
    // Reserve buffer lives in the (collapsed) Funding & capital group.
    expect(screen.queryByLabelText(/reserve buffer/i)).not.toBeInTheDocument();
    expandGroup("funding");
    expect(screen.getByLabelText(/reserve buffer/i)).toBeInTheDocument();
  });

  it("PATCHes the reserve buffer as an INTEGER assumptions.reserve_buffer (funding group)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("funding");
    fireEvent.change(screen.getByLabelText(/reserve buffer/i), { target: { value: "40000" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7); // If-Match
    expect(call.body).toEqual({ assumptions: { reserve_buffer: 40000 } });
  });

  it("PATCHes a single fixed-annual line as an accumulating assumptions.fixed_annual.{line} dict", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("cost-structure");
    fireEvent.change(screen.getByLabelText(/pest control/i), { target: { value: "600" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({
      assumptions: { fixed_annual: { "Pest control": 600 } },
    });
  });

  it("PATCHes building size as a STRING inputs.building_sqft (space-rates group)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("space-rates");
    fireEvent.change(screen.getByLabelText(/building size/i), { target: { value: "13000" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ inputs: { building_sqft: "13000" } });
  });

  it("PATCHes sales-floor as a STRING FRACTION inputs.salesfloor_pct (human % ÷ 100)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("space-rates");
    fireEvent.change(screen.getByLabelText(/sales-floor/i), { target: { value: "85" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ inputs: { salesfloor_pct: "0.85" } });
  });

  it("PATCHes utilities as a STRING assumptions.utilities_per_sqft (space-rates group)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("space-rates");
    fireEvent.change(screen.getByLabelText(/utilities/i), { target: { value: "2.5" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ assumptions: { utilities_per_sqft: "2.5" } });
  });

  it("PATCHes rent as a STRING inputs.rent_per_sqft (rent-lease group)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("rent-lease");
    fireEvent.change(screen.getByLabelText(/^rent \$/i), { target: { value: "16" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ inputs: { rent_per_sqft: "16" } });
  });

  it("PATCHes NNN operating expenses as a STRING inputs.nnn_opex_annual (rent-lease group)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("rent-lease");
    fireEvent.change(screen.getByLabelText(/nnn operating/i), { target: { value: "150" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ inputs: { nnn_opex_annual: "150" } });
  });

  it("PATCHes sensitivity stress as a STRING FRACTION assumptions.sensitivity_delta", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch, settings: fullSettingsViewModel() });
    expandGroup("funding");
    fireEvent.change(screen.getByLabelText(/sensitivity/i), { target: { value: "15" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ assumptions: { sensitivity_delta: "0.15" } });
  });

  it("shows the lease type as a display-only chip (not an editable field) in the space-rates group", () => {
    renderTab({ settings: fullSettingsViewModel() });
    expandGroup("space-rates");
    const chip = screen.getByTestId("settings-lease-type");
    expect(chip).toHaveTextContent(/gross/i);
    // Display-only: no input, and a tooltip pointing to the wizard.
    expect(chip.querySelector("input")).toBeNull();
  });

  it("legacy snapshot (no 1.6.0 keys) renders no new controls and no empty groups", () => {
    // The base view-model omits every 1.6.0 key (and basket/donations).
    renderTab();
    expect(screen.queryByLabelText(/reserve buffer/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/building size/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sensitivity/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-lease-type")).not.toBeInTheDocument();

    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    // Space & occupancy rates and Funding & capital have zero present controls → not rendered.
    expect(headings).not.toContain("Set square footage — Space & occupancy rates");
    expect(headings).not.toContain("Set startup costs — Funding & capital");
    // Groups holding MOVED existing drivers (salvage, escalator, cost %s) still render.
    expect(headings).toContain("Set startup costs — Operating cost structure");
    expect(headings).toContain("Set startup costs — Rent & lease");
    expect(headings).toContain("Configure donations — Donation economics");
  });
});

describe("SettingsTab — debounced autosave (API_SPEC §1.3/§4.4)", () => {
  it("PATCHes the changed % driver, dividing the human value by the scale to the engine raw", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });
    expandGroup("cost-structure");

    // The field is entered in HUMAN percent units: "45" → engine raw 0.45.
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
    expect(screen.getByText(/saving/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7);
    expect(call.body.assumptions.labor_pct).toBeCloseTo(0.45);
  });

  it("PATCHes a donor share as a flat inputs.share_yN (the shape the merge accepts)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });

    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "12" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7);
    expect(call.body).toEqual({ inputs: { share_y1: 0.12 } });
  });

  it("PATCHes $/donation as a flat inputs.donation_value (no percent scaling)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({
      onPatch,
      settings: { ...settingsViewModel(), donationValue: sv(50, "$50") },
    });
    fireEvent.change(screen.getByLabelText(/per donation/i), { target: { value: "60" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body).toEqual({ inputs: { donation_value: 60 } });
  });

  it("collapses rapid edits into one PATCH", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });
    expandGroup("cost-structure");
    const labor = screen.getByLabelText(/labor/i);
    fireEvent.change(labor, { target: { value: "50" } });
    fireEvent.change(labor, { target: { value: "55" } });
    fireEvent.change(labor, { target: { value: "45" } });

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body.assumptions.labor_pct).toBeCloseTo(0.45);
  });
});

describe("SettingsTab — 409 conflict recovery (API_SPEC §1.4 / PRD §19.4)", () => {
  function conflictingPatch() {
    return vi.fn().mockRejectedValue(
      new PatchConflictError({
        error: "version_conflict",
        message: "This projection changed since you loaded it.",
        current_version: 9,
        your_version: 7,
        current_state: { settings: settingsViewModel() },
        recovery: ["reload", "overwrite", "save_as_copy"],
      }),
    );
  }

  it("shows the conflict banner with all three recovery actions on a 409", async () => {
    const onPatch = conflictingPatch();
    renderTab({ onPatch });
    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/changed/i)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /overwrite/i })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /save as copy|copy/i })).toBeInTheDocument();
  });

  it("Reload discards local edits (no PATCH) and clears the banner", async () => {
    const onPatch = conflictingPatch();
    renderTab({ onPatch });
    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("Overwrite re-issues the PATCH with If-Match: <current_version>", async () => {
    const onPatch = vi
      .fn()
      .mockRejectedValueOnce(
        new PatchConflictError({
          error: "version_conflict",
          message: "changed",
          current_version: 9,
          your_version: 7,
          current_state: { settings: settingsViewModel() },
          recovery: ["reload", "overwrite", "save_as_copy"],
        }),
      )
      .mockResolvedValueOnce({ version: 10, viewModel: {} });

    renderTab({ onPatch });
    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /overwrite/i }));
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(2));
    expect(onPatch.mock.calls[1][0].version).toBe(9); // If-Match: current_version
  });

  it("Save as copy calls the duplicate handler", async () => {
    const onPatch = conflictingPatch();
    const onSaveAsCopy = vi.fn();
    renderTab({ onPatch, onSaveAsCopy });
    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /save as copy|copy/i }));
    expect(onSaveAsCopy).toHaveBeenCalledTimes(1);
  });

  // Wave 3.2f / C1: /duplicate is owner-only. When this device holds no owner token
  // (an editor-link holder), Save-as-copy is guaranteed to 403 — the banner disables
  // it with an explanatory tooltip rather than dangling a dead button.
  it("disables the banner Save-as-copy with an owner-account tooltip when canSaveAsCopy is false", async () => {
    const onPatch = conflictingPatch();
    const onSaveAsCopy = vi.fn();
    renderTab({ onPatch, onSaveAsCopy, canSaveAsCopy: false });
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);
    const banner = await screen.findByRole("alert");

    const copyBtn = within(banner).getByRole("button", { name: /save as copy|copy/i });
    expect(copyBtn).toBeDisabled();
    expect(copyBtn).toHaveAttribute("title", "Requires the owner account");
    fireEvent.click(copyBtn);
    expect(onSaveAsCopy).not.toHaveBeenCalled();
  });
});

describe("SettingsTab — mobile-375 review-first layout", () => {
  it("orders the autosave status ahead of the driver controls in the DOM (review-first)", () => {
    renderTab();
    const region = screen.getByRole("region", { name: /settings/i });
    const status = within(region).getByTestId("autosave-status");
    const firstField = within(region).getByLabelText(/year 1 share/i);
    expect(status.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

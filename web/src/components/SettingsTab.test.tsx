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
  it("shows a labeled editable field for each driver seeded from the view-model", () => {
    renderTab();
    expect(screen.getByLabelText(/labor/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/marketing/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/supplies/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/escalator/i)).toBeInTheDocument();
    // three explicit share inputs (PRD §7.1 — no auto-midpoint)
    expect(screen.getByLabelText(/year 1 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 share/i)).toBeInTheDocument();
  });

  it("renders the donation drivers when present (E2): $/donation, basket, donations/yr", () => {
    renderTab({
      settings: {
        ...settingsViewModel(),
        shareY4: sv(0.11, "11%"),
        shareY5: sv(0.12, "12%"),
        donationValue: sv(50, "$50"),
        basket: sv(17.08, "$17.08"),
        donationsPerHouseholdPerYear: sv(3, "3"),
      },
    });
    expect(screen.getByLabelText(/year 4 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 5 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/per donation/i)).toBeInTheDocument();
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
    expect(screen.getByLabelText(/labor/i)).toHaveValue("60.00");
  });

  it("D12: does not show the 'Saved automatically' steady-state text", () => {
    renderTab();
    expect(screen.queryByText(/saved automatically/i)).not.toBeInTheDocument();
  });
});

describe("SettingsTab — debounced autosave (API_SPEC §1.3/§4.4)", () => {
  it("PATCHes the changed % driver, dividing the human value by the scale to the engine raw", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });

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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
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
    const firstField = within(region).getByLabelText(/labor/i);
    expect(status.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

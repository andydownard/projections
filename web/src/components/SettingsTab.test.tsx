// web/src/components/SettingsTab.test.tsx — SLICE 4: Settings & assumptions tab.
//
// Sliders for the cost %s (labor/marketing/supplies/card/payroll-tax/salvage),
// escalator, and the three demand shares — seeded from the server
// `settings` view-model ({ raw, display }) and rendered with the server's display
// string (PRD §13: no client math). Moving a slider debounces a PATCH that
// carries If-Match (API_SPEC §1.3). The bar shows Saving… / Saved automatically,
// and a 409 shows a conflict banner with reload / overwrite / save-as-copy
// (API_SPEC §1.4, PRD §19.4). Mobile-375 is review-first (status before sliders).
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsTab } from "./SettingsTab";
import { PatchConflictError } from "../api/patch";

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

describe("SettingsTab — renders the server settings", () => {
  it("shows a labeled slider for each assumption seeded from the view-model", () => {
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

  it("renders the server display string verbatim (no client math)", () => {
    renderTab();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("6%")).toBeInTheDocument();
  });

  it("starts in the saved state", () => {
    renderTab();
    expect(screen.getByText(/saved automatically/i)).toBeInTheDocument();
  });
});

describe("SettingsTab — debounced autosave (API_SPEC §1.3/§4.4)", () => {
  it("PATCHes the changed assumption with the current version after the debounce", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });

    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "0.45" } });
    expect(screen.getByText(/saving/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7);
    expect(call.body.assumptions.labor_pct).toBeCloseTo(0.45);
  });

  it("PATCHes a donor share as a flat inputs.share_yN (the shape the merge accepts)", async () => {
    // Regression: shares used to PATCH as nested `inputs.demand.share_yN`, which the
    // server merge rejected with 422 (Inputs(**{demand: ...}) -> unknown kwarg), so
    // the autosave could never settle. `share_yN` is an engine Inputs field, so the
    // body must be a FLAT `inputs.share_yN` — assert the exact shape, not just a key.
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });

    fireEvent.change(screen.getByLabelText(/year 1 share/i), { target: { value: "0.12" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7);
    expect(call.body).toEqual({ inputs: { share_y1: 0.12 } });
  });

  it("collapses rapid edits into one PATCH and shows Saved automatically after", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });
    const labor = screen.getByLabelText(/labor/i);
    fireEvent.change(labor, { target: { value: "0.5" } });
    fireEvent.change(labor, { target: { value: "0.55" } });
    fireEvent.change(labor, { target: { value: "0.45" } });

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body.assumptions.labor_pct).toBeCloseTo(0.45);
    await waitFor(() => expect(screen.getByText(/saved automatically/i)).toBeInTheDocument());
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "0.45" } });
    await vi.advanceTimersByTimeAsync(20);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/changed/i)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /overwrite/i })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /save as copy|copy/i })).toBeInTheDocument();
  });

  it("Reload discards local edits and adopts the server's current version (no PATCH)", async () => {
    const onPatch = conflictingPatch();
    renderTab({ onPatch });
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "0.45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/saved automatically/i)).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "0.45" } });
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
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "0.45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /save as copy|copy/i }));
    expect(onSaveAsCopy).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsTab — mobile-375 review-first layout", () => {
  it("orders the autosave status ahead of the slider controls in the DOM (review-first)", () => {
    renderTab();
    const region = screen.getByRole("region", { name: /settings/i });
    const status = within(region).getByTestId("autosave-status");
    const firstSlider = within(region).getByLabelText(/labor/i);
    // status node appears before the first slider in document order
    expect(status.compareDocumentPosition(firstSlider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

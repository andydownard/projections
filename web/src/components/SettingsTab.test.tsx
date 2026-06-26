// web/src/components/SettingsTab.test.tsx — SLICE 4: Settings & assumptions tab.
//
// Sliders for the cost %s (labor/marketing/supplies/card/payroll-tax/salvage),
// occupancy, escalator, and the three demand shares — seeded from the server
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
    occupancyAnnual: sv(150000, "$150,000"),
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
    expect(screen.getByText("$150,000")).toBeInTheDocument();
  });

  it("edits percents in percent space: the labor control shows '60', not '0.6'", () => {
    renderTab();
    const labor = screen.getByLabelText(/labor/i) as HTMLInputElement;
    // Edited value is in percent space (60), not the 0..1 fraction (0.6).
    expect(labor.value).toBe("60");
    // Bounds and step are scaled into percent space too.
    expect(labor.min).toBe("0");
    expect(labor.max).toBe("100");
    expect(labor.step).toBe("0.5");
    expect(labor.inputMode).toBe("decimal");
    // A trailing '%' adornment marks the unit on the editable surface.
    const control = labor.closest("label") as HTMLElement;
    expect(within(control).getByText("%")).toBeInTheDocument();
  });

  it("leaves money controls in raw space (occupancy shows its dollar raw, no '%')", () => {
    renderTab();
    const occupancy = screen.getByLabelText(/occupancy/i) as HTMLInputElement;
    expect(occupancy.value).toBe("150000");
    expect(occupancy.max).toBe("600000");
    const control = occupancy.closest("label") as HTMLElement;
    expect(within(control).queryByText("%")).not.toBeInTheDocument();
  });

  it("starts in the saved state", () => {
    renderTab();
    expect(screen.getByText(/^Saved$/)).toBeInTheDocument();
  });
});

describe("SettingsTab — debounced autosave (API_SPEC §1.3/§4.4)", () => {
  it("PATCHes the changed assumption with the current version after the debounce", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });

    // The user types in percent space ("45"); the PATCH body still carries the
    // 0..1 raw fraction (0.45) the API expects.
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
    expect(screen.getByText(/saving/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const call = onPatch.mock.calls[0][0];
    expect(call.version).toBe(7);
    expect(call.body.assumptions.labor_pct).toBeCloseTo(0.45);
  });

  it("sends the 0..1 raw fraction when the user types a percent (60 -> 0.6)", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    // Seed labor at 45% so typing "60" is a genuine change off the default.
    const settings = { ...settingsViewModel(), laborPct: sv(0.45, "45%") };
    renderTab({ onPatch, settings });

    const labor = screen.getByLabelText(/labor/i) as HTMLInputElement;
    expect(labor.value).toBe("45");
    fireEvent.change(labor, { target: { value: "60" } });
    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body.assumptions.labor_pct).toBeCloseTo(0.6);
  });

  it("collapses rapid edits into one PATCH and shows Saved automatically after", async () => {
    const onPatch = vi.fn().mockResolvedValue({ version: 8, viewModel: {} });
    renderTab({ onPatch });
    const labor = screen.getByLabelText(/labor/i);
    fireEvent.change(labor, { target: { value: "50" } });
    fireEvent.change(labor, { target: { value: "55" } });
    fireEvent.change(labor, { target: { value: "45" } });

    await vi.advanceTimersByTimeAsync(20);
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0][0].body.assumptions.labor_pct).toBeCloseTo(0.45);
    await waitFor(() => expect(screen.getByText(/^Saved$/)).toBeInTheDocument());
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

  it("Reload discards local edits and adopts the server's current version (no PATCH)", async () => {
    const onPatch = conflictingPatch();
    renderTab({ onPatch });
    fireEvent.change(screen.getByLabelText(/labor/i), { target: { value: "45" } });
    await vi.advanceTimersByTimeAsync(20);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^Saved$/)).toBeInTheDocument();
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

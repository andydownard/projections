// web/src/components/OverrideInspector.test.tsx — the RIGHT-edge Override Inspector
// panel (Spec B §10, issue #129 / PE10). RED tests for the forensic right panel: its
// z-order, the 1180px breakpoint (non-modal ↔ modal sheet), a11y, focus handling,
// and verbatim rendering of the override audit list (no client math).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverrideInspector, type InspectorOverride } from "./OverrideInspector";
import { COEXIST_MIN_WIDTH } from "./sidePanels";

function stubMatchMedia(matchesByQuery: Record<string, boolean>) {
  const impl = (query: string) => ({
    matches: matchesByQuery[query] ?? false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(impl));
}

const DESKTOP = { [`(min-width: ${COEXIST_MIN_WIDTH}px)`]: true };
const MOBILE = { [`(min-width: ${COEXIST_MIN_WIDTH}px)`]: false };

const OVERRIDES: InspectorOverride[] = [
  { node: "payroll", year: 1, label: "Payroll, Year 1", value: "$120,000", calculated: "$140,000" },
  { node: "rent", year: 2, label: "Rent, Year 2", value: "$48,000" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OverrideInspector — collapsed trigger", () => {
  it("renders a right-edge trigger with dialog a11y", () => {
    render(<OverrideInspector overrides={OVERRIDES} />);
    const fab = screen.getByTestId("inspector-fab");
    expect(fab).toHaveAttribute("aria-haspopup", "dialog");
    expect(fab).toHaveAttribute("aria-expanded", "false");
    expect(fab).toHaveAccessibleName(/override/i);
    // Not mounted until opened.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on click and reflects aria-expanded", async () => {
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-fab")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("OverrideInspector — z-order + breakpoint", () => {
  it("panel sits at z-index 51; on the desktop it is non-modal with no scrim", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    const panel = await screen.findByTestId("inspector-panel");
    expect(panel.style.zIndex).toBe("51");
    expect(panel).toHaveAttribute("aria-modal", "false");
    // Desktop scrims suppressed (no double-dim).
    expect(screen.queryByTestId("inspector-scrim")).not.toBeInTheDocument();
  });

  it("below 1180px it is a modal full-screen sheet with a scrim at z-index 50", async () => {
    stubMatchMedia(MOBILE);
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    const panel = await screen.findByTestId("inspector-panel");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel.style.zIndex).toBe("51");
    const scrim = screen.getByTestId("inspector-scrim");
    expect(scrim.style.zIndex).toBe("50");
  });
});

describe("OverrideInspector — motion + focus", () => {
  it("flies in from the right: translateX(100%) → 0 (no reduced-motion)", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": false, ...DESKTOP });
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    const panel = await screen.findByTestId("inspector-panel");
    expect(panel.style.transition).toMatch(/transform/);
    await waitFor(() => expect(panel.style.transform).toBe("translateX(0)"));
  });

  it("focuses on open and returns focus to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    const fab = screen.getByTestId("inspector-fab");
    await user.click(fab);
    const closeBtn = await screen.findByRole("button", { name: /close override inspector/i });
    await waitFor(() => expect(closeBtn).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fab).toHaveFocus();
  });
});

describe("OverrideInspector — audit content (verbatim, no math)", () => {
  it("lists each override's label + server display string verbatim", async () => {
    const user = userEvent.setup();
    render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Payroll, Year 1")).toBeInTheDocument();
    expect(within(dialog).getByText("$120,000")).toBeInTheDocument();
    expect(within(dialog).getByText("Rent, Year 2")).toBeInTheDocument();
    expect(within(dialog).getByText("$48,000")).toBeInTheDocument();
  });

  it("shows an empty state when there are no overrides", async () => {
    const user = userEvent.setup();
    render(<OverrideInspector overrides={[]} />);
    await user.click(screen.getByTestId("inspector-fab"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("inspector-empty")).toBeInTheDocument();
  });

  it("offers a per-pin reset only when onResetPin is provided, and calls it", async () => {
    const onResetPin = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<OverrideInspector overrides={OVERRIDES} />);
    await user.click(screen.getByTestId("inspector-fab"));
    let dialog = await screen.findByRole("dialog");
    // Read-only audit: no reset affordance without the seam.
    expect(within(dialog).queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();

    rerender(<OverrideInspector overrides={OVERRIDES} onResetPin={onResetPin} />);
    dialog = await screen.findByRole("dialog");
    const resetButtons = within(dialog).getAllByRole("button", { name: /reset/i });
    await user.click(resetButtons[0]);
    expect(onResetPin).toHaveBeenCalledWith("payroll", 1);
  });
});

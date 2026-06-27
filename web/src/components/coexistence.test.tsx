// web/src/components/coexistence.test.tsx — Penny LEFT ↔ Override Inspector RIGHT
// spatial-grammar acceptance (Spec B §10, issue #129 / PE10). Renders the two real
// panels inside the shared SidePanelProvider and asserts the documented coexistence:
// z-order, ≥1180px non-modal coexistence (no focus steal, no double-dim), and
// <1180px mutually-exclusive modal sheets with an aria-live announcement.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverrideInspector, type InspectorOverride } from "./OverrideInspector";
import { PennyDrawer } from "./PennyDrawer";
import { COEXIST_MIN_WIDTH, SidePanelProvider } from "./sidePanels";

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
  { node: "payroll", year: 1, label: "Payroll, Year 1", value: "$120,000" },
];

function Surface() {
  return (
    <SidePanelProvider>
      <PennyDrawer />
      <OverrideInspector overrides={OVERRIDES} />
    </SidePanelProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coexistence ≥1180px — non-modal, both open", () => {
  it("lets Penny and the Inspector be open at once, both non-modal, no scrims", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<Surface />);

    await user.click(screen.getByTestId("inspector-fab"));
    await user.click(screen.getByTestId("penny-fab"));

    const pennyPanel = await screen.findByTestId("penny-panel");
    const inspectorPanel = await screen.findByTestId("inspector-panel");
    expect(pennyPanel).toBeInTheDocument();
    expect(inspectorPanel).toBeInTheDocument();
    // Loose focus traps: both report aria-modal=false on the desktop.
    expect(pennyPanel).toHaveAttribute("aria-modal", "false");
    expect(inspectorPanel).toHaveAttribute("aria-modal", "false");
    // Desktop scrims suppressed (no double-dim).
    expect(screen.queryByTestId("penny-scrim")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inspector-scrim")).not.toBeInTheDocument();
  });

  it("stacks Penny exactly one above the Inspector", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<Surface />);
    await user.click(screen.getByTestId("inspector-fab"));
    await user.click(screen.getByTestId("penny-fab"));
    const pennyPanel = await screen.findByTestId("penny-panel");
    const inspectorPanel = await screen.findByTestId("inspector-panel");
    expect(Number(pennyPanel.style.zIndex)).toBe(Number(inspectorPanel.style.zIndex) + 1);
    expect(pennyPanel.style.zIndex).toBe("52");
    expect(inspectorPanel.style.zIndex).toBe("51");
  });

  it("opening Penny does not steal focus from an already-open Inspector", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<Surface />);

    await user.click(screen.getByTestId("inspector-fab"));
    const inspectorClose = await screen.findByRole("button", {
      name: /close override inspector/i,
    });
    await waitFor(() => expect(inspectorClose).toHaveFocus());

    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByTestId("penny-panel");
    // Penny must NOT pull focus into its own panel (exactly one focus ring).
    const pennyClose = screen.getByRole("button", { name: /close penny/i });
    expect(pennyClose).not.toHaveFocus();
    // The Inspector stays open (coexistence, not exclusion).
    expect(screen.getByTestId("inspector-panel")).toBeInTheDocument();
  });
});

describe("coexistence <1180px — modal sheets, mutually exclusive", () => {
  it("opening Penny closes the Inspector, announces it, and takes focus cleanly", async () => {
    stubMatchMedia(MOBILE);
    const user = userEvent.setup();
    render(<Surface />);

    await user.click(screen.getByTestId("inspector-fab"));
    expect(await screen.findByTestId("inspector-panel")).toBeInTheDocument();

    await user.click(screen.getByTestId("penny-fab"));
    const pennyPanel = await screen.findByTestId("penny-panel");
    // Mutually exclusive: the Inspector is gone…
    expect(screen.queryByTestId("inspector-panel")).not.toBeInTheDocument();
    // …both are modal sheets with scrims when open…
    expect(pennyPanel).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("penny-scrim")).toBeInTheDocument();
    // …the close was announced politely…
    await waitFor(() =>
      expect(screen.getByTestId("side-panel-live")).toHaveTextContent(
        /override inspector closed/i,
      ),
    );
    // …and focus landed cleanly on the new sheet (not lost to the body).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /close penny/i })).toHaveFocus(),
    );
  });
});

describe("wizard parity — Penny is the only side panel, same breakpoint", () => {
  it("non-modal at/above 1180px when rendered standalone (no Inspector)", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    expect(await screen.findByTestId("penny-panel")).toHaveAttribute("aria-modal", "false");
    expect(screen.queryByTestId("penny-scrim")).not.toBeInTheDocument();
  });

  it("modal full-screen sheet below 1180px when rendered standalone", async () => {
    stubMatchMedia(MOBILE);
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    expect(await screen.findByTestId("penny-panel")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("penny-scrim")).toBeInTheDocument();
  });
});

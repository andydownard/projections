// web/src/components/coexistence.test.tsx — Penny is now the ONLY side panel.
//
// Epic G2 (decision #42, #266) ELIMINATED the standalone right-edge Override
// Inspector: its function (the overrides audit + the justification capture) moved into
// Penny's drawer + the KPIs tab. So there is no longer a second edge panel to coexist
// with. What remains worth asserting is that Penny keeps its single-panel spatial
// grammar — non-modal side panel at/above 1180px, modal full-screen sheet below it —
// whether rendered standalone (the wizard) or inside the shared SidePanelProvider (the
// detail page), with no Inspector to fight for focus or z-order.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Penny is the only side panel — no Override Inspector remains", () => {
  it("renders no inspector FAB or panel alongside Penny (the Inspector is eliminated)", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <PennyDrawer />
      </SidePanelProvider>,
    );
    // No standalone Override Inspector trigger anywhere.
    expect(screen.queryByTestId("inspector-fab")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("penny-fab"));
    expect(await screen.findByTestId("penny-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-panel")).not.toBeInTheDocument();
  });
});

describe("Penny spatial grammar — same breakpoint, with or without a provider", () => {
  it("non-modal at/above 1180px inside the SidePanelProvider (no double-dim scrim)", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <PennyDrawer />
      </SidePanelProvider>,
    );
    await user.click(screen.getByTestId("penny-fab"));
    expect(await screen.findByTestId("penny-panel")).toHaveAttribute("aria-modal", "false");
    expect(screen.queryByTestId("penny-scrim")).not.toBeInTheDocument();
  });

  it("non-modal at/above 1180px when rendered standalone (the wizard)", async () => {
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

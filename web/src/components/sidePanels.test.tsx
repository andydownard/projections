// web/src/components/sidePanels.test.tsx — shared spatial grammar & coexistence
// wiring (Penny LEFT ↔ Override Inspector RIGHT), Spec B §10 / issue #129 (PE10).
//
// These are the RED tests for the documented z-order and the side-panel
// coordinator (breakpoint + mutual-exclusion + focus politeness).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COEXIST_MIN_WIDTH, SidePanelProvider, Z, useSidePanel } from "./sidePanels";

/** jsdom has no matchMedia; stub it, keyed by query so a test can pin the 1180px
 *  coexistence breakpoint (and reduced-motion) deterministically. */
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

/** Tiny harness exercising the coordinator through the public hook. */
function Harness() {
  const penny = useSidePanel("penny");
  const inspector = useSidePanel("inspector");
  return (
    <div>
      <button type="button" onClick={() => penny.requestOpen()}>
        open penny
      </button>
      <button type="button" onClick={() => penny.requestClose()}>
        close penny
      </button>
      <button type="button" onClick={() => inspector.requestOpen()}>
        open inspector
      </button>
      <button type="button" onClick={() => inspector.requestClose()}>
        close inspector
      </button>
      <span data-testid="penny-open">{String(penny.open)}</span>
      <span data-testid="inspector-open">{String(inspector.open)}</span>
      <span data-testid="penny-modal">{String(penny.modal)}</span>
      <span data-testid="penny-autofocus">{String(penny.autoFocus())}</span>
    </div>
  );
}

describe("sidePanels — documented z-order (Spec B §10)", () => {
  it("pins the exact stacking levels", () => {
    expect(Z.topBar).toBe(30);
    expect(Z.inspectorScrim).toBe(50);
    expect(Z.inspectorPanel).toBe(51);
    expect(Z.pennyScrim).toBe(51);
    expect(Z.pennyPanel).toBe(52);
    expect(Z.feedbackScrim).toBe(70);
    expect(Z.feedbackPanel).toBe(71);
  });

  it("orders the layers: topBar < inspector < penny < feedback", () => {
    // A later-opened Penny must never render under the Inspector → exactly one above.
    expect(Z.pennyPanel).toBe(Z.inspectorPanel + 1);
    expect(Z.topBar).toBeLessThan(Z.inspectorScrim);
    expect(Z.inspectorScrim).toBeLessThan(Z.inspectorPanel);
    expect(Z.inspectorPanel).toBeLessThan(Z.pennyPanel);
    // Feedback modal sits above BOTH side panels.
    expect(Z.feedbackScrim).toBeGreaterThan(Z.pennyPanel);
    expect(Z.feedbackPanel).toBeGreaterThan(Z.feedbackScrim);
  });
});

describe("sidePanels — coordinator ≥1180px (non-modal, coexist)", () => {
  it("reports non-modal and lets Penny + Inspector both be open", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <Harness />
      </SidePanelProvider>,
    );
    expect(screen.getByTestId("penny-modal")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "open inspector" }));
    await user.click(screen.getByRole("button", { name: "open penny" }));

    expect(screen.getByTestId("inspector-open")).toHaveTextContent("true");
    expect(screen.getByTestId("penny-open")).toHaveTextContent("true");
    // No mutual-exclusion announcement on the desktop.
    expect(screen.getByTestId("side-panel-live")).toHaveTextContent("");
  });

  it("does not auto-focus Penny when the Inspector is already open (no focus steal)", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <Harness />
      </SidePanelProvider>,
    );
    // Nothing open yet → Penny would take focus.
    expect(screen.getByTestId("penny-autofocus")).toHaveTextContent("true");
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    // Inspector open on the desktop → opening Penny must NOT steal its focus.
    expect(screen.getByTestId("penny-autofocus")).toHaveTextContent("false");
  });
});

describe("sidePanels — coordinator <1180px (modal, mutually exclusive)", () => {
  it("reports modal and closes the other sheet + announces it", async () => {
    stubMatchMedia(MOBILE);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <Harness />
      </SidePanelProvider>,
    );
    expect(screen.getByTestId("penny-modal")).toHaveTextContent("true");

    await user.click(screen.getByRole("button", { name: "open inspector" }));
    expect(screen.getByTestId("inspector-open")).toHaveTextContent("true");

    await user.click(screen.getByRole("button", { name: "open penny" }));
    expect(screen.getByTestId("penny-open")).toHaveTextContent("true");
    // Mutually exclusive: opening Penny closed the Inspector…
    expect(screen.getByTestId("inspector-open")).toHaveTextContent("false");
    // …and announced it via the polite live region.
    const live = screen.getByTestId("side-panel-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(live).toHaveTextContent(/override inspector closed/i));
  });

  it("always auto-focuses the modal sheet that opens", async () => {
    stubMatchMedia(MOBILE);
    const user = userEvent.setup();
    render(
      <SidePanelProvider>
        <Harness />
      </SidePanelProvider>,
    );
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    // Even with the Inspector open, a modal Penny sheet takes focus (it replaces it).
    expect(screen.getByTestId("penny-autofocus")).toHaveTextContent("true");
  });
});

describe("sidePanels — standalone (no provider)", () => {
  it("self-manages open state and always auto-focuses", async () => {
    stubMatchMedia(DESKTOP);
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId("penny-autofocus")).toHaveTextContent("true");
    await user.click(screen.getByRole("button", { name: "open penny" }));
    expect(screen.getByTestId("penny-open")).toHaveTextContent("true");
    // No coordinator → no live region rendered.
    expect(screen.queryByTestId("side-panel-live")).not.toBeInTheDocument();
  });
});

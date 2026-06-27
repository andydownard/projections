import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PennyDrawer } from "./PennyDrawer";

/**
 * jsdom does not implement window.matchMedia. Install a stub so the component's
 * reduced-motion / breakpoint probes resolve deterministically per test. `matches`
 * is keyed by query so a test can switch on reduced-motion specifically.
 */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PennyDrawer — collapsed FAB", () => {
  it("renders a bottom-left FAB with dialog a11y semantics and the avatar", () => {
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    expect(fab).toHaveAttribute("aria-haspopup", "dialog");
    expect(fab).toHaveAttribute("aria-expanded", "false");
    // Accessible name names Penny + the projection, not a bare icon.
    expect(fab).toHaveAccessibleName(/ask penny/i);
    // Avatar is a static image with alt text (no animated avatar).
    const avatar = within(fab).getByRole("img");
    expect(avatar).toHaveAttribute("src", "/penny-avatar.png");
    expect(avatar).toHaveAccessibleName(/penny/i);
    // The drawer/dialog is not mounted until opened.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the drawer on click and reflects aria-expanded", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("penny-fab")).toHaveAttribute("aria-expanded", "true");
    // Header carries the avatar + the name "Penny".
    expect(within(dialog).getByRole("heading", { name: "Penny" })).toBeInTheDocument();
  });

  it("opens via keyboard (Enter) when the FAB is focused", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    fab.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens via keyboard (Space) when the FAB is focused", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    fab.focus();
    await user.keyboard(" ");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("PennyDrawer — open/close + focus management", () => {
  it("moves focus into the drawer on open and back to the FAB on close", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    await user.click(fab);
    const closeBtn = await screen.findByRole("button", { name: /close penny/i });
    await waitFor(() => expect(closeBtn).toHaveFocus());

    await user.click(closeBtn);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fab).toHaveFocus();
  });

  it("closes on Escape and returns focus to the FAB", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    await user.click(fab);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fab).toHaveFocus();
  });
});

describe("PennyDrawer — body + composer shell", () => {
  it("renders a polite live transcript log and a composer", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");

    const log = screen.getByTestId("penny-transcript");
    expect(log).toHaveAttribute("role", "log");
    expect(log).toHaveAttribute("aria-live", "polite");

    // Composer shell: a multiline input and a send affordance (no backend wired).
    expect(screen.getByTestId("penny-composer")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /ask penny/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("renders provided body and composer slots verbatim", async () => {
    const user = userEvent.setup();
    render(
      <PennyDrawer composer={<div data-testid="custom-composer">composer</div>}>
        <div data-testid="custom-body">body</div>
      </PennyDrawer>,
    );
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("custom-body")).toBeInTheDocument();
    expect(screen.getByTestId("custom-composer")).toBeInTheDocument();
  });

  it("shows the actual provider on the disclosure line", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer provider="openai" />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("penny-provider")).toHaveTextContent(/openai/i);
  });
});

describe("PennyDrawer — motion", () => {
  it("animates the panel translateX(-100%)→0 by default (no reduced-motion)", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    const panel = await screen.findByTestId("penny-panel");
    expect(panel).toHaveAttribute("data-reduced-motion", "false");
    // A transition is declared, and the panel settles at translateX(0).
    expect(panel.style.transition).toMatch(/transform/);
    await waitFor(() => expect(panel.style.transform).toBe("translateX(0)"));
  });

  it("respects reduced-motion: no transition, static avatar, settled render", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    const panel = await screen.findByTestId("penny-panel");
    expect(panel).toHaveAttribute("data-reduced-motion", "true");
    expect(panel.style.transition).toBe("none");
    expect(panel.style.transform).toBe("translateX(0)");
  });
});

describe("PennyDrawer — mobile-375 sheet & a11y (PE12, #131)", () => {
  // jsdom has no matchMedia, so the shared coexistence probe defaults to a modal
  // full-screen sheet (below 1180px) — i.e. the mobile sheet is the DEFAULT here.
  // The desktop non-modal panel is exercised by stubbing the 1180px query true.

  it("locks body scroll while the full-screen sheet is open and restores it on close", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    expect(document.body.style.overflow).not.toBe("hidden");

    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");

    await user.click(screen.getByRole("button", { name: /close penny/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("does NOT lock body scroll for the desktop non-modal panel", async () => {
    stubMatchMedia({ "(min-width: 1180px)": true });
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("gives the sheet header controls a 44px touch target on the mobile sheet", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: /close penny/i })).toHaveStyle({
      minWidth: "44px",
      minHeight: "44px",
    });
    expect(screen.getByRole("button", { name: /about penny/i })).toHaveStyle({
      minWidth: "44px",
      minHeight: "44px",
    });
  });

  it("makes the suggestion chips horizontally scrollable (not wrapped) on the mobile sheet", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    const chips = screen.getByTestId("penny-chips");
    expect(chips).toHaveStyle({ flexWrap: "nowrap", overflowX: "auto" });
  });

  it("wraps the chips on the desktop panel (no horizontal scroll)", async () => {
    stubMatchMedia({ "(min-width: 1180px)": true });
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("penny-chips")).toHaveStyle({ flexWrap: "wrap" });
  });

  it("gives the composer input and send a 44px touch target on the mobile sheet", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(screen.getByRole("textbox", { name: /ask penny/i })).toHaveStyle({
      minHeight: "44px",
    });
    expect(screen.getByRole("button", { name: /send/i })).toHaveStyle({ minHeight: "44px" });
  });

  it("keeps the collapsed FAB a ≥44px touch target inset bottom-left (clear of the right scrollbar)", () => {
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    // 48px pill ≥ the 44px minimum, anchored bottom-LEFT so it never sits over the
    // table's right scrollbar / primary actions (spec §5.1).
    expect(fab).toHaveStyle({ height: "48px", position: "fixed" });
  });
});

describe("PennyDrawer — AI-disabled fallback", () => {
  it("renders a muted FAB that deep-links to Settings and never opens a dialog", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer aiEnabled={false} settingsHref="/p/abc/edit?settings=ai" />);
    const fab = screen.getByTestId("penny-fab");
    // Muted, not-color-alone: a real link with text saying it's off + Settings.
    expect(fab.tagName).toBe("A");
    expect(fab).toHaveAttribute("data-state", "ai-disabled");
    expect(fab).toHaveAttribute("href", "/p/abc/edit?settings=ai");
    expect(fab).toHaveAccessibleName(/settings/i);
    expect(fab).toHaveTextContent(/off/i);
    // It is not a dialog trigger and opening it never mounts the drawer.
    expect(fab).not.toHaveAttribute("aria-haspopup", "dialog");
    await user.click(fab);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("invokes onOpenSettings (SPA nav) instead of a hard navigation when provided", async () => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<PennyDrawer aiEnabled={false} onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByTestId("penny-fab"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

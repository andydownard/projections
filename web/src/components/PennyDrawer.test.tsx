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
  it("renders an upper-left FAB with dialog a11y semantics and the avatar", () => {
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
  it("moves focus into the drawer on open and back to the FAB on close (FAB toggle)", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    await user.click(fab);
    // Focus moves INTO the drawer — the dialog itself is the focus anchor (there is
    // no header close button; closing is Esc / scrim / the FAB toggle, spec §1).
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());

    // Re-clicking the FAB toggles the drawer closed and restores focus to the FAB.
    await user.click(fab);
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

  it("has a de-crufted header: just the avatar + name (no provider line, info, New chat or close)", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    // The removed cruft is gone…
    expect(screen.queryByTestId("penny-provider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /about penny/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close penny/i })).not.toBeInTheDocument();
    // …leaving just the avatar + the name "Penny".
    expect(screen.getByRole("heading", { name: "Penny" })).toBeInTheDocument();
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

    // Esc closes (no header close button); body scroll is restored.
    await user.keyboard("{Escape}");
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

  it("closes on a scrim tap (modal sheet) and is never a dead-end", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    await user.click(screen.getByTestId("penny-scrim"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

  it("keeps the collapsed FAB a ≥44px touch target flush to the upper-left edge", () => {
    render(<PennyDrawer />);
    const fab = screen.getByTestId("penny-fab");
    // 48px pill ≥ the 44px minimum, anchored UPPER-LEFT and flush to the left edge
    // (left: 0), below the top bar so it never overlaps the brand/home link.
    expect(fab).toHaveStyle({ height: "48px", position: "fixed", left: "0px", top: "4rem" });
  });
});

describe("PennyDrawer — non-obscuring push (spec §10)", () => {
  it("publishes body[data-penny-open] on the wide non-modal panel and clears it on close", async () => {
    stubMatchMedia({ "(min-width: 1180px)": true });
    const user = userEvent.setup();
    render(<PennyDrawer />);
    expect(document.body).not.toHaveAttribute("data-penny-open");

    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    // tokens.css insets .app__main to the right of the 380px drawer when this is set.
    expect(document.body).toHaveAttribute("data-penny-open", "true");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body).not.toHaveAttribute("data-penny-open");
  });

  it("does NOT push the page on the modal mobile sheet (it covers the page instead)", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    expect(document.body).not.toHaveAttribute("data-penny-open");
  });
});

describe("PennyDrawer — composer (paper-airplane send)", () => {
  it("sends with a paper-airplane button labelled Send and a roomy multiline input", async () => {
    const user = userEvent.setup();
    render(<PennyDrawer />);
    await user.click(screen.getByTestId("penny-fab"));
    await screen.findByRole("dialog");
    const input = screen.getByRole("textbox", { name: /ask penny/i });
    // Roomy, multi-line input (≥2 rows).
    expect(Number(input.getAttribute("rows"))).toBeGreaterThanOrEqual(2);
    // The send affordance is an icon button with an accessible name (not text).
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(within(send).queryByRole("img")).not.toBeInTheDocument(); // svg is aria-hidden
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

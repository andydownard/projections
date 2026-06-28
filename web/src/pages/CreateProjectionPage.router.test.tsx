import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";

// Epic B (#261) — page-per-step router FOUNDATION. Each wizard step is its own
// route (/wizard/<step-slug>) so browser Back/Forward navigate between steps and
// each step is deep-linkable/refreshable. The cursor and the URL stay in sync and
// the draft survives navigation (the page never unmounts on a /wizard route). The
// step CONTENT/order is unchanged here — only the routing is added.

beforeEach(() => {
  window.history.replaceState(null, "", "/wizard");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("CreateProjectionPage — route ↔ step sync (#261)", () => {
  it("canonicalizes the bare /wizard to /wizard/store on mount (first step)", async () => {
    render(<CreateProjectionPage />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));
    expect(screen.getByRole("heading", { name: /name your store/i })).toBeInTheDocument();
  });

  it("redirects an unknown step slug to the first step (invalid-slug guard)", async () => {
    window.history.replaceState(null, "", "/wizard/bogus");
    render(<CreateProjectionPage step={null} />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));
    expect(screen.getByRole("heading", { name: /name your store/i })).toBeInTheDocument();
  });

  it("pushes a new /wizard/<slug> route on Next and pops it on Back", async () => {
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));

    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(window.location.pathname).toBe("/wizard/trade-area"));
    expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));
    // Draft preserved across the route change — the typed name is still there.
    expect(screen.getByLabelText(/store name/i)).toHaveValue("House of Hope");
  });

  it("deep-links straight to a step (cursor starts there, no store flicker)", () => {
    window.history.replaceState(null, "", "/wizard/space");
    render(<CreateProjectionPage step="space" />);
    expect(screen.getByRole("heading", { name: /size .* rent your space/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wizard/space");
  });

  it("adopts a route change (browser Back/Forward via the step prop) and preserves the draft", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CreateProjectionPage step="store" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));

    await user.type(screen.getByLabelText(/store name/i), "Grace Mission");
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument(),
    );
    // Next pushed the route; the App re-parses and hands the page the new step prop.
    rerender(<CreateProjectionPage step="trade-area" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/trade-area"));

    // Simulate a browser Back: the URL changes externally and the App re-parses the
    // route, handing the page the previous step. The cursor follows; draft intact.
    window.history.replaceState(null, "", "/wizard/store");
    rerender(<CreateProjectionPage step="store" />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /name your store/i })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/store name/i)).toHaveValue("Grace Mission");
  });

  it("moves focus to the new step heading on a step change (a11y)", async () => {
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));

    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    const heading = await screen.findByRole("heading", { name: /trade area/i });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("announces the new step via a polite live region on a step change (a11y)", async () => {
    const user = userEvent.setup();
    render(<CreateProjectionPage />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/store"));

    await user.type(screen.getByLabelText(/store name/i), "House of Hope");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    const status = screen.getByTestId("wizard-step-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(status).toHaveTextContent(/step 2 of 6/i));
    expect(status).toHaveTextContent(/find your trade area/i);
  });
});

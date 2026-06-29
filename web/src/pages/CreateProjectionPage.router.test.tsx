import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CreateProjectionPage } from "./CreateProjectionPage";

// Epic B (#261) — page-per-step router. Each wizard step is its own route
// (/wizard/<step-slug>) so browser Back/Forward navigate between steps and each
// step is deep-linkable/refreshable. The cursor and the URL stay in sync and the
// draft survives navigation (the page never unmounts on a /wizard route). Phase 2
// (owner Decision 11): the order is Address → Square footage → Households → Donor
// market share → Startup costs (the Square-footage step's defaults are valid, so it
// is the simplest place to exercise Next/Back without resolving an address).

beforeEach(() => {
  window.history.replaceState(null, "", "/wizard");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("CreateProjectionPage — route ↔ step sync (#261)", () => {
  it("canonicalizes the bare /wizard to /wizard/address on mount (first step)", async () => {
    render(<CreateProjectionPage />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/address"));
    expect(screen.getByRole("heading", { name: /select address/i })).toBeInTheDocument();
  });

  it("redirects an unknown step slug to the first step (invalid-slug guard)", async () => {
    window.history.replaceState(null, "", "/wizard/bogus");
    render(<CreateProjectionPage step={null} />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/address"));
    expect(screen.getByRole("heading", { name: /select address/i })).toBeInTheDocument();
  });

  it("pushes a new /wizard/<slug> route on Next and pops it on Back (draft preserved)", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/wizard/square-footage");
    render(<CreateProjectionPage step="square-footage" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/square-footage"));

    const sqft = screen.getByLabelText(/building size/i) as HTMLInputElement;
    await user.clear(sqft);
    await user.type(sqft, "9000");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(window.location.pathname).toBe("/wizard/households"));
    expect(screen.getByRole("heading", { name: /confirm # of households/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/square-footage"));
    // Draft preserved across the route change — the typed building size is still there.
    // Building size renders comma-grouped for display consistency (#18 / QA P2).
    expect(screen.getByLabelText(/building size/i)).toHaveValue("9,000");
  });

  it("deep-links straight to a step (cursor starts there, no flicker)", () => {
    window.history.replaceState(null, "", "/wizard/square-footage");
    render(<CreateProjectionPage step="square-footage" />);
    expect(screen.getByRole("heading", { name: /set square footage/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wizard/square-footage");
  });

  it("adopts a route change (browser Back/Forward via the step prop) and preserves the draft", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/wizard/square-footage");
    const { rerender } = render(<CreateProjectionPage step="square-footage" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/square-footage"));

    const sqft = screen.getByLabelText(/building size/i) as HTMLInputElement;
    await user.clear(sqft);
    await user.type(sqft, "9000");
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /confirm # of households/i })).toBeInTheDocument(),
    );
    rerender(<CreateProjectionPage step="households" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/households"));

    // Simulate a browser Back: the URL changes externally and the App re-parses the
    // route, handing the page the previous step. The cursor follows; draft intact.
    window.history.replaceState(null, "", "/wizard/square-footage");
    rerender(<CreateProjectionPage step="square-footage" />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /set square footage/i })).toBeInTheDocument(),
    );
    // Building size renders comma-grouped for display consistency (#18 / QA P2).
    expect(screen.getByLabelText(/building size/i)).toHaveValue("9,000");
  });

  it("moves focus to the new step heading on a step change (a11y)", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/wizard/square-footage");
    render(<CreateProjectionPage step="square-footage" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/square-footage"));

    await user.click(screen.getByRole("button", { name: /^next$/i }));

    const heading = await screen.findByRole("heading", { name: /confirm # of households/i });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("announces the new step via a polite live region on a step change (a11y)", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/wizard/square-footage");
    render(<CreateProjectionPage step="square-footage" />);
    await waitFor(() => expect(window.location.pathname).toBe("/wizard/square-footage"));

    await user.click(screen.getByRole("button", { name: /^next$/i }));

    const status = screen.getByTestId("wizard-step-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(status).toHaveTextContent(/step 3 of 5/i));
    expect(status).toHaveTextContent(/confirm # of households/i);
  });
});

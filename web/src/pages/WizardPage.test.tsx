import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WizardPage } from "./WizardPage";
import type { ViewModel } from "../api/viewModel";

// SLICE 5 — the /wizard route must expose a directly-fillable express create form
// (households + the three explicit Y1/Y2/Y3 shares + Generate) so the happy-path
// E2E can generate a projection without stepping a multi-page wizard. On Generate
// the server view-model renders the decision banner + KPI strip + cash-flow. NO
// client math: every figure is the server's.

const VM: ViewModel = {
  reco: { tag: "proceed", headline: "Proceed.", sub: "Capital is within reach." },
  metrics: {
    capital: { raw: 277990, display: "$277,990" },
    cashGap: { raw: -12400, display: "($12,400)" },
    breakeven: { raw: 5, display: "Month 5" },
  },
  kpis: [{ label: "Total revenue", value: { raw: 426911, display: "$426,911" } }],
  monthly: [
    { month: 0, revenue: { raw: 0, display: "$0" }, expenses: { raw: 0, display: "$0" }, net: { raw: 0, display: "$0" }, cumulativeCash: { raw: 0, display: "$0" } },
  ],
  breakevenMonth: 5,
  rows: [],
  settings: {},
  version: 1,
  view_slug: "p_new",
  name: "House of Hope",
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // Reset the SPA location pushed by the result-screen navigation tests.
  window.history.pushState(null, "", "/");
});

/** Generate a projection and return the userEvent instance on the result screen. */
async function generate(ownerToken = "tok", extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ...VM, owner_token: ownerToken, ...extra }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  render(<WizardPage />);
  await user.click(screen.getByRole("button", { name: /generate/i }));
  await waitFor(() => expect(screen.getByTestId("decision-banner")).toBeInTheDocument());
  return user;
}

describe("WizardPage express form", () => {
  it("exposes households + three share fields + a generate button", () => {
    render(<WizardPage />);
    expect(screen.getByLabelText(/households/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 1 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 share/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("POSTs to the server and renders the decision banner from the view-model", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...VM, owner_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<WizardPage />);
    await user.clear(screen.getByLabelText(/households/i));
    await user.type(screen.getByLabelText(/households/i), "31798");
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("metric-capital")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projections",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("WizardPage result screen — next steps", () => {
  it("shows the decision lede above the banner", async () => {
    await generate();
    expect(screen.getByTestId("result-lede")).toHaveTextContent(
      /open the full projection to see the evidence/i,
    );
  });

  it("primary CTA opens the editable projection at /p/<slug>/edit#<edit-secret>", async () => {
    const editToken = "edit-secret-xyz";
    const user = await generate("tok", { edit_token: editToken });
    await user.click(screen.getByTestId("open-full-projection"));
    expect(window.location.pathname).toBe(`/p/${VM.view_slug}/edit`);
    // The edit secret rides in the fragment only — never the path/query.
    expect(window.location.hash).toBe(`#${editToken}`);
    expect(window.location.search).toBe("");
  });

  it("falls back to the owner token as the edit secret when no edit_token is returned", async () => {
    const user = await generate("owner-tok");
    await user.click(screen.getByTestId("open-full-projection"));
    expect(window.location.pathname).toBe(`/p/${VM.view_slug}/edit`);
    expect(window.location.hash).toBe("#owner-tok");
  });

  it("offers secondary Share with your board and Export Board Packet actions", async () => {
    const user = await generate();
    expect(screen.getByTestId("share-board")).toBeInTheDocument();
    await user.click(screen.getByTestId("share-board"));
    // Shares the read-only canonical view (no /edit, no secret fragment).
    expect(window.location.pathname).toBe(`/p/${VM.view_slug}`);
    expect(window.location.hash).toBe("");
  });

  it("exposes an Export Board Packet action that opens the canonical projection", async () => {
    const user = await generate();
    const packet = screen.getByTestId("export-packet");
    expect(packet).toHaveTextContent(/export board packet/i);
    await user.click(packet);
    expect(window.location.pathname).toBe(`/p/${VM.view_slug}`);
  });

  it("demotes .xlsx to a tertiary text link (not a button)", async () => {
    await generate();
    const xlsx = screen.getByTestId("download-xlsx");
    expect(xlsx.tagName).toBe("A");
    expect(xlsx).toHaveAttribute("href", expect.stringContaining("/xlsx"));
    // No longer styled or exposed as a button.
    expect(xlsx).not.toHaveAttribute("role", "button");
  });

  it("'← Edit assumptions' returns to the prefilled form with the draft intact", async () => {
    const user = await generate();
    // Confirm we are on the result screen, then go back to edit assumptions.
    expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    await user.click(screen.getByTestId("edit-assumptions"));
    // The form re-appears with the (default House of Hope) draft preserved.
    expect(screen.getByLabelText(/households/i)).toHaveValue(31798);
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
    expect(screen.queryByTestId("decision-banner")).not.toBeInTheDocument();
  });
});

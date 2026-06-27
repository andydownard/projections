// web/src/pages/RoleView.test.tsx — M7: the read-only share surface is announced.
//
// A board/funder share link (/r/<slug>) renders the verdict verbatim AND a
// read-only degraded notice (I2): a shared link can read/download/export but not
// edit. The notice is announced politely (role="status"), color-independent, and
// never leaks a token — it is static, code-owned copy (SECURITY §15a).
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleView } from "./RoleView";
import { fetchRoleView, type ViewModel } from "../api/viewModel";

const VM: Partial<ViewModel> = {
  reco: { tag: "raise_cash", headline: "Raise cash.", sub: "Capital exceeds funds." },
  metrics: {
    capital: { raw: 517946, display: "$517,946" },
    cashGap: { raw: -254446, display: "($254,446)" },
    breakeven: { raw: 5, display: "Month 5" },
  },
  role: "board",
};

vi.mock("../api/viewModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/viewModel")>();
  return {
    ...actual,
    fetchRoleView: vi.fn(() => Promise.resolve(VM as ViewModel)),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RoleView — read-only share", () => {
  it("renders the read-only degraded notice with role=status", async () => {
    render(<RoleView slug="board-slug" />);
    const notice = await screen.findByTestId("degraded-read-only");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/read-only/i);
  });

  // #203 — the read-only share link a board member/funder opens had ZERO headings
  // of any level. AT users need an h1 naming the projection to orient + navigate.
  it("renders an h1 heading naming the projection (WCAG 1.3.1 / 2.4.6)", async () => {
    vi.mocked(fetchRoleView).mockResolvedValueOnce({ ...(VM as ViewModel), name: "House of Hope" });
    render(<RoleView slug="board-slug" />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/House of Hope/i);
  });

  it("still shows the verdict verbatim alongside the notice", async () => {
    render(<RoleView slug="board-slug" />);
    await waitFor(() => {
      expect(screen.getByTestId("decision-banner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("metric-capital")).toHaveTextContent("$517,946");
    expect(screen.getByText("Raise cash.")).toBeInTheDocument();
  });

  it("does not leak a token or slug into the notice copy", async () => {
    render(<RoleView slug="board-slug" />);
    const notice = await screen.findByTestId("degraded-read-only");
    expect(notice.textContent).not.toMatch(/board-slug/);
    expect(notice.textContent).not.toMatch(/token|secret|bearer/i);
  });

  it("marks the notice icon decorative (meaning in text)", async () => {
    const { container } = render(<RoleView slug="board-slug" />);
    await screen.findByTestId("degraded-read-only");
    const icon = container.querySelector("[data-testid='degraded-read-only'] .degraded__icon");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  // #146 — a bad/expired/removed slug 404s; the page must degrade to a labelled
  // error state instead of spinning "Loading…" forever.
  it("renders a load-failed error state (not an infinite spinner) when the fetch 404s", async () => {
    vi.mocked(fetchRoleView).mockRejectedValueOnce(new Error("GET /r/missing failed: 404"));
    render(<RoleView slug="missing" />);
    expect(await screen.findByTestId("degraded-load-failed")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

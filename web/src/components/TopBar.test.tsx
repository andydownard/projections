import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "./TopBar";

// Component + a11y tests for the single shared top bar (W1). The brand text is
// "Store Projections"; the docked Idea Fab lightbulb is in the tab order, opens
// the existing FeedbackModal on Enter/click, closes on Esc, and restores focus
// to the trigger. The version chip is server-owned; the save-label is a live
// region; meaning carries text, not color alone.

describe("TopBar", () => {
  it("renders as a banner landmark with the 'Store Projections' brand", () => {
    render(<TopBar />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText(/Store Projections/i)).toBeInTheDocument();
    // The old wording is gone.
    expect(screen.queryByText(/Thrift Store Projection\b/i)).not.toBeInTheDocument();
  });

  it("renders the Thriftly logo as a home link on every route", () => {
    render(<TopBar />);
    const home = screen.getByRole("link", { name: /thriftly home/i });
    expect(home).toHaveAttribute("href", "/");
    expect(screen.getByRole("img", { name: /thriftly/i })).toBeInTheDocument();
  });

  it("shows no version chip until a projection loads (no 'model —' placeholder)", () => {
    render(<TopBar />);
    expect(screen.queryByTestId("version-chip")).not.toBeInTheDocument();
  });

  it("renders the server-provided model version verbatim", () => {
    render(<TopBar modelVersion="2.0.0" />);
    expect(screen.getByTestId("version-chip")).toHaveTextContent("model 2.0.0");
  });

  it("the version chip has an accessible label", () => {
    render(<TopBar modelVersion="2.0.0" />);
    expect(screen.getByLabelText(/model version/i)).toBeInTheDocument();
  });

  it("renders the autosave label as a polite live region when saving", () => {
    render(<TopBar saveState="saving" />);
    const label = screen.getByTestId("save-label");
    expect(label).toHaveTextContent("Saving…");
    expect(label).toHaveAttribute("aria-live", "polite");
    expect(label).toHaveAttribute("role", "status");
  });

  it("renders the saved state with explicit text (not color alone)", () => {
    render(<TopBar saveState="saved" />);
    expect(screen.getByTestId("save-label")).toHaveTextContent("All changes saved");
  });

  it("renders a retry-able error state", () => {
    render(<TopBar saveState="error" />);
    expect(screen.getByTestId("save-label")).toHaveTextContent("Save failed — retry");
  });

  it("hides the save label when idle", () => {
    render(<TopBar saveState="idle" />);
    expect(screen.queryByTestId("save-label")).not.toBeInTheDocument();
  });

  it("renders children (e.g. a docked control)", () => {
    render(
      <TopBar>
        <button>Extra</button>
      </TopBar>,
    );
    expect(screen.getByRole("button", { name: /extra/i })).toBeInTheDocument();
  });

  describe("Idea Fab lightbulb (feedback)", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({ support_id: "SUP-ABC123", github_issue_url: null }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is present and focusable (in the tab order) on every route", () => {
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /send feedback/i });
      expect(fab).toBeInTheDocument();
      // No negative tabindex — it is in the natural tab order.
      expect(fab).not.toHaveAttribute("tabindex", "-1");
    });

    it("the modal is closed until the lightbulb is activated", () => {
      render(<TopBar />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens the FeedbackModal on click", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      await user.click(screen.getByRole("button", { name: /send feedback/i }));
      // The Idea Fab opens the modal in idea mode ("Share an idea").
      expect(screen.getByRole("dialog", { name: /share an idea/i })).toBeInTheDocument();
    });

    it("opens the FeedbackModal via the keyboard (focus + Enter)", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /send feedback/i });
      fab.focus();
      expect(fab).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: /share an idea/i })).toBeInTheDocument();
    });

    it("closes on Esc and restores focus to the trigger (a11y)", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /send feedback/i });
      await user.click(fab);
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(fab).toHaveFocus();
    });

    it("restores focus to the trigger when the modal's own Close/Cancel is used", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /send feedback/i });
      await user.click(fab);
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(fab).toHaveFocus();
    });

    it("submits a redacted idea (description-only, support_id back)", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      await user.click(screen.getByRole("button", { name: /send feedback/i }));
      // Idea mode has no title — just a description.
      await user.type(screen.getByLabelText(/description/i), "Add dark mode.");
      await user.click(screen.getByRole("button", { name: /^send$/i }));

      const success = await screen.findByTestId("feedback-success");
      expect(success).toHaveTextContent("SUP-ABC123");
      // The body never carries a slug, token, or financial field (server also
      // enforces this; we assert the client doesn't send them), and an idea
      // carries no title at all.
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.type).toBe("idea");
      expect(body).not.toHaveProperty("title");
      expect(body).not.toHaveProperty("view_slug");
      expect(body).not.toHaveProperty("token");
      expect(JSON.stringify(body)).not.toContain("/p/");
    });
  });
});

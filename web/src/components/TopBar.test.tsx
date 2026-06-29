import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "./TopBar";

// Component + a11y tests for the single shared top bar (W1). The brand text is
// "Store Projections"; the docked "App suggestion" button is in the tab order,
// opens the existing FeedbackModal on Enter/click, closes on Esc, and restores
// focus to the trigger. The model version is no longer displayed (#38); the
// save-label is a live region; meaning carries text, not color alone.

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

  it("never renders a model-version chip (#38 — model_version stays on computed_json, not the UI)", () => {
    // The model version is no longer displayed anywhere. Even with the save chip
    // active, no "model x.y.z" chip is rendered.
    render(<TopBar saveState="saved" />);
    expect(screen.queryByTestId("version-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(/^model\s/i)).not.toBeInTheDocument();
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

  describe("minimal header (sign-in page chrome, SIGNIN-2)", () => {
    it("renders only the wordmark + 'Store Projections' — no idea-fab, spacer, or sign-in", () => {
      render(<TopBar minimal />);
      // Wordmark home link + brand divider remain.
      expect(screen.getByRole("link", { name: /thriftly home/i })).toBeInTheDocument();
      expect(screen.getByText(/Store Projections/i)).toBeInTheDocument();
      // Nothing else: no App-suggestion (idea-fab), no header sign-in button.
      expect(
        screen.queryByRole("button", { name: /app suggestion/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId("idea-fab")).not.toBeInTheDocument();
    });

    it("ignores the save-state chip in minimal mode", () => {
      render(<TopBar minimal saveState="saving" />);
      expect(screen.queryByTestId("save-label")).not.toBeInTheDocument();
    });
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
      const fab = screen.getByRole("button", { name: /app suggestion/i });
      expect(fab).toBeInTheDocument();
      // No negative tabindex — it is in the natural tab order.
      expect(fab).not.toHaveAttribute("tabindex", "-1");
    });

    it("reads as a button with a visible label, not a bare icon", () => {
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /app suggestion/i });
      // A visible text label ("App suggestion") sits beside the lightbulb so the
      // control is obviously tappable — not an unlabelled glyph (#2).
      expect(fab).toHaveTextContent(/app suggestion/i);
      expect(fab).toHaveClass("idea-fab");
    });

    it("the accessible name MATCHES the visible label (WCAG 2.5.3 Label in Name)", () => {
      // QA P2: the old aria-label was "Send feedback" while the visible text read
      // "App suggestion" — a label-in-name mismatch. The accessible name must now be
      // exactly the visible label.
      render(<TopBar />);
      expect(screen.getByTestId("idea-fab")).toHaveAccessibleName("App suggestion");
      expect(screen.queryByRole("button", { name: /send feedback/i })).not.toBeInTheDocument();
    });

    it("the modal is closed until the lightbulb is activated", () => {
      render(<TopBar />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens the FeedbackModal on click", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      await user.click(screen.getByRole("button", { name: /app suggestion/i }));
      // The Idea Fab opens the modal in idea mode — title is "App suggestion" (AS1).
      expect(screen.getByRole("dialog", { name: /app suggestion/i })).toBeInTheDocument();
    });

    it("opens the FeedbackModal via the keyboard (focus + Enter)", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /app suggestion/i });
      fab.focus();
      expect(fab).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: /app suggestion/i })).toBeInTheDocument();
    });

    it("closes on Esc and restores focus to the trigger (a11y)", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      const fab = screen.getByRole("button", { name: /app suggestion/i });
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
      const fab = screen.getByRole("button", { name: /app suggestion/i });
      await user.click(fab);
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(fab).toHaveFocus();
    });

    it("submits a redacted idea — modal closes, no support_id in DOM, body has no title/slug/token", async () => {
      const user = userEvent.setup();
      render(<TopBar />);
      await user.click(screen.getByRole("button", { name: /app suggestion/i }));
      // AS3: the textarea has no label — select by its placeholder.
      await user.type(screen.getByPlaceholderText("Make the app better by\u2026"), "Add dark mode.");
      await user.click(screen.getByRole("button", { name: /^send$/i }));

      // AS4: idea success → modal closes (no feedback-success panel); toast is shown
      // by FeedbackModal's useToast() call (no-op here since no ToastProvider in
      // this render; the FeedbackModal unit tests cover the toast assertion).
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(screen.queryByTestId("feedback-success")).toBeNull();
      // The body never carries a slug, token, financial field, or title (FEEDBACK rule).
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.type).toBe("idea");
      expect(body).not.toHaveProperty("title");
      expect(body).not.toHaveProperty("email");
      expect(body).not.toHaveProperty("view_slug");
      expect(body).not.toHaveProperty("token");
      expect(JSON.stringify(body)).not.toContain("/p/");
    });
  });
});

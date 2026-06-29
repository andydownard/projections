import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackModal } from "./FeedbackModal";
import { Z } from "./sidePanels";

// Mock useToast so idea-path success tests can assert toast calls
// without mounting a full ToastProvider tree. vi.hoisted ensures
// mockShowToast is available when vi.mock() is hoisted to the top.
const mockShowToast = vi.hoisted(() => vi.fn());
vi.mock("./Toast", () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

describe("FeedbackModal", () => {
  it("layers above both side panels (Penny + Inspector) at the documented z-order", () => {
    // Spec B §10 / issue #129: the feedback modal (70/71) sits above the Penny
    // (52) and Override Inspector (51) panels — never under a coexisting side panel.
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const scrim = screen.getByTestId("feedback-modal");
    expect(scrim.style.zIndex).toBe(String(Z.feedbackScrim));
    expect(Z.feedbackScrim).toBeGreaterThan(Z.pennyPanel);
  });

  it("warns against pasting sensitive financial details", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-AAAAAA"} onClose={() => {}} />);
    expect(
      screen.getByText(/don.t (include|paste) sensitive financial/i),
    ).toBeInTheDocument();
  });

  it("shows only the support_id on success — no projection link", async () => {
    const onSubmit = vi.fn(async () => "SUP-7K3Q9X");
    render(<FeedbackModal onSubmit={onSubmit} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText(/title/i), "Break-even off by one");
    await userEvent.type(screen.getByLabelText(/description/i), "Banner vs chart.");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const success = await screen.findByTestId("feedback-success");
    expect(success).toHaveTextContent("SUP-7K3Q9X");
    expect(success.textContent).not.toContain("/p/");
    expect(success.textContent).not.toContain("view_slug");
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Break-even off by one",
      description: "Banner vs chart.",
    });
  });

  it("disables Send until a title is entered", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  // --- styling + a11y (issue #144) ---------------------------------------

  it("renders the styled overlay/panel structure with design-system buttons", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const scrim = screen.getByTestId("feedback-modal");
    expect(scrim).toHaveClass("feedback-modal");
    const panel = scrim.querySelector(".feedback-modal__panel");
    expect(panel).not.toBeNull();
    expect(scrim.querySelector(".feedback-modal__actions")).not.toBeNull();
    // Reuses the shared .btn system rather than bare/unstyled buttons.
    expect(screen.getByRole("button", { name: /send/i })).toHaveClass("btn");
    expect(screen.getByRole("button", { name: /cancel/i })).toHaveClass("btn");
  });

  it("is a labelled modal dialog (role=dialog + aria-modal + aria-labelledby)", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /send feedback/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "feedback-modal-title");
  });

  it("portals to <body> so it never inflates the sticky header", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    expect(screen.getByTestId("feedback-modal").parentElement).toBe(document.body);
  });

  it("autofocuses the first field when it opens (focus enters the dialog)", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    expect(screen.getByLabelText(/title/i)).toHaveFocus();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses when the scrim (outside the panel) is clicked", () => {
    const onClose = vi.fn();
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId("feedback-modal"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does NOT dismiss when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={onClose} />);
    const panel = screen
      .getByTestId("feedback-modal")
      .querySelector(".feedback-modal__panel") as HTMLElement;
    fireEvent.mouseDown(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps Tab focus inside the dialog", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const title = screen.getByLabelText(/title/i);
    // Send is disabled (no title), so Cancel is the last reachable control.
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(title).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it("locks background scroll while open and restores it on close", () => {
    const { unmount } = render(
      <FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  // --- idea variant (App suggestion: AS1–AS5) --------------------------------

  describe("kind=idea", () => {
    beforeEach(() => {
      mockShowToast.mockClear();
    });

    // AS1 — title
    it("modal title is 'App suggestion'", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      const dialog = screen.getByRole("dialog", { name: /app suggestion/i });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAttribute("aria-labelledby", "feedback-modal-title");
    });

    // AS2 — no email field
    it("no email input in the idea path", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      expect(screen.queryByLabelText(/email/i)).toBeNull();
      // Belt-and-suspenders: no <input type="email"> anywhere in the DOM.
      expect(document.querySelector('input[type="email"]'))
        .toBeNull();
    });

    // AS3 — unlabeled textarea + placeholder, no warning
    it("renders a textarea with placeholder 'Make the app better by…' — no visible label, no warning", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      const textarea = screen.getByPlaceholderText("Make the app better by…");
      expect(textarea.tagName).toBe("TEXTAREA");
      // No visible \Description\ label text.
      expect(screen.queryByText("Description")).toBeNull();
      // No financial warning.
      expect(screen.queryByText(/sensitive financial/i)).toBeNull();
    });

    // AS3 — disabled/enabled gate (trimmed)
    it("disables Send when textarea is empty, enables it when non-empty", async () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      const sendBtn = screen.getByRole("button", { name: /send/i });
      expect(sendBtn).toBeDisabled();
      await userEvent.type(
        screen.getByPlaceholderText("Make the app better by…"),
        "An idea.",
      );
      expect(sendBtn).not.toBeDisabled();
    });

    // AS4 — success: close + toast, no support id
    it("on success: closes the modal and shows a toast — no support id in DOM", async () => {
      const onClose = vi.fn();
      const onSubmit = vi.fn(async () => "SUP-IDEA9");
      render(<FeedbackModal kind="idea" onSubmit={onSubmit} onClose={onClose} />);

      await userEvent.type(
        screen.getByPlaceholderText("Make the app better by…"),
        "A donor-thanks export.",
      );
      await userEvent.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(mockShowToast).toHaveBeenCalledWith(
        "Thanks! Your suggestion makes the app better.",
      );
      // No success panel or support id ever shown in the DOM.
      expect(screen.queryByTestId("feedback-success")).toBeNull();
      expect(screen.queryByText("SUP-IDEA9")).toBeNull();
      // Payload: description only — no email (server derives from JWT), no title.
      expect(onSubmit).toHaveBeenCalledWith({ description: "A donor-thanks export." });
    });

    // AS5 — planning-estimates sentence absent
    it("'planning estimates' sentence is absent from the idea flow", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      expect(screen.queryByText(/planning estimates/i)).toBeNull();
    });

    it("is a simple suggestion: no title field and no financial warning", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      expect(screen.queryByLabelText("Title")).toBeNull();
      expect(screen.queryByText(/sensitive financial/i)).toBeNull();
    });

    it("traps Tab focus inside the dialog (a11y preserved)", () => {
      render(<FeedbackModal kind="idea" onSubmit={async () => "SUP-X"} onClose={() => {}} />);
      const cancel = screen.getByRole("button", { name: /cancel/i });
      const textarea = screen.getByPlaceholderText("Make the app better by…");
      // Send is disabled (empty textarea), so Cancel is the last reachable control.
      cancel.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(textarea).toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(cancel).toHaveFocus();
    });
  });
});

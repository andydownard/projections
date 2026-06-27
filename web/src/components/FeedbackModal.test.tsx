import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FeedbackModal } from "./FeedbackModal";

describe("FeedbackModal", () => {
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
});

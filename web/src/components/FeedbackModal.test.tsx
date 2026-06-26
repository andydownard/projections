import { render, screen } from "@testing-library/react";
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

  it("styles every action with .btn and the primary action with .btn--primary", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const send = screen.getByRole("button", { name: /send/i });
    expect(cancel).toHaveClass("btn");
    expect(cancel).not.toHaveClass("btn--primary");
    expect(send).toHaveClass("btn", "btn--primary");
  });

  it("styles the success Close action with .btn .btn--primary", async () => {
    render(<FeedbackModal onSubmit={async () => "SUP-7K3Q9X"} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText(/title/i), "Title");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByTestId("feedback-success");
    const close = screen.getByRole("button", { name: /close/i });
    expect(close).toHaveClass("btn", "btn--primary");
  });

  it("places initial focus on the first field while the primary action is disabled", () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    // Send is the btn--primary action but is disabled until a title exists, so
    // focus correctly enters the dialog at the first field.
    expect(screen.getByLabelText(/title/i)).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("traps Tab focus inside the dialog", async () => {
    render(<FeedbackModal onSubmit={async () => "SUP-X"} onClose={() => {}} />);
    const title = screen.getByLabelText(/title/i);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    // Focus starts on the title field; Shift+Tab from the first focusable wraps
    // to the last focusable control inside the dialog (Cancel — Send is disabled).
    expect(title).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });
});

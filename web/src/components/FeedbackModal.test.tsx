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
});

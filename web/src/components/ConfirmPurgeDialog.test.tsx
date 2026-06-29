import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmPurgeDialog } from "./ConfirmPurgeDialog";

afterEach(() => vi.restoreAllMocks());

describe("ConfirmPurgeDialog — type-to-confirm (DESTRUCTIVE)", () => {
  it("warns that the action cannot be undone", () => {
    render(<ConfirmPurgeDialog name="House of Hope" onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("keeps Delete permanently DISABLED until the exact name is typed", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmPurgeDialog name="House of Hope" onConfirm={onConfirm} onClose={() => {}} />);
    const del = screen.getByTestId("confirm-purge-accept");
    expect(del).toBeDisabled();

    // A near-miss does NOT arm the button.
    await userEvent.type(screen.getByTestId("confirm-purge-input"), "House of hope");
    expect(del).toBeDisabled();

    // The exact name arms it.
    await userEvent.clear(screen.getByTestId("confirm-purge-input"));
    await userEvent.type(screen.getByTestId("confirm-purge-input"), "House of Hope");
    expect(del).toBeEnabled();

    await userEvent.click(del);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a misclick can never purge — clicking the disabled button does nothing", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmPurgeDialog name="Grace Mission" onConfirm={onConfirm} onClose={() => {}} />);
    await userEvent.click(screen.getByTestId("confirm-purge-accept"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel and Escape close without purging", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmPurgeDialog name="Grace" onConfirm={onConfirm} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("confirm-purge-cancel"));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Enter confirms once the name matches", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmPurgeDialog name="Grace" onConfirm={onConfirm} onClose={() => {}} />);
    const input = screen.getByTestId("confirm-purge-input");
    await userEvent.type(input, "Grace{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("trims surrounding whitespace when matching the name", async () => {
    render(<ConfirmPurgeDialog name="Grace Mission" onConfirm={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByTestId("confirm-purge-input"), "  Grace Mission  ");
    expect(screen.getByTestId("confirm-purge-accept")).toBeEnabled();
  });

  it("disables the input and both buttons while busy", () => {
    render(<ConfirmPurgeDialog name="Grace" busy onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId("confirm-purge-input")).toBeDisabled();
    expect(screen.getByTestId("confirm-purge-cancel")).toBeDisabled();
    // Even armed, busy keeps delete disabled (no double-submit).
    expect(screen.getByTestId("confirm-purge-accept")).toBeDisabled();
  });

  it("describes the dialog with the warning for screen readers", () => {
    render(<ConfirmPurgeDialog name="Grace" onConfirm={() => {}} onClose={() => {}} />);
    const dialog = screen.getByTestId("confirm-purge-dialog");
    expect(dialog).toHaveAttribute("aria-describedby", "confirm-purge-warning");
  });
});

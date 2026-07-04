import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

afterEach(() => vi.restoreAllMocks());

describe("ConfirmDialog", () => {
  it("renders the title, body, and a labelled alertdialog", () => {
    render(
      <ConfirmDialog
        title="Move to Trash?"
        confirmLabel="Move to Trash"
        onConfirm={() => {}}
        onClose={() => {}}
      >
        Move <strong>House of Hope</strong> to Trash.
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "confirm-dialog-title");
    expect(screen.getByText("Move to Trash?")).toBeInTheDocument();
    expect(screen.getByText(/House of Hope/)).toBeInTheDocument();
  });

  it("fires onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="Move to Trash" onConfirm={onConfirm} onClose={() => {}}>
        body
      </ConfirmDialog>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onClose on Cancel and on Escape", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="ok" onConfirm={() => {}} onClose={onClose}>
        body
      </ConfirmDialog>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables both buttons while busy", () => {
    render(
      <ConfirmDialog title="t" confirmLabel="ok" busy onConfirm={() => {}} onClose={() => {}}>
        body
      </ConfirmDialog>,
    );
    expect(screen.getByTestId("confirm-accept")).toBeDisabled();
    expect(screen.getByTestId("confirm-cancel")).toBeDisabled();
  });

  it("applies the danger tone to the confirm button when asked", () => {
    render(
      <ConfirmDialog title="t" confirmLabel="ok" tone="danger" onConfirm={() => {}} onClose={() => {}}>
        body
      </ConfirmDialog>,
    );
    expect(screen.getByTestId("confirm-accept").className).toContain("btn--danger");
  });

  it("closes on a backdrop click", () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="ok" onConfirm={() => {}} onClose={onClose}>
        body
      </ConfirmDialog>,
    );
    // Clicking the scrim (the dialog root itself) closes.
    fireEvent.mouseDown(screen.getByTestId("confirm-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close on a backdrop click while busy", () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="ok" busy onConfirm={() => {}} onClose={onClose}>
        body
      </ConfirmDialog>,
    );
    fireEvent.mouseDown(screen.getByTestId("confirm-dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

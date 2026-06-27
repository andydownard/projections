import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SaveConflictModal } from "./SaveConflictModal";

describe("SaveConflictModal", () => {
  it("offers reload / overwrite / save-as-copy", () => {
    render(
      <SaveConflictModal onReload={() => {}} onOverwrite={() => {}} onSaveAsCopy={() => {}} />,
    );
    expect(screen.getByTestId("save-conflict-modal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload latest/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /overwrite/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save as copy/i })).toBeInTheDocument();
  });

  it("wires the recovery callbacks", async () => {
    const onReload = vi.fn();
    const onOverwrite = vi.fn();
    const onSaveAsCopy = vi.fn();
    render(
      <SaveConflictModal
        onReload={onReload}
        onOverwrite={onOverwrite}
        onSaveAsCopy={onSaveAsCopy}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /reload latest/i }));
    await userEvent.click(screen.getByRole("button", { name: /overwrite/i }));
    await userEvent.click(screen.getByRole("button", { name: /save as copy/i }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(onOverwrite).toHaveBeenCalledOnce();
    expect(onSaveAsCopy).toHaveBeenCalledOnce();
  });

  // --- styling + a11y (issue #144) ---------------------------------------

  const noop = () => {};

  it("renders the styled overlay/panel structure with design-system buttons", () => {
    render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    const scrim = screen.getByTestId("save-conflict-modal");
    expect(scrim).toHaveClass("conflict-modal");
    expect(scrim.querySelector(".conflict-modal__panel")).not.toBeNull();
    expect(scrim.querySelector(".conflict-modal__actions")).not.toBeNull();
    // Reload (the safe choice) is the primary button; all use the .btn system.
    expect(screen.getByRole("button", { name: /reload latest/i })).toHaveClass(
      "btn",
      "btn--primary",
    );
    expect(screen.getByRole("button", { name: /overwrite/i })).toHaveClass("btn");
  });

  it("is a labelled alertdialog (role=alertdialog + aria-modal + aria-labelledby)", () => {
    render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    const dialog = screen.getByRole("alertdialog", {
      name: /this projection changed elsewhere/i,
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "conflict-modal-title");
  });

  it("portals to <body> so it overlays the whole app", () => {
    render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    expect(screen.getByTestId("save-conflict-modal").parentElement).toBe(document.body);
  });

  it("autofocuses the safe 'Reload latest' choice", () => {
    render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    expect(screen.getByRole("button", { name: /reload latest/i })).toHaveFocus();
  });

  it("is NOT dismissable by Escape (forced 409 decision)", () => {
    const onReload = vi.fn();
    const onOverwrite = vi.fn();
    const onSaveAsCopy = vi.fn();
    render(
      <SaveConflictModal
        onReload={onReload}
        onOverwrite={onOverwrite}
        onSaveAsCopy={onSaveAsCopy}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("save-conflict-modal")).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    expect(onOverwrite).not.toHaveBeenCalled();
    expect(onSaveAsCopy).not.toHaveBeenCalled();
  });

  it("traps Tab focus inside the dialog", () => {
    render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    const reload = screen.getByRole("button", { name: /reload latest/i });
    const copy = screen.getByRole("button", { name: /save as copy/i });
    copy.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(reload).toHaveFocus();
    reload.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(copy).toHaveFocus();
  });

  it("locks background scroll while open and restores it on close", () => {
    const { unmount } = render(
      <SaveConflictModal onReload={noop} onOverwrite={noop} onSaveAsCopy={noop} />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});

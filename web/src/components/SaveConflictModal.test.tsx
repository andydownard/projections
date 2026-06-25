import { render, screen } from "@testing-library/react";
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
});

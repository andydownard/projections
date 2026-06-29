import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowActionsMenu } from "./RowActionsMenu";

afterEach(() => vi.restoreAllMocks());

describe("RowActionsMenu", () => {
  it("opens the menu and exposes a Move to Trash item", async () => {
    render(<RowActionsMenu name="House of Hope" onTrash={() => {}} />);
    const trigger = screen.getByTestId("row-actions-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /move to trash/i })).toBeInTheDocument();
  });

  it("calls onTrash and closes when the item is chosen", async () => {
    const onTrash = vi.fn();
    render(<RowActionsMenu name="House of Hope" onTrash={onTrash} />);
    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    await userEvent.click(screen.getByTestId("row-action-trash"));
    expect(onTrash).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does NOT bubble clicks to a parent row handler", async () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick} data-testid="row">
        <RowActionsMenu name="House of Hope" onTrash={() => {}} />
      </div>,
    );
    // Opening the menu must not navigate the row.
    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    // Choosing the action must not navigate the row either.
    await userEvent.click(screen.getByTestId("row-action-trash"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes on an outside click", async () => {
    render(
      <div>
        <RowActionsMenu name="House of Hope" onTrash={() => {}} />
        <button type="button" data-testid="outside">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByTestId("row-actions-trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

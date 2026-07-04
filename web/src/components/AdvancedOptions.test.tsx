// web/src/components/AdvancedOptions.test.tsx — the shared, controlled disclosure
// used by every wizard step's advanced group and the Settings tab (Wave 2 Task 2.1).
// Fully controlled: `open` and `onToggle` live in the caller (useWizardState's
// advancedOpen map), never as component-local state — a step-local useState would
// forget the state on every unmount (steps unmount on Next/Back).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdvancedOptions } from "./AdvancedOptions";

describe("AdvancedOptions — controlled disclosure", () => {
  it("renders a <details className='advanced-options'> with a labelled summary", () => {
    render(
      <AdvancedOptions open={false} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const details = screen.getByTestId("advanced-options");
    expect(details.tagName).toBe("DETAILS");
    expect(details).toHaveClass("advanced-options");
    const summary = details.querySelector("summary");
    expect(summary).toHaveClass("advanced-options__summary");
  });

  it("defaults the label to 'Advanced options'", () => {
    render(
      <AdvancedOptions open={false} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    expect(screen.getByText("Advanced options")).toBeInTheDocument();
  });

  it("accepts a custom label", () => {
    render(
      <AdvancedOptions label="More settings" open={false} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    expect(screen.getByText("More settings")).toBeInTheDocument();
  });

  it("shows a count badge counting the children", () => {
    render(
      <AdvancedOptions open={true} onToggle={vi.fn()}>
        <div>Setting A</div>
        <div>Setting B</div>
        <div>Setting C</div>
      </AdvancedOptions>,
    );
    const badge = screen.getByTestId("advanced-options").querySelector(
      ".advanced-options__badge",
    );
    expect(badge).toHaveTextContent("3 settings");
  });

  it("respects open=true: renders open and shows children", () => {
    render(
      <AdvancedOptions open={true} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const details = screen.getByTestId("advanced-options") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText("Setting A")).toBeInTheDocument();
  });

  it("respects open=false: renders closed and hides children", () => {
    render(
      <AdvancedOptions open={false} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const details = screen.getByTestId("advanced-options") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.queryByText("Setting A")).not.toBeInTheDocument();
  });

  it("fires onToggle(true) when the closed summary is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedOptions open={false} onToggle={onToggle}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    await user.click(screen.getByText("Advanced options"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("fires onToggle(false) when the open summary is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedOptions open={true} onToggle={onToggle}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    await user.click(screen.getByText("Advanced options"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("does not let the browser's native <details> toggle fight the controlled prop (preventDefault)", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedOptions open={false} onToggle={onToggle}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    await user.click(screen.getByText("Advanced options"));
    // Since the parent never re-renders with a new `open` prop in this test, the
    // DOM should still read closed — the click must not have flipped the native
    // open attribute out from under the controlled prop.
    const details = screen.getByTestId("advanced-options") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("keyboard: Enter on the focused summary toggles", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedOptions open={false} onToggle={onToggle}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const summary = screen.getByText("Advanced options").closest("summary")!;
    summary.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("keyboard: Space on the focused summary toggles", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedOptions open={true} onToggle={onToggle}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const summary = screen.getByText("Advanced options").closest("summary")!;
    summary.focus();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("the summary is keyboard-focusable", () => {
    render(
      <AdvancedOptions open={false} onToggle={vi.fn()}>
        <div>Setting A</div>
      </AdvancedOptions>,
    );
    const summary = screen.getByText("Advanced options").closest("summary")!;
    summary.focus();
    expect(summary).toHaveFocus();
  });
});

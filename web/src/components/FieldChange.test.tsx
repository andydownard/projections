// web/src/components/FieldChange.test.tsx — PE7 (issue #126), Spec B §3.
//
// The signature per-field change affordance: (1) recent change = current value
// prominent + a highlight badge ("changed by Penny", ICON + TEXT, never color
// alone) that persists until acknowledged/superseded; (2) the previous value
// shown subtly ("was 6%"); (3) a small per-field undo icon that reverts THAT
// field — issuing a forward PATCH (the parent's onUndo) → a new revision, never
// erasing history; after undo the field shows the new recent-change state
// ("reverted — was 8%"). a11y: keyboard-operable undo, announced, not color-only.
//
// NO client math: `current`/`previous` are the server's display strings, rendered
// verbatim (the "was X" is derived from the server changed[] was→now / prior
// revision display, never computed here).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FieldChange } from "./FieldChange";

describe("FieldChange — recent change (prominent, icon + text, not color alone)", () => {
  it("renders the current value prominently by default", () => {
    render(<FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" />);
    expect(screen.getByTestId("field-change-current")).toHaveTextContent("8.0%");
  });

  it("does not render its own current value when the host already shows it (showCurrent=false)", () => {
    render(
      <FieldChange
        label="Donor share, Year 1"
        current="8.0%"
        previous="6.0%"
        showCurrent={false}
      />,
    );
    expect(screen.queryByTestId("field-change-current")).not.toBeInTheDocument();
    // …but the badge + "was" still render (the change is still surfaced).
    expect(screen.getByTestId("field-change-badge")).toBeInTheDocument();
    expect(screen.getByTestId("field-change-was")).toHaveTextContent("was 6.0%");
  });

  it("shows a 'changed by Penny' badge carrying BOTH an icon and text (never color alone)", () => {
    render(
      <FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" by="penny" />,
    );
    const badge = screen.getByTestId("field-change-badge");
    // Text meaning, not just a color.
    expect(badge).toHaveTextContent(/changed by penny/i);
    // An icon that is hidden from the a11y tree (the TEXT carries the meaning).
    const icon = screen.getByTestId("field-change-icon");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("attributes a manual change as 'Changed' (no 'by Penny')", () => {
    render(<FieldChange label="Rent, Year 1" current="$92,700" previous="$90,000" by="user" />);
    const badge = screen.getByTestId("field-change-badge");
    expect(badge).toHaveTextContent(/changed/i);
    expect(badge).not.toHaveTextContent(/penny/i);
  });
});

describe("FieldChange — previous value (subtle 'was X')", () => {
  it("renders the previous value as a subtle 'was X' next to the field", () => {
    render(<FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" />);
    expect(screen.getByTestId("field-change-was")).toHaveTextContent("was 6.0%");
  });
});

describe("FieldChange — per-field undo (forward PATCH via onUndo)", () => {
  it("renders a keyboard-operable undo control with an accessible name naming the field + restore value", async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <FieldChange
        label="Donor share, Year 1"
        current="8.0%"
        previous="6.0%"
        by="penny"
        onUndo={onUndo}
      />,
    );
    const undo = screen.getByTestId("field-change-undo");
    expect(undo.tagName).toBe("BUTTON");
    expect(undo).toHaveAccessibleName(/undo.*donor share, year 1.*6\.0%/i);

    // Keyboard operable: focus + Enter activates it.
    undo.focus();
    expect(undo).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("clicking undo invokes onUndo (the parent issues the forward PATCH)", async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" onUndo={onUndo} />,
    );
    await user.click(screen.getByTestId("field-change-undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("omits the undo control when no onUndo is provided (display-only)", () => {
    render(<FieldChange label="Net profit, Year 1" current="$46,000" previous="$40,000" />);
    expect(screen.queryByTestId("field-change-undo")).not.toBeInTheDocument();
  });

  it("disables undo while a revert is in flight (busy)", () => {
    render(
      <FieldChange
        label="Donor share, Year 1"
        current="8.0%"
        previous="6.0%"
        onUndo={vi.fn()}
        busy
      />,
    );
    expect(screen.getByTestId("field-change-undo")).toBeDisabled();
  });

  it("after an undo the field shows the NEW recent-change state ('reverted — was 8%'), re-undoable", () => {
    // The parent re-renders with reverted=true and the now-previous value swapped.
    render(
      <FieldChange
        label="Donor share, Year 1"
        current="6.0%"
        previous="8.0%"
        by="penny"
        reverted
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByTestId("field-change-badge")).toHaveTextContent(/reverted/i);
    expect(screen.getByTestId("field-change-was")).toHaveTextContent("was 8.0%");
    // Still re-undoable (the undo control persists).
    expect(screen.getByTestId("field-change-undo")).toBeInTheDocument();
  });
});

describe("FieldChange — a11y announcement + acknowledge persistence", () => {
  it("announces the change in a polite live region (not color-only)", () => {
    render(
      <FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" by="penny" />,
    );
    const live = screen.getByTestId("field-change-announce");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(/donor share, year 1/i);
    expect(live).toHaveTextContent(/8\.0%/);
    expect(live).toHaveTextContent(/6\.0%/);
  });

  it("persists the highlight until acknowledged, then hides the badge (value stays)", async () => {
    const onAcknowledge = vi.fn();
    const user = userEvent.setup();
    render(
      <FieldChange
        label="Donor share, Year 1"
        current="8.0%"
        previous="6.0%"
        by="penny"
        onAcknowledge={onAcknowledge}
      />,
    );
    expect(screen.getByTestId("field-change-badge")).toBeInTheDocument();
    await user.click(screen.getByTestId("field-change-dismiss"));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    // Badge gone (acknowledged); the current value remains on screen.
    expect(screen.queryByTestId("field-change-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("field-change-current")).toHaveTextContent("8.0%");
  });

  it("re-shows the highlight when the change is superseded (new current/previous)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FieldChange label="Donor share, Year 1" current="8.0%" previous="6.0%" by="penny" />,
    );
    await user.click(screen.getByTestId("field-change-dismiss"));
    expect(screen.queryByTestId("field-change-badge")).not.toBeInTheDocument();
    // A NEW change to the same field re-arms the highlight.
    rerender(
      <FieldChange label="Donor share, Year 1" current="10.0%" previous="8.0%" by="penny" />,
    );
    expect(screen.getByTestId("field-change-badge")).toBeInTheDocument();
    expect(screen.getByTestId("field-change-was")).toHaveTextContent("was 8.0%");
  });
});

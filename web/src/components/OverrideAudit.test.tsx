// web/src/components/OverrideAudit.test.tsx — the relocated overrides audit + the
// focused override-comment capture (Epic G2, decision #42, #266). The standalone
// Override Inspector panel is eliminated; its function lives here, dropped into
// Penny's drawer + the KPIs tab. Verbatim rendering (no client math), per-pin reset,
// the stale-upstream flag, and a labelled, keyboard-reachable comment prompt.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverrideAudit, type OverrideAuditItem } from "./OverrideAudit";

const OVERRIDES: OverrideAuditItem[] = [
  { node: "payroll", year: 1, label: "Payroll, Year 1", value: "$120,000", calculated: "$140,000" },
  { node: "rent", year: 2, label: "Rent, Year 2", value: "$48,000", note: "signed lease at this rate", stale: true },
];

afterEach(() => vi.clearAllMocks());

describe("OverrideAudit — audit list (verbatim, no math)", () => {
  it("renders each override's label + server display string verbatim", () => {
    render(<OverrideAudit overrides={OVERRIDES} />);
    const audit = screen.getByTestId("override-audit");
    expect(within(audit).getByText("Payroll, Year 1")).toBeInTheDocument();
    expect(within(audit).getByText("$120,000")).toBeInTheDocument();
    expect(within(audit).getByText(/was computed \$140,000/)).toBeInTheDocument();
    expect(within(audit).getByText("Rent, Year 2")).toBeInTheDocument();
    expect(within(audit).getByText("$48,000")).toBeInTheDocument();
  });

  it("renders the stored justification note verbatim", () => {
    render(<OverrideAudit overrides={OVERRIDES} />);
    expect(screen.getByTestId("override-note-rent-y2")).toHaveTextContent("signed lease at this rate");
  });

  it("flags a stale-upstream pin in text (not color alone)", () => {
    render(<OverrideAudit overrides={OVERRIDES} />);
    expect(screen.getByTestId("override-stale-rent-y2")).toHaveTextContent(/upstream input changed/i);
  });

  it("shows an empty state when nothing is overridden", () => {
    render(<OverrideAudit overrides={[]} />);
    expect(screen.getByTestId("override-audit-empty")).toBeInTheDocument();
  });

  it("is navigable as a list with the section labelled by its heading (a11y)", () => {
    render(<OverrideAudit overrides={OVERRIDES} />);
    const audit = screen.getByTestId("override-audit");
    expect(audit).toHaveAttribute("aria-labelledby");
    expect(within(audit).getByRole("list")).toBeInTheDocument();
    expect(within(audit).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("OverrideAudit — reset pin (forward edit)", () => {
  it("offers reset only when onResetPin is provided, and calls it with (node, year)", async () => {
    const onResetPin = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<OverrideAudit overrides={OVERRIDES} />);
    expect(screen.queryByTestId("override-reset-payroll-y1")).not.toBeInTheDocument();

    rerender(<OverrideAudit overrides={OVERRIDES} onResetPin={onResetPin} />);
    await user.click(screen.getByTestId("override-reset-payroll-y1"));
    expect(onResetPin).toHaveBeenCalledWith("payroll", 1);
  });
});

describe("OverrideAudit — comment capture (the relocated justification)", () => {
  it("raises onComment(node, year) from the per-pin 'Add justification' button", async () => {
    const onComment = vi.fn();
    const user = userEvent.setup();
    render(<OverrideAudit overrides={OVERRIDES} onComment={onComment} />);
    await user.click(screen.getByTestId("override-comment-payroll-y1"));
    expect(onComment).toHaveBeenCalledWith("payroll", 1);
  });

  it("labels the button 'Edit justification' when a note already exists", () => {
    render(<OverrideAudit overrides={OVERRIDES} onComment={vi.fn()} />);
    expect(screen.getByTestId("override-comment-rent-y2")).toHaveTextContent(/edit justification/i);
    expect(screen.getByTestId("override-comment-payroll-y1")).toHaveTextContent(/add justification/i);
  });

  it("renders a labelled, focused 'why did you override {label}?' prompt and saves the note", async () => {
    const onSubmitComment = vi.fn();
    const user = userEvent.setup();
    render(
      <OverrideAudit
        overrides={OVERRIDES}
        commentFor={{ node: "payroll", year: 1, label: "Payroll, Year 1" }}
        onSubmitComment={onSubmitComment}
      />,
    );
    const form = screen.getByTestId("override-comment-form");
    // The prompt is the focused, labelled textarea (keyboard-reachable a11y).
    const input = within(form).getByLabelText(/why did you override payroll, year 1\?/i);
    expect(input).toBe(screen.getByTestId("override-comment-input"));
    await waitFor(() => expect(input).toHaveFocus());

    await user.type(input, "we already signed two hires");
    await user.click(screen.getByTestId("override-comment-save"));
    expect(onSubmitComment).toHaveBeenCalledWith("payroll", 1, "we already signed two hires");
  });

  it("seeds the prompt with the existing note and dismisses on Cancel", async () => {
    const onCancelComment = vi.fn();
    const user = userEvent.setup();
    render(
      <OverrideAudit
        overrides={OVERRIDES}
        commentFor={{ node: "rent", year: 2, label: "Rent, Year 2" }}
        commentInitial="signed lease at this rate"
        onCancelComment={onCancelComment}
      />,
    );
    expect(screen.getByTestId("override-comment-input")).toHaveValue("signed lease at this rate");
    await user.click(screen.getByTestId("override-comment-cancel"));
    expect(onCancelComment).toHaveBeenCalled();
  });

  it("surfaces a 'needs justification' affordance when a guardrail requires a note", () => {
    render(
      <OverrideAudit
        overrides={[{ node: "payroll", year: 1, label: "Payroll, Year 1", value: "$120,000", needsNote: true }]}
      />,
    );
    expect(screen.getByTestId("override-needs-note-payroll-y1")).toHaveTextContent(/needs a justification/i);
  });
});

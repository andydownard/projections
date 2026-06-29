// web/src/components/NumberField.test.tsx — controlled numeric input primitive.
//
// DISPLAY FORMATTING ONLY — the component parses/formats strings for presentation.
// It does NO financial arithmetic; every onChange value originates from user input.
// Covers Owner Decision 10/17 (no commas, leading-zero "0", native spinner, etc.).
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NumberField } from "./NumberField";

describe("NumberField", () => {
  // --- display formatting ---

  it("displays thousands-separator commas when value > 999", () => {
    render(<NumberField value={12500} onChange={vi.fn()} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("12,500");
  });

  it("displays large values (6 digits) with commas without truncation", () => {
    render(<NumberField value={123456} onChange={vi.fn()} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("123,456");
  });

  it("leaves sub-thousand values ungrouped", () => {
    render(<NumberField value={999} onChange={vi.fn()} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("999");
  });

  it("null value displays as empty string — not '0'", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("");
  });

  // --- no native spinner ---

  it("type=text and inputMode=numeric (kills the native spinner)", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Amount" />);
    const input = screen.getByLabelText("Amount");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");
  });

  it("inputMode=decimal when decimals > 0", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Amount" decimals={2} />);
    expect(screen.getByLabelText("Amount")).toHaveAttribute("inputmode", "decimal");
  });

  // --- onChange / clearing ---

  it("clearing a valued field calls onChange with null", async () => {
    const onChange = vi.fn();
    render(<NumberField value={500} onChange={onChange} aria-label="Amount" />);
    await userEvent.clear(screen.getByLabelText("Amount"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("onChange is called with the parsed numeric value when typing", async () => {
    const onChange = vi.fn();
    render(<NumberField value={null} onChange={onChange} aria-label="Amount" />);
    await userEvent.type(screen.getByLabelText("Amount"), "42");
    expect(onChange).toHaveBeenLastCalledWith(42);
  });

  // --- no leading zeros ---

  it("strips leading zeros: typing '07' results in value 7, not '07'", async () => {
    const onChange = vi.fn();
    render(<NumberField value={null} onChange={onChange} aria-label="Amount" />);
    await userEvent.type(screen.getByLabelText("Amount"), "07");
    // The parsed value is always an integer; no leading-zero call
    const allCalls = onChange.mock.calls.map((args) => args[0]);
    expect(allCalls).not.toContain(7 + ""); // not the string "7"
    // Last call is numeric 7 (the "0" is parsed to 0 first, then "07" → 7)
    const numericCalls = allCalls.filter((v) => typeof v === "number");
    expect(numericCalls.at(-1)).toBe(7);
  });

  // --- decimals=0: rejects fractions ---

  it("decimals=0 (default): onChange never receives a non-integer numeric value", async () => {
    const onChange = vi.fn();
    render(<NumberField value={null} onChange={onChange} aria-label="Amount" decimals={0} />);
    await userEvent.type(screen.getByLabelText("Amount"), "12.5");
    const nonInteger = onChange.mock.calls
      .map((args) => args[0])
      .filter((v) => typeof v === "number" && !Number.isInteger(v));
    expect(nonInteger).toHaveLength(0);
  });

  // --- decimals=2: allows fractional input ---

  it("decimals=2: allows two decimal places", async () => {
    const onChange = vi.fn();
    render(<NumberField value={null} onChange={onChange} aria-label="Amount" decimals={2} />);
    await act(async () => {
      await userEvent.type(screen.getByLabelText("Amount"), "1.50");
    });
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  // --- unit rendering ---

  it("suffix unit renders adjacent to the input (after)", () => {
    const { container } = render(
      <NumberField value={1000} onChange={vi.fn()} aria-label="Sqft" unit="sqft" unitPosition="suffix" />,
    );
    const wrapper = container.firstElementChild!;
    const children = Array.from(wrapper.children);
    const inputIdx = children.findIndex((el) => el.tagName === "INPUT");
    const unitIdx = children.findIndex((el) => el.textContent === "sqft");
    expect(inputIdx).toBeGreaterThanOrEqual(0);
    expect(unitIdx).toBe(inputIdx + 1);
  });

  it("prefix unit renders adjacent to the input (before)", () => {
    const { container } = render(
      <NumberField value={500} onChange={vi.fn()} aria-label="Cost" unit="$" unitPosition="prefix" />,
    );
    const wrapper = container.firstElementChild!;
    const children = Array.from(wrapper.children);
    const inputIdx = children.findIndex((el) => el.tagName === "INPUT");
    const unitIdx = children.findIndex((el) => el.textContent === "$");
    expect(unitIdx).toBe(inputIdx - 1);
  });

  it("default unit position is suffix", () => {
    const { container } = render(
      <NumberField value={0} onChange={vi.fn()} aria-label="Pct" unit="%" />,
    );
    const wrapper = container.firstElementChild!;
    const children = Array.from(wrapper.children);
    const inputIdx = children.findIndex((el) => el.tagName === "INPUT");
    const unitIdx = children.findIndex((el) => el.textContent === "%");
    expect(unitIdx).toBe(inputIdx + 1);
  });

  // --- negative values ---

  it("allowNegative=false (default): negative input not passed to onChange", async () => {
    const onChange = vi.fn();
    render(<NumberField value={null} onChange={onChange} aria-label="Amount" />);
    await userEvent.type(screen.getByLabelText("Amount"), "-5");
    const negativeCalls = onChange.mock.calls
      .map((args) => args[0])
      .filter((v) => typeof v === "number" && v < 0);
    expect(negativeCalls).toHaveLength(0);
  });

  it("allowNegative=true: accepts and passes negative value to onChange", async () => {
    const onChange = vi.fn();
    render(
      <NumberField value={null} onChange={onChange} aria-label="Amount" allowNegative />,
    );
    await userEvent.type(screen.getByLabelText("Amount"), "-5");
    expect(onChange).toHaveBeenCalledWith(-5);
  });

  // --- a11y ---

  it("aria-label is applied to the input element", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Square footage" />);
    expect(screen.getByLabelText("Square footage")).toBeInTheDocument();
  });

  it("id prop is forwarded to the input for label association", () => {
    render(<NumberField value={null} onChange={vi.fn()} id="sqft-field" aria-label="Sqft" />);
    expect(screen.getByLabelText("Sqft")).toHaveAttribute("id", "sqft-field");
  });

  // --- alignment + tabular-nums ---

  it("has right-align and tabular-nums (.num) class by default", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Amount" />);
    expect(screen.getByLabelText("Amount")).toHaveClass("num");
  });

  it("align=left removes the .num class", () => {
    render(<NumberField value={null} onChange={vi.fn()} aria-label="Amount" align="left" />);
    expect(screen.getByLabelText("Amount")).not.toHaveClass("num");
  });
});

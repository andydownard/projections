// web/src/components/NumberField.tsx — controlled numeric input primitive (v2 redesign).
//
// DISPLAY FORMATTING ONLY — parses/formats strings for presentation; does NO
// financial arithmetic (PRD §13, SERVER rule). The server remains the single
// math authority; this component only converts between a raw number and a
// human-readable string for data entry. All financial figures come from and
// return to the server via the projection PATCH flow.
//
// Owner Decision 10/17: fixes missing thousands commas, leading-zero "0",
// native spinner, units not adjacent, and 6-digit truncation.
import { useEffect, useRef, useState } from "react";

import { formatCount } from "../format";

export interface NumberFieldProps {
  value: number | null;
  onChange: (v: number | null) => void;
  /** Optional unit label (e.g. "sqft", "%", "$", "/donation"). */
  unit?: string;
  /** "prefix" = unit before the input (e.g. "$500"); "suffix" (default) = after. */
  unitPosition?: "prefix" | "suffix";
  /** Decimal places to allow (default 0 = whole numbers only). */
  decimals?: number;
  /** Minimum accepted value (values below are silently rejected). */
  min?: number;
  /** Whether to allow negative input (default false). */
  allowNegative?: boolean;
  /** Whether to show thousands-separator commas (default true). */
  thousands?: boolean;
  /** Text alignment (default "right" — matches .num tabular-nums convention). */
  align?: "left" | "right";
  placeholder?: string;
  "aria-label"?: string;
  id?: string;
}

// Format a number value for display in the input.
// Uses formatCount (the ONE shared grouping formatter, #18) for the integer part.
// Display formatting only — derives NO projection figure.
function formatDisplay(
  value: number | null,
  thousands: boolean,
  decimals: number,
): string {
  if (value === null || !Number.isFinite(value)) return "";

  if (decimals === 0) {
    const rounded = Math.round(value);
    return thousands ? formatCount(rounded) : String(rounded);
  }

  // decimals > 0: fix to decimal places, then add thousands to the integer part.
  const fixed = value.toFixed(decimals);
  const [rawInt, decPart] = fixed.split(".");
  const negative = rawInt.startsWith("-");
  const absInt = parseInt(rawInt.replace("-", ""), 10);
  const intFormatted = thousands ? formatCount(absInt) : String(absInt);
  return `${negative ? "-" : ""}${intFormatted}${decPart !== undefined ? "." + decPart : ""}`;
}

// Parse a user-typed string to a number, stripping thousands commas.
// Returns null for empty/invalid; never returns a fraction when decimals=0.
function parseInput(raw: string, decimals: number): number | null {
  // Strip thousands commas before parsing
  const stripped = raw.replace(/,/g, "").trim();

  if (stripped === "" || stripped === "-" || stripped === ".") return null;

  // When whole-numbers-only: reject any string containing a decimal point
  if (decimals === 0 && stripped.includes(".")) return null;

  const num = decimals > 0 ? parseFloat(stripped) : parseInt(stripped, 10);
  if (!Number.isFinite(num)) return null;

  // Extra guard: integers only when decimals=0
  if (decimals === 0 && !Number.isInteger(num)) return null;

  return num;
}

export function NumberField({
  value,
  onChange,
  unit,
  unitPosition = "suffix",
  decimals = 0,
  min,
  allowNegative = false,
  thousands = true,
  align = "right",
  placeholder,
  "aria-label": ariaLabel,
  id,
}: NumberFieldProps) {
  const focused = useRef(false);
  const [localStr, setLocalStr] = useState<string>(() =>
    formatDisplay(value, thousands, decimals),
  );

  // Sync the displayed string when the external value changes and the user is
  // not mid-edit. This keeps the field consistent with e.g. an undo/reset.
  useEffect(() => {
    if (!focused.current) {
      setLocalStr(formatDisplay(value, thousands, decimals));
    }
  }, [value, thousands, decimals]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;

    // Empty field → null
    if (raw === "") {
      setLocalStr("");
      onChange(null);
      return;
    }

    // Reject the "." character entirely when decimals=0 (prevents "12." from
    // appearing and prevents fractional values from reaching onChange).
    if (decimals === 0 && raw.includes(".")) {
      // Do not update localStr — React will restore the controlled value,
      // effectively swallowing the "." keystroke.
      return;
    }

    const num = parseInput(raw, decimals);

    if (num === null) {
      // Invalid intermediate input (e.g. bare "-") — track the raw string so
      // the user can continue typing, but don't fire onChange yet.
      setLocalStr(raw);
      return;
    }

    if (!allowNegative && num < 0) {
      // Block negative: do not update
      return;
    }

    if (min !== undefined && num < min) {
      // Below minimum: do not update
      return;
    }

    if (decimals === 0) {
      // Whole numbers: reformat immediately to strip leading zeros and add
      // thousands commas. This is a display-string decision, not arithmetic.
      setLocalStr(formatDisplay(num, thousands, decimals));
    } else {
      // Decimals > 0: preserve the user's raw typed string while they type
      // (reformatting mid-entry would clobber the in-progress decimal point).
      // On blur the value is canonicalized via formatDisplay.
      setLocalStr(raw);
    }
    onChange(num);
  }

  function handleFocus() {
    focused.current = true;
  }

  function handleBlur() {
    focused.current = false;
    // On blur, reformat to match the last valid value (or empty if null).
    setLocalStr(formatDisplay(value, thousands, decimals));
  }

  const inputClass = [
    "number-field__input",
    align === "right" ? "num" : "number-field__input--left",
  ]
    .filter(Boolean)
    .join(" ");

  const input = (
    <input
      id={id}
      type="text"
      inputMode={decimals > 0 ? "decimal" : "numeric"}
      value={localStr}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={inputClass}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );

  if (!unit) {
    return <div className="number-field">{input}</div>;
  }

  const unitEl = (
    <span className="number-field__unit" aria-hidden="true">
      {unit}
    </span>
  );

  return (
    <div className="number-field number-field--with-unit">
      {unitPosition === "prefix" ? (
        <>
          {unitEl}
          {input}
        </>
      ) : (
        <>
          {input}
          {unitEl}
        </>
      )}
    </div>
  );
}

export default NumberField;

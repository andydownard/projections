// web/src/components/FieldChange.tsx — PE7 (issue #126), Spec B §3.
//
// The signature per-field change affordance, reusable on the detail-page editable
// cells, the cost-schedule editor, and (later, PE8) the wizard fields:
//
//   1. RECENT CHANGE  — the current value is visually prominent next to a brief
//      highlight badge ("Changed by Penny", ICON + TEXT, never color alone). The
//      badge persists for the session until acknowledged (the × dismiss) or
//      superseded (a newer change to the same field re-arms it).
//   2. PREVIOUS VALUE — shown subtly beside the field as "was 6.0%".
//   3. PER-FIELD UNDO — a small undo icon that reverts THAT one field. Activating
//      it calls `onUndo`; the PARENT issues a normal forward PATCH (Bearer +
//      If-Match) setting the field back to its previous value → recompute →
//      version++ → a NEW revision (actor:penny_undo / user_undo). It NEVER rewrites
//      or deletes the revision that introduced the change. After an undo the parent
//      re-renders with `reverted` so the field shows the new recent-change state
//      ("Reverted — was 8.0%") and is itself re-undoable.
//
// NO client math / formatting (PRD §13, CLAUDE.md hard rule): `current`/`previous`
// are the SERVER's display strings, rendered verbatim. The "was X" is derived from
// the server changed[] was→now diff (or the prior revision's computed_json display
// string) — this component never computes a number.
//
// a11y: the undo is a real <button> (keyboard focusable + Enter/Space), the change
// is announced in a polite live region, and meaning is carried by an icon + TEXT
// (never color alone). Styles are inline/component-local (the PE1 pattern) so new
// elements never collide with the shared tokens.css across parallel agents.
import { useEffect, useState, type CSSProperties } from "react";

export type FieldChangeActor = "penny" | "user";

export interface FieldChangeProps {
  /** Accessible field name for the announcement + undo label (e.g. "Donor share, Year 1"). */
  label: string;
  /** The current value — the SERVER's display string, rendered verbatim (prominent). */
  current: string;
  /** The previous value — the SERVER's display string, rendered verbatim ("was X"). */
  previous: string;
  /** Who made the change. "penny" → "by Penny" attribution; default "user". */
  by?: FieldChangeActor;
  /** True when THIS change is itself an undo → badge reads "Reverted" (re-undoable). */
  reverted?: boolean;
  /** Per-field undo. The parent issues the forward PATCH; omit to render display-only. */
  onUndo?: () => void;
  /** Acknowledge/dismiss the highlight. Optional — the badge also self-dismisses. */
  onAcknowledge?: () => void;
  /** Disables the undo control while a revert PATCH is in flight. */
  busy?: boolean;
  /** Render the prominent current value here (default). Hosts that already show the
   *  value (a cell button / an input) pass false and apply their own prominence. */
  showCurrent?: boolean;
}

const BRAND = "#35644f";

const wrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.375rem",
  flexWrap: "wrap",
  fontSize: "0.8125rem",
  lineHeight: 1.3,
};

const currentStyle: CSSProperties = {
  fontWeight: 700,
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: "0.05rem 0.4rem",
  borderRadius: "999px",
  border: `1px solid ${BRAND}`,
  background: "rgba(53, 100, 79, 0.08)",
  color: BRAND,
  fontSize: "0.6875rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const wasStyle: CSSProperties = {
  color: "#6b7280",
  fontSize: "0.75rem",
  fontStyle: "italic",
};

const iconBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "1.4rem",
  height: "1.4rem",
  padding: 0,
  border: "1px solid transparent",
  borderRadius: "0.3rem",
  background: "transparent",
  color: BRAND,
  cursor: "pointer",
  lineHeight: 1,
};

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** A small icon glyph. Reverted shows an undo-arrow; a change shows a sparkle.
 *  aria-hidden — the adjacent TEXT carries the meaning (never color alone). */
function ChangeIcon({ reverted }: { reverted?: boolean }) {
  return (
    <svg
      data-testid="field-change-icon"
      aria-hidden="true"
      focusable="false"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {reverted ? (
        // curved undo arrow
        <>
          <path d="M3 8a5 5 0 1 1 1.46 3.54" />
          <path d="M3 4v4h4" />
        </>
      ) : (
        // four-point sparkle
        <path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 14.5 6.6 8.4 2.5 7l4.1-1.4z" />
      )}
    </svg>
  );
}

export function FieldChange({
  label,
  current,
  previous,
  by = "user",
  reverted = false,
  onUndo,
  onAcknowledge,
  busy = false,
  showCurrent = true,
}: FieldChangeProps) {
  // The highlight persists until acknowledged (dismissed) OR superseded. A new
  // change to the same field (new current/previous/reverted) re-arms it.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
  }, [current, previous, reverted]);

  const verb = reverted ? "Reverted" : "Changed";
  const badgeText = by === "penny" ? `${verb} by Penny` : verb;
  const announce =
    `${label} ${reverted ? "reverted" : "changed"}` +
    `${by === "penny" ? " by Penny" : ""}. Now ${current}; was ${previous}.`;

  function handleDismiss() {
    setDismissed(true);
    onAcknowledge?.();
  }

  return (
    <span
      data-testid="field-change"
      data-actor={by}
      data-reverted={reverted || undefined}
      style={wrapStyle}
    >
      {showCurrent && (
        <span data-testid="field-change-current" style={currentStyle}>
          {current}
        </span>
      )}

      {!dismissed && (
        <span data-testid="field-change-badge" style={badgeStyle}>
          <ChangeIcon reverted={reverted} />
          <span>{badgeText}</span>
        </span>
      )}

      <span data-testid="field-change-was" style={wasStyle}>
        was {previous}
      </span>

      {onUndo && (
        <button
          type="button"
          data-testid="field-change-undo"
          onClick={onUndo}
          disabled={busy}
          aria-label={`Undo change to ${label}, restore ${previous}`}
          style={{ ...iconBtnStyle, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
        >
          <ChangeIcon reverted />
          <span style={srOnly}>Undo</span>
        </button>
      )}

      {!dismissed && (
        <button
          type="button"
          data-testid="field-change-dismiss"
          onClick={handleDismiss}
          aria-label={`Dismiss change highlight for ${label}`}
          style={{ ...iconBtnStyle, color: "#6b7280", width: "1.2rem", height: "1.2rem" }}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}

      {/* Polite live region: SR users hear the change without relying on color. */}
      <span
        role="status"
        aria-live="polite"
        data-testid="field-change-announce"
        style={srOnly}
      >
        {announce}
      </span>
    </span>
  );
}

export default FieldChange;

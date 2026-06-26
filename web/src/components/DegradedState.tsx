// web/src/components/DegradedState.tsx — the one accessible error/degraded surface.
//
// ENGINEERING_HANDOFF I2 (AC: "each designed + handled"): rent-failed,
// low-confidence, location-not-found, 409, offline, stale, read-only, AI opt-out.
//
// A11y rules (DESIGN_PROMPT a11y / PRD §13):
//   - meaning never relies on color alone: a TEXT title carries the severity and a
//     decorative icon is aria-hidden.
//   - hard errors announce assertively (role="alert"); degraded-but-usable notices
//     announce politely (role="status") so the page keeps working.
//   - the region has an accessible name (aria-label = title) and a stable testid +
//     data-kind so each state is independently QA-screenshotable at 1440/768/375.
//
// This component renders NOTHING computed — it is pure presentation of a known state.

export type DegradedKind =
  | "rent-failed"
  | "low-confidence"
  | "location-not-found"
  | "conflict-409"
  | "offline"
  | "stale"
  | "read-only"
  | "ai-opt-out";

export type Severity = "error" | "warning" | "info";

interface DegradedDef {
  title: string;
  body: string;
  severity: Severity;
  /** A short, color-independent glyph; the meaning lives in `title`, not here. */
  icon: string;
}

// The eight designed states. Errors are blocking-but-recoverable; warnings/info are
// "the surface degrades, never crashes" (ProjectionDetail.tsx contract).
export const DEGRADED_STATES: Record<DegradedKind, DegradedDef> = {
  "rent-failed": {
    title: "Rent estimate unavailable",
    body: "We couldn't fetch a market rent for this location. Enter rent manually to continue — every other number still computes.",
    severity: "error",
    icon: "!",
  },
  "low-confidence": {
    title: "Low-confidence estimate",
    body: "This figure is based on weak or benchmark sources. Attach evidence to raise its confidence; the decision shows its sensitivity.",
    severity: "warning",
    icon: "~",
  },
  "location-not-found": {
    title: "Location not found",
    body: "We couldn't match that address to a trade area. Check the spelling or enter the trade-area inputs manually.",
    severity: "error",
    icon: "?",
  },
  "conflict-409": {
    title: "This projection changed elsewhere",
    body: "Someone else saved a newer version. Choose Reload latest, Overwrite, or Save as a copy — your unsaved edits are kept until you decide.",
    severity: "error",
    icon: "!",
  },
  offline: {
    title: "You're offline",
    body: "Your changes can't be saved right now. We'll keep them locally and retry automatically when you're back online.",
    severity: "error",
    icon: "!",
  },
  stale: {
    title: "Out of date",
    body: "The numbers changed since this narrative was written. Regenerate to refresh it — we never overwrite your edited prose automatically.",
    severity: "warning",
    icon: "~",
  },
  "read-only": {
    title: "Read-only view",
    body: "You're viewing a shared link. You can read, download the .xlsx, and export the packet, but not edit.",
    severity: "info",
    icon: "i",
  },
  "ai-opt-out": {
    title: "AI narrative is off",
    body: "The decision and every number above are computed without AI. Compute, save, and .xlsx export all work with zero AI calls.",
    severity: "info",
    icon: "i",
  },
};

export interface DegradedStateProps {
  kind: DegradedKind;
  /** Override the default body copy (e.g. a specific upstream error reason). */
  detail?: string;
  /** Optional recovery action; renders a button only when provided. */
  onAction?: () => void;
  actionLabel?: string;
}

// Hard errors are assertive; degraded-but-usable notices are polite.
function ariaRole(severity: Severity): "alert" | "status" {
  return severity === "error" ? "alert" : "status";
}

export function DegradedState({ kind, detail, onAction, actionLabel }: DegradedStateProps) {
  const def = DEGRADED_STATES[kind];
  return (
    <section
      className={`degraded degraded--${def.severity}`}
      data-testid={`degraded-${kind}`}
      data-kind={kind}
      data-severity={def.severity}
      role={ariaRole(def.severity)}
      aria-label={def.title}
    >
      <span className="degraded__icon" aria-hidden="true">
        {def.icon}
      </span>
      <div className="degraded__text">
        <p className="degraded__title">{def.title}</p>
        <p className="degraded__body">{detail ?? def.body}</p>
      </div>
      {onAction && (
        <button type="button" className="degraded__action" onClick={onAction}>
          {actionLabel ?? "Try again"}
        </button>
      )}
    </section>
  );
}

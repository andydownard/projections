// web/src/components/DegradedState.test.tsx — M7 a11y + error/degraded states.
//
// ENGINEERING_HANDOFF I2: every degraded state is DESIGNED + HANDLED — rent-failed,
// low-confidence, location-not-found, 409, offline, stale, read-only, AI opt-out.
// This is one accessible, color-independent surface: a labelled region whose
// severity is carried in TEXT + an icon (never color alone), with an optional
// recovery action. Errors are role="alert" (assertive); informational/degraded
// notices are role="status" (polite) so a screen reader is told without hijacking.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DegradedState,
  DEGRADED_STATES,
  type DegradedKind,
} from "./DegradedState";

const ALL_KINDS: DegradedKind[] = [
  "rent-failed",
  "low-confidence",
  "location-not-found",
  "conflict-409",
  "offline",
  "stale",
  "read-only",
  "ai-opt-out",
  "load-failed",
];

describe("DegradedState — I2 coverage", () => {
  it("defines every I2 state", () => {
    for (const kind of ALL_KINDS) {
      expect(DEGRADED_STATES[kind]).toBeDefined();
    }
    // no orphan/extra states beyond the designed ones
    expect(Object.keys(DEGRADED_STATES).sort()).toEqual([...ALL_KINDS].sort());
  });

  it.each(ALL_KINDS)("renders %s with a labelled region and visible text", (kind) => {
    render(<DegradedState kind={kind} />);
    const region = screen.getByTestId(`degraded-${kind}`);
    expect(region).toBeInTheDocument();
    // severity is carried in text (the title), never color alone
    expect(region.textContent && region.textContent.trim().length).toBeTruthy();
    // accessible name present for SR users
    expect(region).toHaveAccessibleName();
  });

  it("uses role=alert for hard errors and role=status for informational notices", () => {
    // hard errors -> assertive
    for (const kind of ["rent-failed", "location-not-found", "conflict-409", "offline", "load-failed"] as const) {
      const { unmount } = render(<DegradedState kind={kind} />);
      expect(screen.getByTestId(`degraded-${kind}`)).toHaveAttribute("role", "alert");
      unmount();
    }
    // degraded-but-usable -> polite status
    for (const kind of ["low-confidence", "stale", "read-only", "ai-opt-out"] as const) {
      const { unmount } = render(<DegradedState kind={kind} />);
      expect(screen.getByTestId(`degraded-${kind}`)).toHaveAttribute("role", "status");
      unmount();
    }
  });

  it("marks the decorative icon aria-hidden (meaning is in the text)", () => {
    const { container } = render(<DegradedState kind="low-confidence" />);
    const icon = container.querySelector(".degraded__icon");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a recovery action button when an onAction is provided", async () => {
    const onAction = vi.fn();
    render(<DegradedState kind="conflict-409" onAction={onAction} actionLabel="Reload latest" />);
    const region = screen.getByTestId("degraded-conflict-409");
    const btn = within(region).getByRole("button", { name: /reload latest/i });
    await userEvent.click(btn);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("omits the action button when no onAction is given", () => {
    render(<DegradedState kind="stale" />);
    const region = screen.getByTestId("degraded-stale");
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("allows a custom detail message to override the default body", () => {
    render(<DegradedState kind="rent-failed" detail="Census timed out after 3 tries." />);
    expect(screen.getByText(/census timed out after 3 tries/i)).toBeInTheDocument();
  });

  it("exposes a data-kind hook so each state is independently QA-screenshotable", () => {
    render(<DegradedState kind="ai-opt-out" />);
    expect(screen.getByTestId("degraded-ai-opt-out")).toHaveAttribute("data-kind", "ai-opt-out");
  });
});

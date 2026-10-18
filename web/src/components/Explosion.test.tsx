import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Explosion, particleVectors } from "./Explosion";

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("particleVectors", () => {
  it("is deterministic and spreads particles around the circle", () => {
    const a = particleVectors(12, 100);
    expect(a).toEqual(particleVectors(12, 100));
    expect(a).toHaveLength(12);
    expect(new Set(a.map((v) => `${v.dx},${v.dy}`)).size).toBe(12);
  });
});

describe("Explosion", () => {
  it("renders a hidden-from-AT burst with one element per particle", () => {
    mockReducedMotion(false);
    const { container } = render(<Explosion particles={10} />);
    const root = container.querySelector(".explosion")!;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".explosion__particle")).toHaveLength(10);
  });

  it("calls onDone once after the animation duration", () => {
    mockReducedMotion(false);
    const onDone = vi.fn();
    render(<Explosion durationMs={700} onDone={onDone} />);
    act(() => vi.advanceTimersByTime(699));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion: no moving particles, short flash, still calls onDone", () => {
    mockReducedMotion(true);
    const onDone = vi.fn();
    const { container } = render(<Explosion durationMs={700} onDone={onDone} />);
    expect(container.querySelectorAll(".explosion__particle")).toHaveLength(0);
    expect(container.querySelector(".explosion--still")).not.toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

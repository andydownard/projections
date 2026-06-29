// web/src/components/Toast.test.tsx — app-global success toast primitive.
//
// Tests: showToast renders; auto-dismiss at 4s; role=status + aria-live=polite;
// portals to body; reduced-motion class; useToast hook must be inside ToastProvider.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

import { ToastProvider, useToast } from "./Toast";

// Helper: a tiny app that surfaces the showToast hook via a button
function ToastTriggerApp({ message = "Saved!", label = "Show toast" }: { message?: string; label?: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message)}>
      {label}
    </button>
  );
}

function setup(message?: string) {
  return render(
    <ToastProvider>
      <ToastTriggerApp message={message} label="Show" />
    </ToastProvider>,
  );
}

// Save the original matchMedia so we can restore it after tests that override it
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  // Restore real timers after any fake-timer test
  vi.useRealTimers();
  // Restore matchMedia in case a test patched it
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
  // Force cleanup of any lingering React trees / portals
  cleanup();
});

describe("Toast", () => {
  // --- rendering ---

  it("showToast renders the message in the DOM", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved!");
  });

  it("calling showToast twice updates to the latest message", () => {
    render(
      <ToastProvider>
        <ToastTriggerApp message="First" label="First" />
        <ToastTriggerApp message="Second" label="Second" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getByRole("status")).toHaveTextContent("Second");
  });

  // --- auto-dismiss ---

  it("auto-dismisses after 4000ms", () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not dismiss before 4000ms", () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));

    act(() => {
      vi.advanceTimersByTime(3999);
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // --- a11y ---

  it("toast element has role=status", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("toast element has aria-live=polite", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  // --- portal ---

  it("portals the toast to document.body", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status").parentElement).toBe(document.body);
  });

  // --- prefers-reduced-motion ---

  it("adds toast--no-motion class when prefers-reduced-motion: reduce", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).toHaveClass("toast--no-motion");
  });

  it("does NOT add toast--no-motion when motion is allowed", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    setup();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("status")).not.toHaveClass("toast--no-motion");
  });
});

// web/src/components/Toast.tsx — app-global success toast (v2 redesign).
//
// Used by app-suggestion success and the "terms accepted on Generate" confirmation.
// A ToastProvider + useToast hook pattern; the host portals to document.body so
// the toast overlays the whole app without inflating any sticky ancestor.
//
// Accessibility: role="status" + aria-live="polite" so screen readers announce
// the message at the next opportunity. Honoring prefers-reduced-motion means no
// slide/fade animation when the user has requested reduced motion (a11y WCAG 2.1
// §2.3 + portfolio UI rule). No support_id or projection reference ever shown
// here (PRD §22 — only showToast(message) with caller-controlled copy).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// ─── Context ──────────────────────────────────────────────────────────────────

export interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  // Default no-op so hooks used outside a provider silently do nothing (fail-safe).
  showToast: () => {},
});

/** Returns the global toast control. Must be used inside <ToastProvider>. */
export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

const DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check prefers-reduced-motion at render time (not in an effect) so the class
  // is present on the first paint. jsdom doesn't implement matchMedia, so guard
  // against a missing implementation.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const showToast = useCallback((msg: string) => {
    // Cancel any in-flight dismiss so a rapid second toast resets the timer.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), DISMISS_MS);
  }, []);

  // Clean up the dismiss timer when the provider unmounts.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const toastClass = [
    "toast",
    prefersReducedMotion ? "toast--no-motion" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {message !== null &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className={toastClass}
            data-testid="toast"
          >
            {message}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export default ToastProvider;

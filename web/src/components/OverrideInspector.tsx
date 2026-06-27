// web/src/components/OverrideInspector.tsx — the RIGHT-edge Override Inspector
// (Spec B §10, issue #129 / PE10). The forensic counterpart to Penny: it flies in
// from the RIGHT (`translateX(100%)→0`) and mirrors Penny's a11y, motion, and
// breakpoint behaviour so the two obey one spatial grammar:
//
//   - z-order: scrim {@link Z.inspectorScrim} (50) / panel {@link Z.inspectorPanel}
//     (51) — ONE below Penny's 51/52 so a later-opened Penny never renders under it.
//   - ≥1180px: a 420px NON-MODAL panel (center stays interactive, loose focus trap,
//     no scrim) that may coexist with Penny on the LEFT.
//   - <1180px: a modal full-screen sheet (scrim, focus trap), mutually exclusive
//     with Penny — coordinated by {@link SidePanelProvider}.
//
// This component computes NOTHING and formats NOTHING: it renders the override audit
// rows (label + the SERVER display string) verbatim (PRD §13). Resetting a pin is a
// host-owned forward edit, surfaced only when the {@link OverrideInspectorProps.onResetPin}
// seam is provided. Inline/component-local styling only (the PE1 pattern).
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useSidePanel, Z } from "./sidePanels";

/** One overridden DAG node, shaped for verbatim display (no client math). */
export interface InspectorOverride {
  /** DAG node id — the stable identity passed back to the reset seam. */
  node: string;
  year: number;
  /** Human label, rendered verbatim (e.g. "Payroll, Year 1"). */
  label: string;
  /** Server display string for the pinned value, rendered verbatim. */
  value: string;
  /** Optional server display string for the calculated value it replaces. */
  calculated?: string;
}

export interface OverrideInspectorProps {
  /** The overridden cells to audit (server display strings). */
  overrides?: InspectorOverride[];
  /** Reset-pin seam — a host-owned forward edit (clears the pin → new revision).
   *  When omitted, the panel is a read-only audit (no reset affordance). */
  onResetPin?: (node: string, year: number) => void;
  /** Controlled open (optional). Uncontrolled / coordinator-driven when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Trigger label override. */
  triggerLabel?: string;
}

const BRAND_DEEP = "#1d4733";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Safe matchMedia probe for reduced-motion (jsdom/SSR have none). */
function usePrefersReducedMotion(): boolean {
  const get = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

const iconBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "32px",
  height: "32px",
  border: "1px solid var(--line, #e2e2e2)",
  borderRadius: "8px",
  background: "var(--surface, #fff)",
  color: "var(--text, #1a1a1a)",
  cursor: "pointer",
  flex: "0 0 auto",
};

interface InspectorPanelProps {
  labelId: string;
  modal: boolean;
  autoFocus: boolean;
  reducedMotion: boolean;
  overrides: InspectorOverride[];
  onResetPin?: (node: string, year: number) => void;
  onClose: () => void;
}

// The fly-in panel. Mounts fresh on each open so the enter animation replays.
function InspectorPanel({
  labelId,
  modal,
  autoFocus,
  reducedMotion,
  overrides,
  onResetPin,
  onClose,
}: InspectorPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [entered, setEntered] = useState(false);
  const autoFocusOnMount = useRef(autoFocus);

  // Slide in from the right: start off-screen, settle to 0. Reduced-motion settles
  // immediately.
  useEffect(() => {
    if (reducedMotion) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  // Focus the close button on open — UNLESS the coordinator suppressed it (e.g.
  // Penny is already open on the desktop and this opened beside it). Evaluated once
  // at mount: closing the sibling later must not yank focus around.
  useEffect(() => {
    if (autoFocusOnMount.current) closeRef.current?.focus();
  }, []);

  // Esc closes from anywhere within the panel; the parent restores focus to the FAB.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus trap ONLY when modal (full-screen sheet). Non-modal keeps a loose trap so
  // the center + the other panel stay reachable (Spec B §10).
  const onTrapKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!modal || e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [modal],
  );

  const panelStyle: CSSProperties = {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: Z.inspectorPanel,
    display: "flex",
    flexDirection: "column",
    width: modal ? "100%" : "420px",
    maxWidth: "100vw",
    background: "var(--surface, #ffffff)",
    borderLeft: "1px solid var(--line, #e2e2e2)",
    boxShadow: "0 0 24px rgba(0,0,0,0.18)",
    transform: entered ? "translateX(0)" : "translateX(100%)",
    transition: reducedMotion ? "none" : "transform 240ms ease",
  };

  return (
    <>
      {/* Modal sheet gets a scrim; desktop non-modal suppresses it (no double-dim). */}
      {modal && (
        <div
          data-testid="inspector-scrim"
          aria-hidden="true"
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: Z.inspectorScrim,
            background: "rgba(0,0,0,0.32)",
          }}
        />
      )}
      <div
        ref={panelRef}
        data-testid="inspector-panel"
        role="dialog"
        aria-modal={modal}
        aria-labelledby={labelId}
        data-reduced-motion={reducedMotion}
        data-modal={modal}
        onKeyDown={onTrapKeyDown}
        style={panelStyle}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.625rem",
            padding: "0.75rem 1rem",
            borderBottom: "1px solid var(--line, #e2e2e2)",
          }}
        >
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <h2 id={labelId} style={{ margin: 0, fontSize: "1rem", lineHeight: 1.2 }}>
              Override inspector
            </h2>
            <p style={{ margin: 0, fontSize: "0.6875rem", color: "var(--text-muted, #666)" }}>
              Audit pinned values — reset to recompute.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Override inspector"
            onClick={onClose}
            style={iconBtnStyle}
          >
            <CloseIcon />
          </button>
        </header>

        <div style={{ flex: "1 1 auto", overflow: "auto", padding: "0.5rem 1rem 1rem" }}>
          {overrides.length === 0 ? (
            <p
              data-testid="inspector-empty"
              style={{ fontSize: "0.8125rem", color: "var(--text-muted, #666)", margin: "0.5rem 0" }}
            >
              No pinned overrides. Pin a component cell to audit it here.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {overrides.map((o) => (
                <li
                  key={`${o.node}#${o.year}`}
                  data-testid={`inspector-override-${o.node}-y${o.year}`}
                  style={{
                    border: "1px solid var(--line, #e2e2e2)",
                    borderRadius: "8px",
                    padding: "0.5rem 0.625rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.6875rem", fontWeight: 600, color: "var(--text-muted, #666)" }}>
                    {o.label}
                  </span>
                  <span style={{ fontWeight: 700 }}>{o.value}</span>
                  {o.calculated && (
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted, #666)" }}>
                      was computed {o.calculated}
                    </span>
                  )}
                  {onResetPin && (
                    <button
                      type="button"
                      onClick={() => onResetPin(o.node, o.year)}
                      style={{
                        alignSelf: "flex-start",
                        marginTop: "0.15rem",
                        fontSize: "0.75rem",
                        padding: "0.2rem 0.55rem",
                        border: "1px solid var(--line, #e2e2e2)",
                        borderRadius: "999px",
                        background: "var(--surface, #fff)",
                        color: BRAND_DEEP,
                        cursor: "pointer",
                      }}
                    >
                      Reset pin
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

export function OverrideInspector({
  overrides = [],
  onResetPin,
  open: openProp,
  onOpenChange,
  triggerLabel = "Override inspector",
}: OverrideInspectorProps) {
  const panel = useSidePanel("inspector");
  const reducedMotion = usePrefersReducedMotion();
  const labelId = useId();
  const fabRef = useRef<HTMLButtonElement>(null);

  const open = openProp ?? panel.open;
  const { requestOpen, requestClose } = panel;

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) {
        if (next) requestOpen();
        else requestClose();
      }
      onOpenChange?.(next);
    },
    [openProp, onOpenChange, requestOpen, requestClose],
  );

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the FAB so keyboard users aren't dropped to the document top.
    fabRef.current?.focus();
  }, [setOpen]);

  const count = overrides.length;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        data-testid="inspector-fab"
        data-state="open-able"
        aria-label={`${triggerLabel}${count > 0 ? ` (${count} pinned)` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          position: "fixed",
          right: "1rem",
          bottom: "1rem",
          zIndex: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          height: "48px",
          padding: "0 0.875rem",
          borderRadius: "999px",
          border: "1px solid var(--line, #cfd8d2)",
          background: "var(--surface, #fff)",
          color: BRAND_DEEP,
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
        }}
      >
        <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>{triggerLabel}</span>
        {count > 0 && (
          <span
            aria-hidden="true"
            style={{
              fontSize: "0.6875rem",
              fontWeight: 700,
              minWidth: "1.25rem",
              height: "1.25rem",
              padding: "0 0.35rem",
              borderRadius: "999px",
              background: BRAND_DEEP,
              color: "#fff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <InspectorPanel
          labelId={labelId}
          modal={panel.modal}
          autoFocus={panel.autoFocus()}
          reducedMotion={reducedMotion}
          overrides={overrides}
          onResetPin={onResetPin}
          onClose={close}
        />
      )}
    </>
  );
}

export default OverrideInspector;

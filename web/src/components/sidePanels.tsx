// web/src/components/sidePanels.tsx — shared spatial grammar & coexistence wiring
// for the Penny LEFT drawer and the Override Inspector RIGHT panel (Spec B §10,
// issue #129 / PE10). This is the SINGLE source of truth for:
//
//   1. The documented z-order ({@link Z}) so the two side panels and the feedback
//      modal can never silently re-stack relative to one another. Penny sits ONE
//      level above the Inspector so a later-opened Penny never renders under it; the
//      feedback modal is above both.
//   2. The 1180px coexistence breakpoint ({@link useCoexistenceModal}): at/above it
//      the panels are non-modal and may coexist (center stays interactive, loose
//      focus traps, desktop scrims suppressed); below it each is a modal full-screen
//      sheet and the two are mutually exclusive.
//   3. The {@link SidePanelProvider} coordinator + {@link useSidePanel} hook that
//      enforce the mutual exclusion below the breakpoint (opening one closes the
//      other and announces it via a polite live region) and the focus politeness
//      above it (opening a panel never steals focus from an already-open sibling).
//
// Inline/component-local styling only (the PE1 pattern) — no shared tokens.css edits
// — so parallel agents don't collide. The coordinator is OPTIONAL: a panel rendered
// with no provider self-manages its open state and always takes focus, which is how
// Penny behaves on the full-page wizard where there is no Inspector to coexist with.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Documented z-order (Spec B §10). Exact, intentional levels:
 *   - `topBar` 30 — the sticky header / Idea-Fab region ceiling.
 *   - Inspector scrim 50 / panel 51 (the existing right-edge forensic panel).
 *   - Penny scrim 51 / panel 52 — ONE above the Inspector so a later-opened Penny
 *     never renders underneath it.
 *   - Feedback modal scrim 70 / panel 71 — above BOTH side panels.
 */
export const Z = {
  topBar: 30,
  inspectorScrim: 50,
  inspectorPanel: 51,
  pennyScrim: 51,
  pennyPanel: 52,
  feedbackScrim: 70,
  feedbackPanel: 71,
} as const;

/**
 * Below this viewport width the side panels are modal full-screen sheets and are
 * mutually exclusive; at/above it they are non-modal and may coexist (Spec B §10).
 */
export const COEXIST_MIN_WIDTH = 1180;

/** Safe matchMedia probe — jsdom and SSR have no matchMedia; default to `fallback`. */
function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return fallback;
  }
  return window.matchMedia(query).matches;
}

/**
 * `true` when below {@link COEXIST_MIN_WIDTH} (a modal full-screen sheet); `false`
 * at/above it (a non-modal side panel that may coexist with the other edge).
 */
export function useCoexistenceModal(): boolean {
  const query = `(min-width: ${COEXIST_MIN_WIDTH}px)`;
  const get = useCallback(() => !mediaMatches(query, false), [query]);
  const [modal, setModal] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setModal(!mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return modal;
}

export type SidePanelSide = "penny" | "inspector";

const SIDE_LABEL: Record<SidePanelSide, string> = {
  penny: "Penny",
  inspector: "Override inspector",
};

function other(side: SidePanelSide): SidePanelSide {
  return side === "penny" ? "inspector" : "penny";
}

interface Coordinator {
  openMap: Record<SidePanelSide, boolean>;
  modal: boolean;
  requestOpen: (side: SidePanelSide) => void;
  requestClose: (side: SidePanelSide) => void;
  /** Whether `side`, opening now, should pull focus INTO its panel. False on the
   *  desktop when the OTHER panel is already open (don't steal an open sibling's
   *  focus — coexist politely, exactly one focus ring). Always true for a modal
   *  sheet (it replaces whatever was there). */
  shouldAutoFocus: (side: SidePanelSide) => boolean;
}

const CoordinatorContext = createContext<Coordinator | null>(null);

/** Visually-hidden style for the coordinator's polite live region. */
const SR_ONLY = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

/**
 * Coordinates the two side panels so they obey the spatial grammar (Spec B §10).
 * Wrap the surfaces that can host both panels (the detail page; the wizard hosts
 * only Penny but may still wrap for the shared live region). Renders a single polite
 * live region used to announce a mutually-exclusive close below the breakpoint.
 */
export function SidePanelProvider({ children }: { children: ReactNode }) {
  const modal = useCoexistenceModal();
  const [openMap, setOpenMap] = useState<Record<SidePanelSide, boolean>>({
    penny: false,
    inspector: false,
  });
  const [announcement, setAnnouncement] = useState("");

  // Refs mirror the latest state for the imperative open/focus decisions (which run
  // from event handlers and mount effects, not from render).
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const openRef = useRef(openMap);
  openRef.current = openMap;

  const requestOpen = useCallback((side: SidePanelSide) => {
    const sib = other(side);
    if (modalRef.current && openRef.current[sib]) {
      // Below the breakpoint the sheets are mutually exclusive: opening one closes
      // the other and announces it (aria-live=polite); focus then lands on the
      // newly-opened modal sheet.
      setOpenMap({ ...openRef.current, [side]: true, [sib]: false });
      setAnnouncement(`${SIDE_LABEL[sib]} closed.`);
    } else {
      setOpenMap({ ...openRef.current, [side]: true });
    }
  }, []);

  const requestClose = useCallback((side: SidePanelSide) => {
    if (!openRef.current[side]) return;
    setOpenMap({ ...openRef.current, [side]: false });
  }, []);

  const shouldAutoFocus = useCallback((side: SidePanelSide) => {
    if (modalRef.current) return true;
    return !openRef.current[other(side)];
  }, []);

  const value = useMemo<Coordinator>(
    () => ({ openMap, modal, requestOpen, requestClose, shouldAutoFocus }),
    [openMap, modal, requestOpen, requestClose, shouldAutoFocus],
  );

  return (
    <CoordinatorContext.Provider value={value}>
      {children}
      {/* Single polite live region: announces the mutually-exclusive close below
          the breakpoint. Visually hidden; meaning carried in text, not color. Uses
          a bare aria-live div (not role="status") so it never adds a second status
          landmark to a host page that already has one (e.g. the wizard). */}
      <div data-testid="side-panel-live" aria-live="polite" style={SR_ONLY}>
        {announcement}
      </div>
    </CoordinatorContext.Provider>
  );
}

export interface UseSidePanelResult {
  /** Whether this panel is open. */
  open: boolean;
  /** Whether this panel is a modal full-screen sheet (below the breakpoint). */
  modal: boolean;
  requestOpen: () => void;
  requestClose: () => void;
  toggle: () => void;
  /** Evaluate whether this panel, opening now, should pull focus into itself.
   *  Read at open time (the panel mounts fresh on each open). */
  autoFocus: () => boolean;
  /** True when inside a {@link SidePanelProvider} (coexistence active). */
  coordinated: boolean;
}

/**
 * The public hook a side panel uses to participate in the spatial grammar. Inside a
 * {@link SidePanelProvider} it is coordinated (mutual exclusion + focus politeness);
 * standalone it self-manages open state and always takes focus, with the same 1180px
 * breakpoint (so Penny behaves identically on the full-page wizard).
 */
export function useSidePanel(side: SidePanelSide): UseSidePanelResult {
  const coord = useContext(CoordinatorContext);
  const standaloneModal = useCoexistenceModal();
  const [selfOpen, setSelfOpen] = useState(false);

  const open = coord ? coord.openMap[side] : selfOpen;
  const modal = coord ? coord.modal : standaloneModal;

  const requestOpen = useCallback(() => {
    if (coord) coord.requestOpen(side);
    else setSelfOpen(true);
  }, [coord, side]);

  const requestClose = useCallback(() => {
    if (coord) coord.requestClose(side);
    else setSelfOpen(false);
  }, [coord, side]);

  const toggle = useCallback(() => {
    if (open) requestClose();
    else requestOpen();
  }, [open, requestOpen, requestClose]);

  const autoFocus = useCallback(
    () => (coord ? coord.shouldAutoFocus(side) : true),
    [coord, side],
  );

  return { open, modal, requestOpen, requestClose, toggle, autoFocus, coordinated: !!coord };
}

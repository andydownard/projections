// web/src/components/PennyDrawer.tsx — Penny LEFT slide-out drawer shell (PE1).
//
// This is the SHELL only: the collapsed FAB, the fly-in panel (header + body slot
// + composer slot), and the AI-disabled fallback. NO backend is wired here — there
// are no `/penny` calls, no streaming, no mutation. PE6/PE8 mount this into the
// detail page / wizard and inject the live transcript + composer; this file just
// builds the seams (spec §1, §5, §14, §15).
//
// Invariants honored here (CLAUDE.md / spec):
//   - Penny mirrors the right-edge Override Inspector by flying in from the LEFT
//     (`translateX(-100%)→0`), respecting `prefers-reduced-motion` (settled render,
//     no animated avatar — the avatar is a static <img>).
//   - The component computes NOTHING and formats NOTHING. Numbers only ever arrive
//     pre-formatted by the server; this shell renders content verbatim.
//   - AI-disabled fallback is never a dead-end: the FAB degrades to a muted Settings
//     deep-link (spec §1/§8). Every manual path stays intact because Penny is purely
//     additive UI.
//   - Keyboard-first + not-color-alone: the FAB carries a text label; the muted state
//     is announced in text ("off" + "Settings"), never by color alone.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { FieldChange } from "./FieldChange";
import { PennyTranscript, type PennyTurn } from "./PennyTranscript";
import { ProposalUpload } from "./ProposalUpload";
import { useCoexistenceModal, useSidePanel, Z } from "./sidePanels";
import {
  PennyError,
  sendPennyDraftMessage,
  sendPennyMessage,
  type PennyDraftApplied,
  type PennyDraftResponse,
  type PennyDraftState,
  type PennyTurnDTO,
} from "../api/penny";

export type PennyProvider = "anthropic" | "openai";

export interface PennyDrawerProps {
  /**
   * When false (AI opt-out or no provider key configured), Penny is unavailable:
   * the FAB renders muted and deep-links to Settings instead of opening the drawer
   * (spec §1/§8). Defaults to true.
   */
  aiEnabled?: boolean;
  /** Settings deep-link target for the AI-disabled muted FAB (never a dead-end). */
  settingsHref?: string;
  /** SPA-nav hook: when provided, the muted FAB calls this instead of hard-navigating. */
  onOpenSettings?: () => void;
  /** The ACTUAL provider used, surfaced on the header disclosure line (spec §8). */
  provider?: PennyProvider;
  /** Avatar asset (served statically from web/public). */
  avatarSrc?: string;
  /** Body content (the transcript). Defaults to an empty PennyTranscript shell. */
  children?: ReactNode;
  /** Composer override. Defaults to the built-in composer shell. */
  composer?: ReactNode;
  /** "New chat" affordance hook (shell no-op by default). */
  onNewChat?: () => void;
  /** Controlled open state (optional). Uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const BRAND = "#35644f";

/** Comfortable touch target for the mobile full-screen sheet's sticky controls
 *  (header + composer), per the PE12 mobile-375 / a11y pass (issue #131, spec §5). */
const TOUCH_TARGET = 44;

/** The collapsed FAB is anchored to the UPPER-LEFT, flush against the left edge.
 *  This top inset clears the sticky top bar (min-height 56px, z-index 20) so the
 *  FAB — which renders above the bar — never sits over the brand / home link. The
 *  drawer panel itself is anchored to the very top (`top: 0`) and slides out from
 *  the left (`translateX(-100%)→0`). */
const FAB_TOP = "4rem";

/** Safe matchMedia probe — jsdom and SSR have no matchMedia; default to `fallback`. */
function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return fallback;
  }
  return window.matchMedia(query).matches;
}

function usePrefersReducedMotion(): boolean {
  const get = () => mediaMatches("(prefers-reduced-motion: reduce)", false);
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

// The 1180px modal/non-modal breakpoint now lives in the shared coexistence wiring
// (sidePanels.useSidePanel → useCoexistenceModal) so Penny and the Override
// Inspector share ONE source of truth (spec §10, issue #129).

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Inlined avatar (static <img>); never animated even without reduced-motion.
function PennyAvatar({ src, size }: { src: string; size: number }) {
  return (
    <img
      src={src}
      alt="Penny"
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: "50%", display: "block" }}
    />
  );
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

interface PennyPanelProps {
  labelId: string;
  modal: boolean;
  /** Whether this panel should pull focus into itself on open. False when the
   *  coordinator suppresses it (e.g. the Inspector is already open on the desktop)
   *  so opening Penny never steals an open sibling's focus (spec §10). */
  autoFocus: boolean;
  reducedMotion: boolean;
  provider?: PennyProvider;
  avatarSrc: string;
  body: ReactNode;
  composer: ReactNode;
  onClose: () => void;
  onNewChat?: () => void;
}

const PROVIDER_LABEL: Record<PennyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

// The fly-in panel. Mounts fresh on each open so the enter animation replays and
// focus lands on the close button every time.
function PennyPanel({
  labelId,
  modal,
  autoFocus,
  reducedMotion,
  provider,
  avatarSrc,
  body,
  composer,
  onClose,
  onNewChat,
}: PennyPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [entered, setEntered] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Captured once at mount: closing a coexisting sibling later must not yank focus.
  const autoFocusOnMount = useRef(autoFocus);

  // Slide in: start off-screen, settle to 0. Reduced-motion → settle immediately.
  useEffect(() => {
    if (reducedMotion) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  // Focus the close button on open (focus moves into the drawer) — UNLESS the
  // coordinator suppressed it because a sibling panel is already open beside it on
  // the desktop (no focus steal, exactly one focus ring; spec §10).
  useEffect(() => {
    if (autoFocusOnMount.current) closeRef.current?.focus();
  }, []);

  // Esc closes from anywhere within the drawer; parent restores focus to the FAB.
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

  // Scroll-lock the page behind the modal full-screen sheet so a touch drag scrolls
  // the transcript, never the page underneath (PE12, issue #131). Restored on close
  // (the panel unmounts). The desktop non-modal panel leaves the center scrollable.
  useEffect(() => {
    if (!modal || typeof document === "undefined") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [modal]);

  // Focus trap when modal (full-screen sheet): keep Tab within the panel (spec §10).
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
    left: 0,
    bottom: 0,
    zIndex: Z.pennyPanel,
    display: "flex",
    flexDirection: "column",
    width: modal ? "100%" : "380px",
    maxWidth: "100vw",
    // Full-screen sheet uses the DYNAMIC viewport height so the composer stays above
    // the on-screen keyboard on mobile (100dvh tracks the shrunken visual viewport).
    height: modal ? "100dvh" : undefined,
    maxHeight: modal ? "100dvh" : undefined,
    background: "var(--surface, #ffffff)",
    borderRight: "1px solid var(--line, #e2e2e2)",
    boxShadow: "0 0 24px rgba(0,0,0,0.18)",
    transform: entered ? "translateX(0)" : "translateX(-100%)",
    transition: reducedMotion ? "none" : "transform 240ms ease",
  };

  // On the mobile full-screen sheet the sticky header/close controls grow to a
  // comfortable 44px touch target; the dense desktop panel keeps the compact 32px.
  const controlSize = modal ? TOUCH_TARGET : 32;
  const squareControlStyle: CSSProperties = {
    ...iconBtnStyle,
    width: controlSize,
    height: controlSize,
    minWidth: controlSize,
    minHeight: controlSize,
  };

  return (
    <>
      {/* Modal sheet gets a scrim; desktop non-modal suppresses it (no double-dim, spec §10). */}
      {modal && (
        <div
          data-testid="penny-scrim"
          aria-hidden="true"
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: Z.pennyScrim,
            background: "rgba(0,0,0,0.32)",
          }}
        />
      )}
      <div
        ref={panelRef}
        data-testid="penny-panel"
        role="dialog"
        aria-modal={modal}
        aria-labelledby={labelId}
        data-reduced-motion={reducedMotion}
        data-modal={modal}
        onKeyDown={onTrapKeyDown}
        style={panelStyle}
      >
        {/* Header: avatar + name + provider disclosure + info popover + New chat + close. */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.625rem",
            padding: "0.75rem 1rem",
            borderBottom: "1px solid var(--line, #e2e2e2)",
          }}
        >
          <PennyAvatar src={avatarSrc} size={32} />
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <h2 id={labelId} style={{ margin: 0, fontSize: "1rem", lineHeight: 1.2 }}>
              Penny
            </h2>
            <p
              data-testid="penny-provider"
              style={{ margin: 0, fontSize: "0.6875rem", color: "var(--text-muted, #666)" }}
            >
              {provider
                ? `Powered by ${PROVIDER_LABEL[provider]}`
                : "Powered by your configured AI provider"}
            </p>
          </div>
          <button
            type="button"
            aria-label="About Penny"
            aria-haspopup="dialog"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen((v) => !v)}
            style={squareControlStyle}
          >
            <span aria-hidden="true" style={{ fontWeight: 700 }}>
              i
            </span>
          </button>
          <button
            type="button"
            onClick={onNewChat}
            style={{
              ...squareControlStyle,
              width: "auto",
              minWidth: 0,
              padding: "0 0.5rem",
              fontSize: "0.8125rem",
            }}
          >
            New chat
          </button>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Penny"
            onClick={onClose}
            style={squareControlStyle}
          >
            <CloseIcon />
          </button>
        </header>

        {infoOpen && (
          <div
            data-testid="penny-info"
            role="note"
            style={{
              padding: "0.5rem 1rem",
              fontSize: "0.75rem",
              color: "var(--text-muted, #666)",
              borderBottom: "1px solid var(--line, #e2e2e2)",
              background: "var(--surface-alt, #f7f7f5)",
            }}
          >
            Penny answers and applies changes through the same save path you use — every
            edit is undoable. She falls back to a second provider if needed, and you can
            turn her off in Settings.
          </div>
        )}

        {/* Body slot (the transcript). */}
        {body}

        {/* Composer slot. */}
        {composer}
      </div>
    </>
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

// Default composer shell — multiline input + send + suggestion chips. No backend.
function DefaultComposer() {
  const [draft, setDraft] = useState("");
  const modal = useCoexistenceModal();
  return (
    <form
      data-testid="penny-composer"
      onSubmit={(e) => e.preventDefault()}
      style={composerFormStyle(modal)}
    >
      <div data-testid="penny-chips" style={chipRowStyle(modal)}>
        {["Explain break-even", "Lower the rent", "Build my cost schedule"].map((chip) => (
          <button key={chip} type="button" style={chipStyle(modal, false)} onClick={() => setDraft(chip)}>
            {chip}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
        <textarea
          aria-label="Ask Penny"
          placeholder="Ask Penny…"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={composerTextareaStyle(modal)}
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          style={{
            ...composerSendStyle(modal),
            cursor: draft.trim().length === 0 ? "not-allowed" : "pointer",
            opacity: draft.trim().length === 0 ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </div>
    </form>
  );
}

// ---- Shared composer styling (mobile full-screen sheet ⇄ desktop panel, PE12). ----
// On the mobile sheet (`modal`): the composer sticks above the on-screen keyboard
// with a safe-area inset, the suggestion chips scroll HORIZONTALLY instead of
// wrapping (keeping the input reachable), and every control is a 44px touch target.

function composerFormStyle(modal: boolean): CSSProperties {
  return {
    borderTop: "1px solid var(--line, #e2e2e2)",
    padding: "0.625rem 1rem 0.75rem",
    // Keep the composer clear of the iOS home indicator / rounded corners.
    paddingBottom: modal ? "max(0.75rem, env(safe-area-inset-bottom))" : "0.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  };
}

function chipRowStyle(modal: boolean): CSSProperties {
  return {
    display: "flex",
    gap: "0.375rem",
    alignItems: "center",
    // Mobile: a single non-wrapping row that scrolls; desktop: wrap onto lines.
    flexWrap: modal ? "nowrap" : "wrap",
    overflowX: modal ? "auto" : "visible",
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "thin",
    paddingBottom: modal ? "0.15rem" : undefined,
  };
}

function chipStyle(modal: boolean, pending: boolean): CSSProperties {
  return {
    flex: "0 0 auto",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    padding: modal ? "0 0.7rem" : "0.2rem 0.55rem",
    minHeight: modal ? TOUCH_TARGET : undefined,
    border: "1px solid var(--line, #e2e2e2)",
    borderRadius: "999px",
    background: "var(--surface, #fff)",
    color: "var(--brand-deep, #1d4733)",
    cursor: pending ? "not-allowed" : "pointer",
  };
}

function composerTextareaStyle(modal: boolean): CSSProperties {
  return {
    flex: "1 1 auto",
    resize: "vertical",
    minHeight: modal ? TOUCH_TARGET : "2.5rem",
    padding: "0.5rem",
    border: "1px solid var(--line, #e2e2e2)",
    borderRadius: "8px",
    font: "inherit",
  };
}

function composerSendStyle(modal: boolean): CSSProperties {
  return {
    padding: "0.5rem 0.875rem",
    minHeight: modal ? TOUCH_TARGET : undefined,
    border: "none",
    borderRadius: "8px",
    background: BRAND,
    color: "#fff",
  };
}

export function PennyDrawer({
  aiEnabled = true,
  settingsHref = "/?settings=ai",
  onOpenSettings,
  provider,
  avatarSrc = "/penny-avatar.png",
  children,
  composer,
  onNewChat,
  open: openProp,
  onOpenChange,
}: PennyDrawerProps) {
  // The shared coexistence coordinator (spec §10). Inside a SidePanelProvider it
  // enforces mutual exclusion vs. the Override Inspector below 1180px and focus
  // politeness above it; standalone (the wizard, where there is no Inspector) it
  // self-manages open state with the same breakpoint.
  const panel = useSidePanel("penny");
  const reducedMotion = usePrefersReducedMotion();
  const modal = panel.modal;
  const labelId = useId();

  const { requestOpen, requestClose } = panel;
  const open = openProp ?? panel.open;
  const fabRef = useRef<HTMLButtonElement>(null);

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

  // Collapsed-FAB scroll auto-hide/return (spec §5.1): hide on scroll-down, show on up.
  const [fabHidden, setFabHidden] = useState(false);
  const lastScrollY = useRef(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    lastScrollY.current = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      if (y > lastScrollY.current && y > 64) setFabHidden(true);
      else if (y < lastScrollY.current) setFabHidden(false);
      lastScrollY.current = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ---- AI-disabled fallback: muted FAB that deep-links to Settings (never a dead-end).
  if (!aiEnabled) {
    return (
      <a
        data-testid="penny-fab"
        data-state="ai-disabled"
        href={settingsHref}
        aria-label="Penny is off — open Settings to turn on the AI assistant"
        onClick={
          onOpenSettings
            ? (e) => {
                e.preventDefault();
                onOpenSettings();
              }
            : undefined
        }
        style={{
          position: "fixed",
          // Upper-LEFT, flush to the left edge (mirrors the enabled FAB), anchored
          // below the top bar so it never overlaps the brand / home link.
          left: 0,
          top: FAB_TOP,
          zIndex: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          height: "48px",
          padding: "0 0.875rem 0 0.6rem",
          // Squared off on the left so the pill reads as flush against the edge.
          borderRadius: "0 999px 999px 0",
          border: "1px dashed var(--line, #b9b9b9)",
          borderLeft: "none",
          background: "var(--surface-alt, #ededeb)",
          color: "var(--text-muted, #666)",
          textDecoration: "none",
          // Muted, desaturated avatar — meaning carried by the "off" text, not color.
          filter: "grayscale(1)",
          opacity: 0.85,
        }}
      >
        <PennyAvatar src={avatarSrc} size={28} />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span style={{ fontSize: "0.8125rem", fontWeight: 600 }}>Penny is off</span>
          <span style={{ fontSize: "0.6875rem" }}>Settings →</span>
        </span>
      </a>
    );
  }

  const body = children ?? <PennyTranscript turns={[]} />;
  const composerNode = composer ?? <DefaultComposer />;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        data-testid="penny-fab"
        data-state="ai-enabled"
        data-scroll-hidden={fabHidden}
        aria-label="Ask Penny about this projection"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          position: "fixed",
          // Upper-LEFT, FLUSH against the left edge (no inset), anchored just below
          // the top bar so it never overlaps the brand / home link. The drawer it
          // opens slides out from this same left edge (spec §5.1, #131).
          left: 0,
          top: FAB_TOP,
          zIndex: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          height: "48px",
          padding: "0 0.875rem 0 0.5rem",
          // Squared off on the left so the pill reads as flush against the edge.
          borderRadius: "0 999px 999px 0",
          border: "none",
          background: BRAND,
          color: "#fff",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          // Scroll auto-hide slides UP off the top edge (the FAB is top-anchored);
          // transition suppressed under reduced-motion.
          transform: fabHidden ? "translateY(-150%)" : "translateY(0)",
          opacity: fabHidden ? 0 : 1,
          pointerEvents: fabHidden ? "none" : "auto",
          transition: reducedMotion ? "none" : "transform 200ms ease, opacity 200ms ease",
        }}
      >
        <PennyAvatar src={avatarSrc} size={36} />
        <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>Ask Penny</span>
      </button>

      {open && (
        <PennyPanel
          labelId={labelId}
          modal={modal}
          autoFocus={panel.autoFocus()}
          reducedMotion={reducedMotion}
          provider={provider}
          avatarSrc={avatarSrc}
          body={body}
          composer={composerNode}
          onClose={close}
          onNewChat={onNewChat}
        />
      )}
    </>
  );
}

// ============================================================================
// PennyAssistant — the LIVE detail-page drawer (PE6). Wires the shell above to
// POST …/penny: apply-immediately + narrate, streaming with Stop, provider
// disclosure, and graceful AI-off / unavailable / rate-limit handling. The
// component still computes NOTHING: it relays the user's message and renders the
// server's turns + narration VERBATIM. A decision-metric delta reaches the screen
// only once the engine recomputes and the host page refetches the view-model
// (via `onApplied`) — Penny never streams a number (spec §2/§5.1/§8, issue #125).
// ============================================================================

export interface PennyAssistantProps {
  /** The saved projection's view_slug (the POST …/penny path key). */
  viewSlug: string;
  /** The caller's owner/edit Bearer token (header only — never the URL/log). */
  token: string;
  /** AI opt-out / no key → muted FAB + Settings deep-link (never a dead-end). */
  aiEnabled?: boolean;
  /** Provider known up front (e.g. from a prior transcript turn); updated per turn. */
  provider?: PennyProvider;
  /** Settings deep-link for the AI-disabled / muted states. */
  settingsHref?: string;
  onOpenSettings?: () => void;
  /** Seed turns (e.g. a persisted transcript from GET …/penny/transcript). */
  initialTurns?: PennyTurn[];
  /**
   * Called after an applied edit with the new revision ids so the host page can
   * refetch the view-model — the ONLY way a decision-metric delta reaches the
   * screen (the client never streams a number).
   */
  onApplied?: (revisionIds: string[]) => void;
  avatarSrc?: string;
}

interface PennyErrorView {
  message: string;
}

/** Map a classified PennyError → plain, code-owned copy. Chat is never the only
 *  path: each message reassures that numbers + manual editing still work. */
function errorView(err: PennyError): PennyErrorView {
  switch (err.kind) {
    case "ai_unavailable":
      return { message: "AI unavailable — numbers and manual editing still work." };
    case "rate_limited":
      return { message: "Penny is busy right now — please try again in a moment." };
    default:
      return {
        message:
          "Something went wrong reaching Penny — your numbers and manual editing are unaffected.",
      };
  }
}

function dtoToTurn(dto: PennyTurnDTO, fallbackId: string): PennyTurn {
  return { id: dto.id ?? fallbackId, role: dto.role, content: dto.content };
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

export function PennyAssistant({
  viewSlug,
  token,
  aiEnabled = true,
  provider: initialProvider,
  settingsHref,
  onOpenSettings,
  initialTurns = [],
  onApplied,
  avatarSrc,
}: PennyAssistantProps) {
  const [turns, setTurns] = useState<PennyTurn[]>(initialTurns);
  const [provider, setProvider] = useState<PennyProvider | undefined>(initialProvider);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PennyErrorView | null>(null);
  // `muted` is the in-drawer ai_disabled state (composer → Settings note), distinct
  // from the up-front muted FAB (`aiEnabled=false`): Penny got turned off mid-chat.
  const [muted, setMuted] = useState(false);
  // An uploaded consultant proposal, attached to the NEXT turn (Spec §9). One-shot:
  // cleared once a turn carries it so a later message doesn't silently re-attach it.
  const [proposal, setProposal] = useState<{ ref: string; name?: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const localId = useCallback(() => `penny-local-${(idRef.current += 1)}`, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending || muted) return;

      setTurns((prev) => [...prev, { id: localId(), role: "user", content: message }]);
      setError(null);
      setPending(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await sendPennyMessage({
          viewSlug,
          token,
          message,
          proposalRef: proposal?.ref,
          signal: controller.signal,
        });
        setProposal(null); // consumed by this turn (one-shot attachment)
        setProvider(res.provider);
        // Append the server's turns, skipping the user echo we already rendered.
        const appended = (res.turns_appended ?? [])
          .filter((t) => t.role !== "user")
          .map((t) => dtoToTurn(t, localId()));
        const next: PennyTurn[] =
          appended.length > 0
            ? appended
            : res.narration
              ? [{ id: localId(), role: "assistant", content: res.narration }]
              : [];
        if (next.length > 0) setTurns((prev) => [...prev, ...next]);
        // A decision-metric delta reaches the screen ONLY here, after recompute.
        if (res.applied_revisions.length > 0) onApplied?.(res.applied_revisions);
      } catch (e) {
        if (isAbortError(e)) {
          // User pressed Stop — silently return to idle (no error surfaced).
        } else if (e instanceof PennyError && e.kind === "ai_disabled") {
          setMuted(true);
        } else if (e instanceof PennyError && e.kind === "rejected") {
          // Penny relays the server's plain-language rejection as her own turn.
          setTurns((prev) => [
            ...prev,
            {
              id: localId(),
              role: "assistant",
              content: e.serverMessage ?? "Penny couldn't make that change.",
            },
          ]);
        } else if (e instanceof PennyError) {
          setError(errorView(e));
        } else {
          setError({
            message:
              "Something went wrong reaching Penny — your numbers and manual editing are unaffected.",
          });
        }
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [viewSlug, token, pending, muted, proposal, onApplied, localId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const newChat = useCallback(() => {
    setTurns([]);
    setError(null);
    setProposal(null);
  }, []);

  const body = (
    <>
      <PennyTranscript turns={turns} pending={pending} />
      {error && (
        <div
          data-testid="penny-error"
          role="alert"
          style={{
            margin: "0 1rem 0.5rem",
            padding: "0.5rem 0.625rem",
            borderRadius: "8px",
            border: "1px solid var(--line, #e2e2e2)",
            background: "var(--surface-alt, #f7f7f5)",
            color: "var(--text, #1a1a1a)",
            fontSize: "0.8125rem",
          }}
        >
          {/* Icon is decorative; the text carries the meaning (not color alone). */}
          <span aria-hidden="true">⚠ </span>
          {error.message}
        </div>
      )}
    </>
  );

  return (
    <PennyDrawer
      aiEnabled={aiEnabled}
      provider={provider}
      settingsHref={settingsHref}
      onOpenSettings={onOpenSettings}
      avatarSrc={avatarSrc}
      onNewChat={newChat}
      composer={
        <LiveComposer
          pending={pending}
          muted={muted}
          settingsHref={settingsHref}
          onOpenSettings={onOpenSettings}
          onSend={send}
          onStop={stop}
          extraAffordance={
            <ProposalUpload
              token={token}
              disabled={pending}
              attachedName={proposal?.name ?? null}
              onUploaded={(ref, name) => {
                setProposal({ ref, name });
                setError(null);
              }}
              onClear={() => setProposal(null)}
              onError={(message) => setError({ message })}
            />
          }
        />
      }
    >
      {body}
    </PennyDrawer>
  );
}

interface LiveComposerProps {
  pending: boolean;
  muted: boolean;
  settingsHref?: string;
  onOpenSettings?: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Surface-specific suggestion chips (defaults to the detail-page set). */
  chips?: string[];
  /** Extra composer affordance rendered beside the chips (e.g. the wizard's
   *  proposal-upload control, Spec §5.1/§9). Additive — omitted on the detail page. */
  extraAffordance?: ReactNode;
}

const SUGGESTION_CHIPS = ["Explain break-even", "Lower the rent", "Build my cost schedule"];

// The LIVE composer: multiline input + Send, a Stop control while a turn is in
// flight, and suggestion chips. When Penny is muted mid-chat (409 ai_disabled) it
// degrades to a Settings deep-link note — never a dead-end (spec §1/§8).
function LiveComposer({
  pending,
  muted,
  settingsHref = "/?settings=ai",
  onOpenSettings,
  onSend,
  onStop,
  chips = SUGGESTION_CHIPS,
  extraAffordance,
}: LiveComposerProps) {
  const [draft, setDraft] = useState("");
  const modal = useCoexistenceModal();

  if (muted) {
    return (
      <div
        data-testid="penny-muted-note"
        role="note"
        style={{
          borderTop: "1px solid var(--line, #e2e2e2)",
          padding: "0.75rem 1rem",
          fontSize: "0.8125rem",
          color: "var(--text-muted, #666)",
        }}
      >
        Penny is off.{" "}
        <a
          href={settingsHref}
          onClick={
            onOpenSettings
              ? (e) => {
                  e.preventDefault();
                  onOpenSettings();
                }
              : undefined
          }
        >
          Open Settings
        </a>{" "}
        to turn the AI assistant back on. Your numbers and manual editing are unaffected.
      </div>
    );
  }

  const submit = () => {
    const value = draft.trim();
    if (!value || pending) return;
    setDraft("");
    onSend(value);
  };

  return (
    <form
      data-testid="penny-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={composerFormStyle(modal)}
    >
      <div data-testid="penny-chips" style={chipRowStyle(modal)}>
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            disabled={pending}
            style={chipStyle(modal, pending)}
            onClick={() => setDraft(chip)}
          >
            {chip}
          </button>
        ))}
        {extraAffordance}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
        <textarea
          aria-label="Ask Penny"
          placeholder="Ask Penny…"
          rows={2}
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline (chat convention, keyboard-first).
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          style={composerTextareaStyle(modal)}
        />
        {pending ? (
          <button
            type="button"
            onClick={onStop}
            style={{
              padding: "0.5rem 0.875rem",
              minHeight: modal ? TOUCH_TARGET : undefined,
              border: "1px solid var(--line, #e2e2e2)",
              borderRadius: "8px",
              background: "var(--surface, #fff)",
              color: "var(--text, #1a1a1a)",
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={draft.trim().length === 0}
            style={{
              ...composerSendStyle(modal),
              cursor: draft.trim().length === 0 ? "not-allowed" : "pointer",
              opacity: draft.trim().length === 0 ? 0.6 : 1,
            }}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}

// ============================================================================
// PennyDraftAssistant — the WIZARD's DRAFT-mode drawer (PE8, issue #127, Spec B
// §5.2/§7). The SAME left drawer, but every edit acts on the in-memory wizard
// draft via POST /api/penny/draft and PERSISTS NOTHING (no projection, no
// revision, no transcript row). She fills/refines any wizard field + builds the
// cost schedule; she narrates each edit; the mutated draft flows back into the
// wizard through `onApplyDraft`; and every applied field gets a per-field
// FieldChange affordance (recent change + "was X" + per-field undo, PE7). On
// Generate the HOST persists the draft (incl. any Penny-built schedule with
// provenance) and discards this ephemeral transcript. AI-disabled → the muted
// FAB (never a dead-end); the manual wizard stays fully intact. The component
// computes NOTHING — the returned draft is mapped/rendered verbatim (PRD §13).
// ============================================================================

/** Wizard-flavoured suggestion chips (the detail page keeps its own set). */
const WIZARD_CHIPS = ["Name my store", "Set my donor shares", "Build my cost schedule"];

export interface PennyDraftAssistantProps {
  /** Ephemeral session Bearer for /penny/draft (a rate-limit id only — there is no
   *  projection yet and NOTHING is persisted; never the URL/log). */
  token: string;
  /** Snapshot the current wizard draft as the server `draft_state` to send. */
  buildDraftState: () => PennyDraftState;
  /** Map Penny's mutated draft back into the wizard (the HOST owns the field mapping
   *  so this drawer stays wizard-agnostic). `applied` names exactly what changed. */
  onApplyDraft: (next: PennyDraftState, applied: PennyDraftApplied[]) => void;
  /** Revert ONE field to a previous value — a FORWARD draft edit (never history
   *  erasure); the host maps the server field key → the wizard setter. */
  onRevertField: (field: string, previousValue: unknown) => void;
  /** Human label for a server `changed[]` field key (e.g. "share_y1" → "Year-1 share"). */
  labelField?: (field: string) => string;
  /** AI opt-out / no key → muted FAB + Settings deep-link (never a dead-end). */
  aiEnabled?: boolean;
  provider?: PennyProvider;
  settingsHref?: string;
  onOpenSettings?: () => void;
  /** Proposal-upload seam — PE9 wires the actual parse_proposal flow (Spec §9). */
  onProposalSelected?: (file: File) => void;
  avatarSrc?: string;
}

/** One per-field change Penny applied to the draft, for the FieldChange affordance.
 *  `*Raw` carry the values needed to apply the change/undo back onto the wizard;
 *  `current`/`previous` are display strings rendered VERBATIM (no client formatting). */
interface DraftChange {
  key: string;
  field: string;
  label: string;
  current: string;
  previous: string;
  currentRaw: unknown;
  previousRaw: unknown;
  reverted: boolean;
}

/** Render an applied value verbatim; an absent/empty previous reads as an em dash. */
function changeText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export function PennyDraftAssistant({
  token,
  buildDraftState,
  onApplyDraft,
  onRevertField,
  labelField = (f) => f,
  aiEnabled = true,
  provider: initialProvider,
  settingsHref = "/?settings=ai",
  onOpenSettings,
  onProposalSelected,
  avatarSrc,
}: PennyDraftAssistantProps) {
  const [turns, setTurns] = useState<PennyTurn[]>([]);
  const [provider, setProvider] = useState<PennyProvider | undefined>(initialProvider);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PennyErrorView | null>(null);
  // `muted` = Penny got turned off mid-session (409 ai_disabled): the composer
  // degrades to a Settings note, distinct from the up-front muted FAB.
  const [muted, setMuted] = useState(false);
  const [changes, setChanges] = useState<DraftChange[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const localId = useCallback(() => `penny-draft-${(idRef.current += 1)}`, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending || muted) return;

      // Snapshot the draft we send so a cost-schedule build stays undoable to the
      // exact prior schedule (the per-field undo's "previous value", Spec §3).
      const sent = buildDraftState();
      const sentSchedule = (sent as { cost_schedule?: unknown }).cost_schedule;

      setTurns((prev) => [...prev, { id: localId(), role: "user", content: message }]);
      setError(null);
      setPending(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res: PennyDraftResponse = await sendPennyDraftMessage({
          token,
          message,
          draftState: sent,
          signal: controller.signal,
        });
        setProvider(res.provider);
        // Map the mutated draft back into the wizard (host owns the field mapping).
        onApplyDraft(res.draft, res.applied);

        // Build the per-field change affordances from exactly what Penny applied.
        const applied = res.applied ?? [];
        const nextChanges: DraftChange[] = [];
        let scheduleTouched = false;
        for (const entry of applied) {
          if (entry.tool === "edit_cost_schedule") scheduleTouched = true;
          for (const c of entry.changed ?? []) {
            nextChanges.push({
              key: c.field,
              field: c.field,
              label: labelField(c.field),
              current: changeText(c.now),
              previous: changeText(c.was),
              currentRaw: c.now,
              previousRaw: c.was,
              reverted: false,
            });
          }
        }
        if (scheduleTouched) {
          // The schedule has no single server display string; undo restores the
          // whole prior schedule (PE9 refines to per-row affordances).
          nextChanges.push({
            key: "cost_schedule",
            field: "cost_schedule",
            label: labelField("cost_schedule"),
            current: "Penny's schedule",
            previous: "your previous schedule",
            currentRaw: (res.draft as { cost_schedule?: unknown }).cost_schedule,
            previousRaw: sentSchedule,
            reverted: false,
          });
        }
        if (nextChanges.length > 0) {
          setChanges((prev) => {
            const byKey = new Map(prev.map((c) => [c.key, c]));
            for (const c of nextChanges) byKey.set(c.key, c);
            return Array.from(byKey.values());
          });
        }

        // Narrate the result (rendered VERBATIM — never a client-computed figure).
        if (res.narration) {
          setTurns((prev) => [
            ...prev,
            { id: localId(), role: "assistant", content: res.narration },
          ]);
        }
      } catch (e) {
        if (isAbortError(e)) {
          // Stop pressed — silently return to idle.
        } else if (e instanceof PennyError && e.kind === "ai_disabled") {
          setMuted(true);
        } else if (e instanceof PennyError && e.kind === "rejected") {
          // Penny relays the server's plain-language rejection as her own turn.
          setTurns((prev) => [
            ...prev,
            {
              id: localId(),
              role: "assistant",
              content: e.serverMessage ?? "Penny couldn't make that change.",
            },
          ]);
        } else if (e instanceof PennyError) {
          setError(errorView(e));
        } else {
          setError({
            message:
              "Something went wrong reaching Penny — your numbers and manual editing are unaffected.",
          });
        }
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [token, pending, muted, buildDraftState, onApplyDraft, labelField, localId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const newChat = useCallback(() => {
    setTurns([]);
    setChanges([]);
    setError(null);
  }, []);

  const undo = useCallback(
    (change: DraftChange) => {
      // Per-field undo is a FORWARD draft edit: set the field back to its prior
      // value (never erase history). The change re-renders as reverted + re-undoable.
      onRevertField(change.field, change.previousRaw);
      setChanges((prev) =>
        prev.map((c) =>
          c.key === change.key
            ? {
                ...c,
                current: c.previous,
                previous: c.current,
                currentRaw: c.previousRaw,
                previousRaw: c.currentRaw,
                reverted: !c.reverted,
              }
            : c,
        ),
      );
    },
    [onRevertField],
  );

  const body = (
    <>
      <PennyTranscript turns={turns} pending={pending} />

      {changes.length > 0 && (
        <div
          data-testid="penny-draft-changes"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            padding: "0 1rem 0.5rem",
          }}
        >
          {changes.map((c) => (
            <div
              key={c.key}
              style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}
            >
              <span
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  color: "var(--text-muted, #666)",
                }}
              >
                {c.label}
              </span>
              <FieldChange
                label={c.label}
                current={c.current}
                previous={c.previous}
                by="penny"
                reverted={c.reverted}
                onUndo={() => undo(c)}
                busy={pending}
              />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div
          data-testid="penny-error"
          role="alert"
          style={{
            margin: "0 1rem 0.5rem",
            padding: "0.5rem 0.625rem",
            borderRadius: "8px",
            border: "1px solid var(--line, #e2e2e2)",
            background: "var(--surface-alt, #f7f7f5)",
            color: "var(--text, #1a1a1a)",
            fontSize: "0.8125rem",
          }}
        >
          <span aria-hidden="true">⚠ </span>
          {error.message}
        </div>
      )}
    </>
  );

  // The proposal-upload affordance (Spec §5.1/§9). PE8 only wires the SEAM —
  // selecting a PDF hands the File to the host; PE9 fills the parse_proposal flow.
  const uploadAffordance = (
    <label
      data-testid="penny-proposal-upload"
      style={{
        fontSize: "0.75rem",
        padding: "0.2rem 0.55rem",
        border: "1px dashed var(--line, #b9b9b9)",
        borderRadius: "999px",
        background: "var(--surface, #fff)",
        color: "var(--brand-deep, #1d4733)",
        cursor: "pointer",
      }}
    >
      Upload proposal (PDF)
      <input
        data-testid="penny-proposal-input"
        type="file"
        accept="application/pdf,.pdf"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          border: 0,
        }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onProposalSelected?.(file);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <PennyDrawer
      aiEnabled={aiEnabled}
      provider={provider}
      settingsHref={settingsHref}
      onOpenSettings={onOpenSettings}
      avatarSrc={avatarSrc}
      onNewChat={newChat}
      composer={
        <LiveComposer
          pending={pending}
          muted={muted}
          settingsHref={settingsHref}
          onOpenSettings={onOpenSettings}
          onSend={send}
          onStop={stop}
          chips={WIZARD_CHIPS}
          extraAffordance={uploadAffordance}
        />
      }
    >
      {body}
    </PennyDrawer>
  );
}

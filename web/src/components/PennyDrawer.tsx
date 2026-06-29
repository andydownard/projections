// web/src/components/PennyDrawer.tsx — Penny LEFT slide-out drawer shell (PE1).
//
// This is the SHELL only: the collapsed FAB, the fly-in panel (a de-cruft header +
// body slot + composer slot), and the AI-disabled fallback. NO backend is wired here
// — there are no `/penny` calls, no streaming, no mutation. PE6/PE8 mount this into
// the detail page / wizard and inject the live transcript + composer; this file just
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
//
// Header is intentionally minimal — just the avatar + "Penny". There is NO provider
// disclosure line, NO info popover, NO "New chat" and NO "×" close button. Closing is
// never a dead-end: Esc closes, clicking the scrim closes (modal sheet), and
// re-clicking the Penny FAB toggles the drawer shut.
//
// Non-obscuring layout (spec §10): on a wide (≥1180px) non-modal screen the open
// panel publishes `data-penny-open` on <body>; tokens.css insets the page main column
// to the right of the 380px drawer so page content is PUSHED, never overlaid (the
// center stays interactive). Below 1180px it is a modal full-screen sheet.
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
import {
  OverrideAudit,
  type OverrideAuditItem,
  type OverrideCommentTarget,
} from "./OverrideAudit";
import { PENNY_MESSAGE_FONT_SIZE, PennyTranscript, type PennyTurn } from "./PennyTranscript";
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

/** A contextual quick-reply suggestion chip. These are shown ONLY when the chat
 *  context genuinely merits a prompt (decision #11) — never always-on. */
export interface QuickReply {
  id: string;
  label: string;
  onSelect: () => void;
}

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
  /** Avatar asset (served statically from web/public). */
  avatarSrc?: string;
  /** Body content (the transcript). Defaults to an empty PennyTranscript shell. */
  children?: ReactNode;
  /** Composer override. Defaults to the built-in composer shell. */
  composer?: ReactNode;
  /** Contextual quick-reply chips for the default composer — shown ONLY when the
   *  chat context merits them (decision #11); omitted → no chip row at all. Ignored
   *  when a `composer` override is supplied. */
  quickReplies?: QuickReply[];
  /** Controlled open state (optional). Uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const BRAND = "#35644f";

/** The desktop (non-modal) panel width — kept in sync with the page push-inset in
 *  tokens.css (`body[data-penny-open] .app__main`) so the drawer never overlays page
 *  content on wide screens (spec §10). */
const PANEL_WIDTH = 380;

/** Comfortable touch target for the mobile full-screen sheet's sticky controls
 *  (composer), per the PE12 mobile-375 / a11y pass (issue #131, spec §5). */
const TOUCH_TARGET = 44;

/** The collapsed FAB is a BOTTOM-LEFT pull-tab, flush against the left edge. Anchoring
 *  it to the bottom keeps it clear of the page HEADER band at the top of the content
 *  column, so it never overlaps the home "Your projections" H1, the "← Back to
 *  projections" breadcrumb, or the top bar's "App suggestion" button at ANY viewport
 *  (a top-anchored tab collided with that band once the centered frame gutter collapses
 *  on narrow screens). The bottom corner is empty on the short wizard steps (the form +
 *  its Back/Next actions sit well above it), and on the long detail page the tab auto-
 *  hides the moment the reader scrolls — so it never sits over an interactive control
 *  (QA P2). The drawer it opens still slides out from the left edge
 *  (`translateX(-100%)→0`). On scroll-down the tab slides DOWN off the bottom edge. */
const FAB_BOTTOM = "1.5rem";

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

/** Paper-airplane send glyph (decorative — the button carries an aria-label). */
function SendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

/** LEFT-pointing chevron for the in-drawer back/close control: it slides the LEFT
 *  drawer back toward the left edge (spec §5, issue #264). Decorative — the button
 *  carries an aria-label. */
function BackArrowIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 18l-6-6 6-6" />
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
  avatarSrc: string;
  body: ReactNode;
  composer: ReactNode;
  onClose: () => void;
}

// The fly-in panel. Mounts fresh on each open so the enter animation replays and
// focus lands inside the dialog every time.
function PennyPanel({
  labelId,
  modal,
  autoFocus,
  reducedMotion,
  avatarSrc,
  body,
  composer,
  onClose,
}: PennyPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
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

  // Focus moves INTO the drawer on open (the dialog itself, which is focusable via
  // tabIndex=-1) — UNLESS the coordinator suppressed it because a sibling panel is
  // already open beside it on the desktop (no focus steal, one focus ring; spec §10).
  // There is no header close button to land on; the dialog is the focus anchor and
  // Esc / scrim / the FAB toggle all close without a dead-end (spec §1).
  useEffect(() => {
    if (autoFocusOnMount.current) panelRef.current?.focus();
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

  // Non-obscuring push (spec §10): on the wide (non-modal) desktop, publish
  // `data-penny-open` on <body> so tokens.css insets the page main column to the
  // RIGHT of the drawer — page content is pushed, never overlaid. The modal sheet
  // covers the page (content behind it is fine), so it sets nothing.
  useEffect(() => {
    if (modal || typeof document === "undefined") return;
    document.body.setAttribute("data-penny-open", "true");
    return () => {
      document.body.removeAttribute("data-penny-open");
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
    width: modal ? "100%" : `${PANEL_WIDTH}px`,
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
    outline: "none",
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
        tabIndex={-1}
        onKeyDown={onTrapKeyDown}
        style={panelStyle}
      >
        {/* Header: avatar + name + a LEFT-pointing back arrow that slides the drawer
            closed (spec §5, issue #264). Still no provider line, info or New chat —
            and Esc / scrim continue to close too, so it is never a dead-end. */}
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
          <h2
            id={labelId}
            style={{ margin: 0, fontSize: "1rem", lineHeight: 1.2, flex: "1 1 auto" }}
          >
            Penny AI
          </h2>
          {/* LEFT-pointing arrow → slides the drawer back/closed; the FAB tab is
              hidden while open, so this is the in-drawer close affordance. */}
          <button
            type="button"
            data-testid="penny-back"
            aria-label="Close Penny"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 auto",
              width: modal ? TOUCH_TARGET : 36,
              height: modal ? TOUCH_TARGET : 36,
              minWidth: modal ? TOUCH_TARGET : undefined,
              minHeight: modal ? TOUCH_TARGET : undefined,
              padding: 0,
              border: "1px solid var(--line, #e2e2e2)",
              borderRadius: "10px",
              background: "var(--surface, #fff)",
              color: "var(--text, #1a1a1a)",
              cursor: "pointer",
            }}
          >
            <BackArrowIcon />
          </button>
        </header>

        {/* Body slot (the transcript). */}
        {body}

        {/* Composer slot. */}
        {composer}
      </div>
    </>
  );
}

/** Contextual quick-reply chips. Renders NOTHING when there is no contextual
 *  suggestion to offer — the chip row appears ONLY when the chat context merits it
 *  (decision #11), never always-on. Each chip is a brand-outlined pill. */
function QuickReplies({ replies, modal }: { replies?: QuickReply[]; modal: boolean }) {
  if (!replies || replies.length === 0) return null;
  return (
    <div
      data-testid="penny-quick-replies"
      role="group"
      aria-label="Suggested replies"
      style={quickRepliesRowStyle(modal)}
    >
      {replies.map((r) => (
        <button key={r.id} type="button" onClick={r.onSelect} style={quickReplyChipStyle}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// The composer FIELD (decision #23): a single rounded input with the paper-airplane
// send button nested INSIDE it (absolute, bottom-right) — not a sibling button beside
// the input. The trailing control is injected (Send by default; Stop while a turn
// streams). Enter sends, Shift+Enter inserts a newline; the input font matches the
// transcript bubbles for one consistent reading size (spec §4).
function ComposerField({
  modal,
  value,
  disabled,
  onChange,
  onSubmit,
  trailing,
}: {
  modal: boolean;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  trailing: ReactNode;
}) {
  return (
    <div data-testid="penny-field" style={composerFieldWrapStyle}>
      <textarea
        aria-label="Ask Penny"
        placeholder="Ask Penny anything…"
        rows={3}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline (chat convention, keyboard-first).
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        style={composerFieldTextareaStyle(modal)}
      />
      {trailing}
    </div>
  );
}

/** The in-field paper-airplane Send button (decision #23) — a labelled icon button
 *  positioned absolutely at the bottom-right of the field. */
function InFieldSend({ modal, disabled }: { modal: boolean; disabled: boolean }) {
  return (
    <button type="submit" aria-label="Send" disabled={disabled} style={inFieldSendStyle(modal, disabled)}>
      <SendIcon />
    </button>
  );
}

// Default composer shell — the in-field paper-airplane composer. No backend: Enter /
// Send are no-ops here (the live composers wire the real send), but the keyboard
// contract is identical — Enter sends, Shift+Enter inserts a newline (spec §5).
function DefaultComposer({ quickReplies }: { quickReplies?: QuickReply[] }) {
  const [draft, setDraft] = useState("");
  const modal = useCoexistenceModal();
  const canSend = draft.trim().length > 0;
  const submit = () => {
    if (canSend) setDraft("");
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
      <QuickReplies replies={quickReplies} modal={modal} />
      <ComposerField
        modal={modal}
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        trailing={<InFieldSend modal={modal} disabled={!canSend} />}
      />
    </form>
  );
}

// ---- Shared composer styling (mobile full-screen sheet ⇄ desktop panel, PE12). ----
// On the mobile sheet (`modal`) the composer sticks above the on-screen keyboard with
// a safe-area inset and every control is a 44px touch target. The input is a roomy,
// resizable, multi-line field; its font matches the transcript (spec §4).

function composerFormStyle(modal: boolean): CSSProperties {
  return {
    borderTop: "1px solid var(--line, #e2e2e2)",
    padding: "0.75rem 1rem",
    // Keep the composer clear of the iOS home indicator / rounded corners.
    paddingBottom: modal ? "max(0.875rem, env(safe-area-inset-bottom))" : "0.875rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  };
}

/** A row for an extra composer affordance (e.g. the proposal-upload control) when a
 *  live composer provides one. The redundant wizard suggestion chips are gone — the
 *  wizard already collects name/address/households/shares/costs (spec §3). */
function affordanceRowStyle(modal: boolean): CSSProperties {
  return {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    flexWrap: modal ? "nowrap" : "wrap",
    overflowX: modal ? "auto" : "visible",
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "thin",
  };
}

/** Contextual quick-reply chip row — same scroll/wrap behaviour as the affordance row. */
function quickRepliesRowStyle(modal: boolean): CSSProperties {
  return {
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
    flexWrap: modal ? "nowrap" : "wrap",
    overflowX: modal ? "auto" : "visible",
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "thin",
  };
}

/** Brand-outlined pill for a contextual quick-reply chip (--text-sm). */
const quickReplyChipStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: "0.75rem",
  padding: "0.3rem 0.7rem",
  border: "1px solid var(--brand-primary, #35644f)",
  borderRadius: "999px",
  background: "var(--surface, #fff)",
  color: "var(--brand-deep, #1d4733)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// ---- In-field composer (decision #23): the send/stop control sits INSIDE the input. ----

/** The field is the positioning context for the absolutely-placed in-field button. */
const composerFieldWrapStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
};

function composerFieldTextareaStyle(modal: boolean): CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
    // Roomy, multi-line, comfortable; still ≥44px touch target on the mobile sheet.
    minHeight: modal ? TOUCH_TARGET : "5.5rem",
    padding: "0.625rem 0.75rem",
    // Leave room for the in-field send/stop button at the bottom-right.
    paddingRight: "3rem",
    border: "1px solid var(--line, #e2e2e2)",
    borderRadius: "12px",
    fontFamily: "inherit",
    fontSize: PENNY_MESSAGE_FONT_SIZE,
    lineHeight: 1.5,
  };
}

function inFieldSendStyle(modal: boolean, disabled: boolean): CSSProperties {
  return {
    position: "absolute",
    right: "0.4rem",
    bottom: "0.4rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: modal ? TOUCH_TARGET : 34,
    height: modal ? TOUCH_TARGET : 34,
    minHeight: modal ? TOUCH_TARGET : undefined,
    minWidth: modal ? TOUCH_TARGET : undefined,
    border: "none",
    borderRadius: "9px",
    background: BRAND,
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/** The in-field Stop control (swaps in for Send while a turn streams). */
function inFieldStopStyle(modal: boolean): CSSProperties {
  return {
    position: "absolute",
    right: "0.4rem",
    bottom: "0.4rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: modal ? TOUCH_TARGET : 34,
    minHeight: modal ? TOUCH_TARGET : undefined,
    padding: "0 0.75rem",
    border: "1px solid var(--line, #e2e2e2)",
    borderRadius: "9px",
    background: "var(--surface, #fff)",
    color: "var(--text, #1a1a1a)",
    cursor: "pointer",
  };
}

export function PennyDrawer({
  aiEnabled = true,
  settingsHref = "/?settings=ai",
  onOpenSettings,
  avatarSrc = "/penny-avatar.png",
  children,
  composer,
  quickReplies,
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

  // Collapsed-FAB scroll auto-hide/return (spec §5.1): hide on scroll-down, show on
  // up — but never while the drawer is open (the FAB stays available to toggle it
  // closed).
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
          // Bottom-left pull-tab (mirrors the enabled FAB) so it never overlaps the
          // page header / breadcrumb band at any viewport.
          left: 0,
          bottom: FAB_BOTTOM,
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
  const composerNode = composer ?? <DefaultComposer quickReplies={quickReplies} />;

  // The FAB tab DISAPPEARS while the drawer is open (spec §5, issue #264): the
  // in-drawer LEFT-pointing back arrow is the close affordance, so the tab does not
  // sit on top of the open panel. It reappears the moment the drawer closes. It also
  // auto-hides on scroll-down while CLOSED. It stays MOUNTED (not unmounted) while
  // hidden so `close()` can return focus to it without dropping the user to the
  // document top.
  const hidden = open || fabHidden;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        data-testid="penny-fab"
        data-state="ai-enabled"
        data-scroll-hidden={hidden}
        aria-label="Penny AI"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Hidden while open, so this toggle effectively only ever OPENS; the back
        // arrow / Esc / scrim close it.
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          position: "fixed",
          // FLUSH against the left edge (no inset), anchored to the BOTTOM, so the tab
          // clears the page header / breadcrumb band at every viewport and sits in the
          // empty zone below the short wizard form. The drawer it opens slides out from
          // this same left edge (spec §5.1, #131).
          left: 0,
          bottom: FAB_BOTTOM,
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
          // The hidden state (open OR scroll-down) slides the tab DOWN off the bottom
          // edge (it is bottom-anchored). Transition suppressed under reduced-motion.
          transform: hidden ? "translateY(150%)" : "translateY(0)",
          opacity: hidden ? 0 : 1,
          pointerEvents: hidden ? "none" : "auto",
          transition: reducedMotion
            ? "none"
            : "transform 200ms ease, opacity 200ms ease",
        }}
      >
        <PennyAvatar src={avatarSrc} size={36} />
        <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>Penny AI</span>
      </button>

      {open && (
        <PennyPanel
          labelId={labelId}
          modal={modal}
          autoFocus={panel.autoFocus()}
          reducedMotion={reducedMotion}
          avatarSrc={avatarSrc}
          body={body}
          composer={composerNode}
          onClose={close}
        />
      )}
    </>
  );
}

// ============================================================================
// PennyAssistant — the LIVE detail-page drawer (PE6). Wires the shell above to
// POST …/penny: apply-immediately + narrate, streaming with Stop, and graceful
// AI-off / unavailable / rate-limit handling. The component still computes NOTHING:
// it relays the user's message and renders the server's turns + narration VERBATIM.
// A decision-metric delta reaches the screen only once the engine recomputes and the
// host page refetches the view-model (via `onApplied`) — Penny never streams a
// number (spec §2/§5.1/§8, issue #125).
// ============================================================================

export interface PennyAssistantProps {
  /** The saved projection's view_slug (the POST …/penny path key). */
  viewSlug: string;
  /** The caller's owner/edit Bearer token (header only — never the URL/log). */
  token: string;
  /** AI opt-out / no key → muted FAB + Settings deep-link (never a dead-end). */
  aiEnabled?: boolean;
  /** Provider seam (accepted for back-compat; no longer surfaced in the header). */
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
  // ---- Override audit + comment capture (Epic G2, decision #42, #266). The
  // standalone right-edge Override Inspector is eliminated; its function lives in
  // Penny's drawer: the at-a-glance audit + a focused justification prompt that
  // persists on the override through the EXISTING contract (no data-model change).
  /** The pinned overrides to audit inside the drawer (server display strings). */
  overrides?: OverrideAuditItem[];
  /** Reset a pin — a host-owned forward edit clearing the override. */
  onResetPin?: (node: string, year: number) => void;
  /** Request the focused override-comment prompt for an override. */
  onComment?: (node: string, year: number) => void;
  /** The override being justified now — renders Penny's focused comment prompt. */
  commentTarget?: OverrideCommentTarget | null;
  /** Existing note to seed the comment prompt. */
  commentInitial?: string;
  /** Persist the justification onto the override (existing override contract). */
  onSubmitComment?: (node: string, year: number, note: string) => void;
  /** Dismiss the comment prompt without saving. */
  onCancelComment?: () => void;
  /** Controlled drawer open — lets the host SLIDE Penny OUT to capture a comment. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  settingsHref,
  onOpenSettings,
  initialTurns = [],
  onApplied,
  avatarSrc,
  overrides = [],
  onResetPin,
  onComment,
  commentTarget = null,
  commentInitial = "",
  onSubmitComment,
  onCancelComment,
  open,
  onOpenChange,
}: PennyAssistantProps) {
  const [turns, setTurns] = useState<PennyTurn[]>(initialTurns);
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

  // The relocated overrides audit + the focused justification prompt (decision #42).
  // Shown when there is something to audit OR an override is being justified — so an
  // empty projection never grows a stray section. It sits ABOVE the transcript so the
  // "why did you override …?" prompt is the first thing a slid-out Penny presents.
  const showAudit = overrides.length > 0 || !!commentTarget;

  const body = (
    <>
      {showAudit && (
        <OverrideAudit
          overrides={overrides}
          onResetPin={onResetPin}
          onComment={onComment}
          commentFor={commentTarget}
          commentInitial={commentInitial}
          onSubmitComment={onSubmitComment}
          onCancelComment={onCancelComment}
        />
      )}
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
      settingsHref={settingsHref}
      onOpenSettings={onOpenSettings}
      avatarSrc={avatarSrc}
      open={open}
      onOpenChange={onOpenChange}
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
  /** Extra composer affordance rendered above the input (e.g. the wizard's
   *  proposal-upload control, Spec §5.1/§9). Additive — omitted on the detail page. */
  extraAffordance?: ReactNode;
  /** Contextual quick-reply chips, shown ONLY when the chat context merits them
   *  (decision #11) — omitted → no chip row. */
  quickReplies?: QuickReply[];
}

// The LIVE composer: a roomy multiline input + a paper-airplane Send, with a Stop
// control while a turn is in flight. Enter sends, Shift+Enter inserts a newline.
// When Penny is muted mid-chat (409 ai_disabled) it degrades to a Settings deep-link
// note — never a dead-end (spec §1/§8). The redundant suggestion chips are gone (the
// wizard already collects those inputs, spec §3); only a genuinely non-redundant
// affordance (proposal upload) remains.
function LiveComposer({
  pending,
  muted,
  settingsHref = "/?settings=ai",
  onOpenSettings,
  onSend,
  onStop,
  extraAffordance,
  quickReplies,
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
  const canSend = draft.trim().length > 0;

  return (
    <form
      data-testid="penny-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={composerFormStyle(modal)}
    >
      <QuickReplies replies={quickReplies} modal={modal} />
      {extraAffordance && (
        <div data-testid="penny-affordances" style={affordanceRowStyle(modal)}>
          {extraAffordance}
        </div>
      )}
      <ComposerField
        modal={modal}
        value={draft}
        disabled={pending}
        onChange={setDraft}
        onSubmit={submit}
        trailing={
          pending ? (
            <button type="button" onClick={onStop} style={inFieldStopStyle(modal)}>
              Stop
            </button>
          ) : (
            <InFieldSend modal={modal} disabled={!canSend} />
          )
        }
      />
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
  /** Provider seam (accepted for back-compat; no longer surfaced in the header). */
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
  settingsHref = "/?settings=ai",
  onOpenSettings,
  onProposalSelected,
  avatarSrc,
}: PennyDraftAssistantProps) {
  const [turns, setTurns] = useState<PennyTurn[]>([]);
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
        padding: "0.3rem 0.6rem",
        border: "1px dashed var(--line, #b9b9b9)",
        borderRadius: "999px",
        background: "var(--surface, #fff)",
        color: "var(--brand-deep, #1d4733)",
        cursor: "pointer",
        whiteSpace: "nowrap",
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
      settingsHref={settingsHref}
      onOpenSettings={onOpenSettings}
      avatarSrc={avatarSrc}
      composer={
        <LiveComposer
          pending={pending}
          muted={muted}
          settingsHref={settingsHref}
          onOpenSettings={onOpenSettings}
          onSend={send}
          onStop={stop}
          extraAffordance={uploadAffordance}
        />
      }
    >
      {body}
    </PennyDrawer>
  );
}

// ============================================================================
// PennyGeneralAssistant — the GENERAL-HELP drawer mounted by the App shell on
// routes with NO projection loaded (home/list, read-only detail view) so Penny is
// openable on EVERY route (#264, Epic E #3). There is no view_slug and no edit
// token here, so there is NO mutate/narrate backend to call: she greets, points the
// user at creating or opening a projection, and answers with a fixed, code-owned
// help reply. She NEVER fabricates a number (there is no projection to read) and she
// NEVER errors on a projection-less route. With AI opt-out she degrades to the muted
// Settings FAB (never a dead-end), exactly like the live drawers.
// ============================================================================

export interface PennyGeneralAssistantProps {
  /** AI opt-out / no key → muted FAB + Settings deep-link (never a dead-end). */
  aiEnabled?: boolean;
  settingsHref?: string;
  onOpenSettings?: () => void;
  avatarSrc?: string;
}

/** Penny's greeting when no projection is loaded — general, not projection-scoped. */
const PENNY_GENERAL_GREETING =
  "Hi, I'm Penny. I can help you plan a thrift-store launch. Start a new projection " +
  "or open a saved one, and I'll help you fill in the details, build a cost schedule, " +
  "and make sense of the numbers.";

/** Penny's fixed reply on a projection-less route — she points to the real flow and
 *  is explicit that every figure comes from a saved projection (no client math). */
const PENNY_GENERAL_REPLY =
  "Open or start a projection and I can get to work — I'll set any field, build your " +
  "cost schedule, and walk through every figure. I never make up numbers; they all " +
  "come from your saved projection.";

export function PennyGeneralAssistant({
  aiEnabled = true,
  settingsHref,
  onOpenSettings,
  avatarSrc,
}: PennyGeneralAssistantProps) {
  const [turns, setTurns] = useState<PennyTurn[]>([]);
  const idRef = useRef(0);

  const reply = useCallback((text: string) => {
    const message = text.trim();
    if (!message) return;
    const userId = `penny-general-${(idRef.current += 1)}`;
    const botId = `penny-general-${(idRef.current += 1)}`;
    setTurns((prev) => [
      ...prev,
      { id: userId, role: "user", content: message },
      { id: botId, role: "assistant", content: PENNY_GENERAL_REPLY },
    ]);
  }, []);

  return (
    <PennyDrawer
      aiEnabled={aiEnabled}
      settingsHref={settingsHref}
      onOpenSettings={onOpenSettings}
      avatarSrc={avatarSrc}
      composer={
        <LiveComposer
          pending={false}
          muted={false}
          settingsHref={settingsHref}
          onOpenSettings={onOpenSettings}
          onSend={reply}
          onStop={() => {}}
        />
      }
    >
      <PennyTranscript turns={turns} intro={PENNY_GENERAL_GREETING} />
    </PennyDrawer>
  );
}

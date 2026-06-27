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

import { PennyTranscript, type PennyTurn } from "./PennyTranscript";
import { PennyError, sendPennyMessage, type PennyTurnDTO } from "../api/penny";

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

/** Below 1180px Penny is a modal full-screen sheet; at/above it is a non-modal panel (spec §10). */
function useIsModal(): boolean {
  const get = () => !mediaMatches("(min-width: 1180px)", false);
  const [modal, setModal] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(min-width: 1180px)");
    const onChange = () => setModal(!mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return modal;
}

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

  // Slide in: start off-screen, settle to 0. Reduced-motion → settle immediately.
  useEffect(() => {
    if (reducedMotion) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  // Focus the close button on open (focus moves into the drawer).
  useEffect(() => {
    closeRef.current?.focus();
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
    zIndex: 52,
    display: "flex",
    flexDirection: "column",
    width: modal ? "100%" : "380px",
    maxWidth: "100vw",
    background: "var(--surface, #ffffff)",
    borderRight: "1px solid var(--line, #e2e2e2)",
    boxShadow: "0 0 24px rgba(0,0,0,0.18)",
    transform: entered ? "translateX(0)" : "translateX(-100%)",
    transition: reducedMotion ? "none" : "transform 240ms ease",
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
            zIndex: 51,
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
            style={iconBtnStyle}
          >
            <span aria-hidden="true" style={{ fontWeight: 700 }}>
              i
            </span>
          </button>
          <button
            type="button"
            onClick={onNewChat}
            style={{
              ...iconBtnStyle,
              width: "auto",
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
            style={iconBtnStyle}
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
  return (
    <form
      data-testid="penny-composer"
      onSubmit={(e) => e.preventDefault()}
      style={{
        borderTop: "1px solid var(--line, #e2e2e2)",
        padding: "0.625rem 1rem 0.75rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
        {["Explain break-even", "Lower the rent", "Build my cost schedule"].map((chip) => (
          <button
            key={chip}
            type="button"
            style={{
              fontSize: "0.75rem",
              padding: "0.2rem 0.55rem",
              border: "1px solid var(--line, #e2e2e2)",
              borderRadius: "999px",
              background: "var(--surface, #fff)",
              color: "var(--brand-deep, #1d4733)",
              cursor: "pointer",
            }}
            onClick={() => setDraft(chip)}
          >
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
          style={{
            flex: "1 1 auto",
            resize: "vertical",
            minHeight: "2.5rem",
            padding: "0.5rem",
            border: "1px solid var(--line, #e2e2e2)",
            borderRadius: "8px",
            font: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          style={{
            padding: "0.5rem 0.875rem",
            border: "none",
            borderRadius: "8px",
            background: BRAND,
            color: "#fff",
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
  const reducedMotion = usePrefersReducedMotion();
  const modal = useIsModal();
  const labelId = useId();

  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const fabRef = useRef<HTMLButtonElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
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
          left: "1rem",
          bottom: "1rem",
          zIndex: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          height: "48px",
          padding: "0 0.875rem",
          borderRadius: "999px",
          border: "1px dashed var(--line, #b9b9b9)",
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
          left: "1rem",
          bottom: "1rem",
          zIndex: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          height: "48px",
          padding: "0 0.875rem 0 0.4rem",
          borderRadius: "999px",
          border: "none",
          background: BRAND,
          color: "#fff",
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          // Scroll auto-hide; transition suppressed under reduced-motion.
          transform: fabHidden ? "translateY(150%)" : "translateY(0)",
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
          signal: controller.signal,
        });
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
    [viewSlug, token, pending, muted, onApplied, localId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const newChat = useCallback(() => {
    setTurns([]);
    setError(null);
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
}: LiveComposerProps) {
  const [draft, setDraft] = useState("");

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
      style={{
        borderTop: "1px solid var(--line, #e2e2e2)",
        padding: "0.625rem 1rem 0.75rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
        {SUGGESTION_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            disabled={pending}
            style={{
              fontSize: "0.75rem",
              padding: "0.2rem 0.55rem",
              border: "1px solid var(--line, #e2e2e2)",
              borderRadius: "999px",
              background: "var(--surface, #fff)",
              color: "var(--brand-deep, #1d4733)",
              cursor: pending ? "not-allowed" : "pointer",
            }}
            onClick={() => setDraft(chip)}
          >
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
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline (chat convention, keyboard-first).
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          style={{
            flex: "1 1 auto",
            resize: "vertical",
            minHeight: "2.5rem",
            padding: "0.5rem",
            border: "1px solid var(--line, #e2e2e2)",
            borderRadius: "8px",
            font: "inherit",
          }}
        />
        {pending ? (
          <button
            type="button"
            onClick={onStop}
            style={{
              padding: "0.5rem 0.875rem",
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
              padding: "0.5rem 0.875rem",
              border: "none",
              borderRadius: "8px",
              background: BRAND,
              color: "#fff",
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

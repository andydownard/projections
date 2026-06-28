// web/src/components/PennyTranscript.tsx — Penny conversation log.
//
// The transcript is an `aria-live=polite` `role="log"` region so assistant turns
// arrive without stealing focus from the composer (spec §5.1). It renders whatever
// turns it is handed and, before the first turn, a friendly INTRO from Penny so the
// drawer never opens to a cold, empty box.
//
// It computes NOTHING and formats NOTHING — turn content is rendered verbatim.
// Decision-metric numbers only ever arrive already formatted by the server
// (CLAUDE.md: server is the one math + formatting authority), so this component
// never derives a figure.
//
// Presentation polish (Anthropic-style, spec §5/§7): Penny's assistant turns render
// in a distinct "paper" bubble with a TYPEWRITER reveal + a blinking cursor, and an
// in-flight "thinking…" indicator (blinking cursor) shows while her response isn't
// ready. The typewriter is a PRESENTATION effect over the FINAL, already-grounded
// text the server returned — it never streams a number ahead of the engine
// (spec §5.1). `prefers-reduced-motion` → settled render (no typewriter, no blink).
import { useEffect, useState, type ReactNode } from "react";

export type PennyRole = "user" | "assistant" | "tool";

export interface PennyTurn {
  /** Stable key for the turn (server turn id once wired; local id in the shell). */
  id: string;
  role: PennyRole;
  /** Already-rendered content; the server is the formatting authority. */
  content: ReactNode;
}

export interface PennyTranscriptProps {
  turns?: PennyTurn[];
  /**
   * Penny's opening message, shown as a settled assistant turn before the first
   * real turn. Friendly + scoped: she introduces herself and offers to help.
   */
  intro?: string;
  /**
   * While Penny's turn is in flight, render a "thinking…" indicator at the foot of
   * the log (announced by the polite live region). It is a STATUS, never a number:
   * the client never streams a figure — decision-metric deltas land only once the
   * engine recomputes and the page refetches the view-model (spec §5.1). The text
   * carries the meaning, so it is legible without color (a11y).
   */
  pending?: boolean;
}

const ROLE_LABEL: Record<PennyRole, string> = {
  user: "You",
  assistant: "Penny",
  tool: "Penny (tool)",
};

/** ONE message font size shared with the composer textarea (PennyDrawer) so the
 *  transcript and the input read at the same comfortable size (spec §4). */
export const PENNY_MESSAGE_FONT_SIZE = "0.9375rem";

const DEFAULT_INTRO =
  "Hi, I'm Penny. I'm happy to help you refine this projection and answer any questions about the numbers — just ask.";

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

/** A blinking caret (the `.penny-caret` blink + reduced-motion guard live in
 *  tokens.css; the caller also never mounts it under reduced-motion). Decorative —
 *  aria-hidden. */
function Caret() {
  return (
    <span
      className="penny-caret"
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: "0.5ch",
        marginLeft: "0.05em",
        color: "var(--brand-primary, #35644f)",
      }}
    >
      ▌
    </span>
  );
}

/**
 * Typewriter reveal over the FINAL grounded text (never a live number stream). The
 * complete string lands in the DOM the moment the reveal finishes, so the polite
 * live region announces the settled message and tests can find it. Reduced-motion →
 * the full text renders immediately with no caret.
 */
function TypewriterText({ text, reduced }: { text: string; reduced: boolean }) {
  const [count, setCount] = useState(reduced ? text.length : 0);

  useEffect(() => {
    const total = text.length;
    if (reduced || total === 0) {
      setCount(total);
      return;
    }
    setCount(0);
    // Reveal in a small, FIXED number of steps so any length settles quickly (the
    // complete string lands in the DOM the moment it finishes — the polite live
    // region announces the settled message and tests can find it).
    const steps = Math.min(total, 28);
    const stepSize = Math.ceil(total / steps);
    let shown = 0;
    const id = setInterval(() => {
      shown = Math.min(total, shown + stepSize);
      setCount(shown);
      if (shown >= total) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [text, reduced]);

  const done = count >= text.length;
  return (
    <>
      {/* The text lives in its OWN element so the settled string matches uniquely
          (testing-library reads direct text children). */}
      <span data-testid="penny-typed">{text.slice(0, count)}</span>
      {!reduced && !done && <Caret />}
    </>
  );
}

/** Anthropic-style assistant bubble: a soft "paper" card, distinct from the user's
 *  brand-tinted bubble, with the typewriter reveal applied to plain-string content. */
function AssistantBubble({
  content,
  reduced,
  testId,
}: {
  content: ReactNode;
  reduced: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-role="assistant"
      style={{ alignSelf: "flex-start", maxWidth: "92%" }}
    >
      <span style={roleLabelStyle}>{ROLE_LABEL.assistant}</span>
      <div style={assistantBubbleStyle}>
        {typeof content === "string" ? (
          <TypewriterText text={content} reduced={reduced} />
        ) : (
          // Non-string content (already-formatted nodes) renders settled — metric
          // deltas are never typed as if live (spec §5.1).
          content
        )}
      </div>
    </div>
  );
}

const roleLabelStyle = {
  display: "block",
  fontSize: "0.6875rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-muted, #5b655f)",
  marginBottom: "0.2rem",
} as const;

const assistantBubbleStyle = {
  fontSize: PENNY_MESSAGE_FONT_SIZE,
  lineHeight: 1.5,
  color: "var(--text, #1a201c)",
  background: "var(--surface-alt, #f5f6f4)",
  border: "1px solid var(--line, #d9ddd7)",
  borderRadius: "14px 14px 14px 4px",
  padding: "0.5rem 0.75rem",
} as const;

const userBubbleStyle = {
  fontSize: PENNY_MESSAGE_FONT_SIZE,
  lineHeight: 1.5,
  color: "#fff",
  background: "var(--brand-primary, #35644f)",
  borderRadius: "14px 14px 4px 14px",
  padding: "0.5rem 0.75rem",
} as const;

export function PennyTranscript({
  turns = [],
  intro = DEFAULT_INTRO,
  pending = false,
}: PennyTranscriptProps) {
  const reduced = usePrefersReducedMotion();

  return (
    <div
      data-testid="penny-transcript"
      role="log"
      aria-live="polite"
      aria-label="Penny conversation"
      style={{
        flex: "1 1 auto",
        overflowY: "auto",
        padding: "0.875rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      {/* Intro: Penny greets before the first real turn, so the drawer never opens
          cold. Styled as her assistant bubble; it types in like any of her turns. */}
      {turns.length === 0 && !pending && (
        <AssistantBubble testId="penny-transcript-empty" content={intro} reduced={reduced} />
      )}

      {turns.map((turn) =>
        turn.role === "assistant" || turn.role === "tool" ? (
          <AssistantBubble
            key={turn.id}
            testId="penny-turn"
            content={turn.content}
            reduced={reduced}
          />
        ) : (
          <div
            key={turn.id}
            data-testid="penny-turn"
            data-role={turn.role}
            style={{ alignSelf: "flex-end", maxWidth: "92%" }}
          >
            {/* Role is carried by text, never by color alone (a11y). */}
            <span style={{ ...roleLabelStyle, textAlign: "right" }}>{ROLE_LABEL[turn.role]}</span>
            <div style={userBubbleStyle}>{turn.content}</div>
          </div>
        ),
      )}

      {/* In-flight "thinking…" indicator — a STATUS, not a figure. The polite live
          region announces it; the text (not color) carries the meaning. A blinking
          caret animates while we wait (suppressed under reduced-motion). */}
      {pending && (
        <div data-testid="penny-pending" data-role="assistant" style={{ alignSelf: "flex-start" }}>
          <span style={roleLabelStyle}>{ROLE_LABEL.assistant}</span>
          <div
            style={{
              ...assistantBubbleStyle,
              color: "var(--text-muted, #5b655f)",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Penny is thinking…
            {!reduced && <Caret />}
          </div>
        </div>
      )}
    </div>
  );
}

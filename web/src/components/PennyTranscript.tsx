// web/src/components/PennyTranscript.tsx — Penny conversation log (shell, PE1).
//
// The transcript is an `aria-live=polite` `role="log"` region so assistant turns
// stream in without stealing focus from the composer (spec §5.1). This is the
// SHELL only: it renders whatever turns it is handed (none yet — no backend is
// wired in PE1) and an empty-state prompt otherwise. It computes NOTHING and
// formats NOTHING — turn content is rendered verbatim. Decision-metric numbers
// only ever arrive already formatted by the server (CLAUDE.md: server is the one
// math + formatting authority), so this component never derives a figure.
import type { ReactNode } from "react";

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
  /** Empty-state copy shown before the first turn. */
  emptyHint?: string;
  /**
   * While Penny's turn is in flight, render a working indicator at the foot of the
   * log (announced by the polite live region). It is a STATUS, never a number: the
   * client never streams a figure — decision-metric deltas land only once the
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

export function PennyTranscript({
  turns = [],
  emptyHint = "Ask Penny anything about this projection — she explains the numbers and can make changes you can undo.",
  pending = false,
}: PennyTranscriptProps) {
  return (
    <div
      data-testid="penny-transcript"
      role="log"
      aria-live="polite"
      aria-label="Penny conversation"
      style={{
        flex: "1 1 auto",
        overflowY: "auto",
        padding: "0.75rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.625rem",
      }}
    >
      {turns.length === 0 && !pending && (
        <p
          data-testid="penny-transcript-empty"
          style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: 0 }}
        >
          {emptyHint}
        </p>
      )}

      {turns.map((turn) => (
        <div
          key={turn.id}
          data-testid="penny-turn"
          data-role={turn.role}
          style={{
            alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "85%",
          }}
        >
          {/* Role is carried by text, never by color alone (a11y). */}
          <span
            style={{
              display: "block",
              fontSize: "0.6875rem",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-muted)",
            }}
          >
            {ROLE_LABEL[turn.role]}
          </span>
          <div style={{ fontSize: "0.875rem" }}>{turn.content}</div>
        </div>
      ))}

      {/* In-flight working indicator — a STATUS, not a figure. The polite live
          region announces it; the text (not color) carries the meaning. */}
      {pending && (
        <div
          data-testid="penny-pending"
          data-role="assistant"
          style={{ alignSelf: "flex-start", maxWidth: "85%" }}
        >
          <span
            style={{
              display: "block",
              fontSize: "0.6875rem",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-muted)",
            }}
          >
            {ROLE_LABEL.assistant}
          </span>
          <div style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>Penny is working…</div>
        </div>
      )}
    </div>
  );
}

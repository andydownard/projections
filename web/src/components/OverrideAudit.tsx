// web/src/components/OverrideAudit.tsx — the relocated "what's currently overridden"
// audit + the focused override-comment capture (Epic G2, decision #42, #266).
//
// This REPLACES the standalone right-edge Override Inspector panel. It is a plain
// PRESENTATIONAL surface (no side-panel chrome, no z-order, no focus trap, no FAB) so
// it drops straight INTO Penny's drawer body (the comment capture) and into the KPIs
// tab (the at-a-glance audit) — reusing Penny's texting drawer instead of fighting it.
//
// It computes NOTHING and formats NOTHING: every figure is the server's display string
// rendered VERBATIM (PRD §13). Resetting a pin and saving a justification note are
// host-owned FORWARD edits through the EXISTING override contract (PATCH overrides
// set/clear, key "{node}#{year}" -> {value, note, ts}); this component only renders the
// audit and RAISES those intents — it never touches the override data model or the
// server contract (decision #42: move WHERE the comment is captured, nothing else).
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

// Task 3.4 (design audit): static styling moved into tokens.css (.override-audit*)
// — the old inline styles hard-coded --brand-deep as a raw "#1d4733" constant and
// bypassed tokens.coverage.test.ts entirely. Only the CommentForm's own container/
// textarea/button-row layout stays inline below (already var()-driven, no raw hex).

/** One overridden DAG node, shaped for verbatim display (no client math). */
export interface OverrideAuditItem {
  /** DAG node id — the stable identity passed back to the reset / comment seams. */
  node: string;
  year: number;
  /** Human label, rendered verbatim (e.g. "Payroll, Year 1"). */
  label: string;
  /** Server display string of the pinned value, rendered verbatim. */
  value: string;
  /** Server display string of the calculated value it replaced, rendered verbatim. */
  calculated?: string;
  /** The justification note stored on the override (DATA_MODEL §4.6), verbatim. */
  note?: string;
  /** The pinned node has a stale upstream input (server-flagged, PRD §14). */
  stale?: boolean;
  /** A §12.2 guardrail requires a justification but none is recorded yet. */
  needsNote?: boolean;
}

/** The override currently being justified (drives the focused comment form). */
export interface OverrideCommentTarget {
  node: string;
  year: number;
  label: string;
}

export interface OverrideAuditProps {
  /** The overridden cells to audit (server display strings). */
  overrides: OverrideAuditItem[];
  /** Reset a pin — a host-owned forward edit (clears the pin → recompute → new
   *  revision). Omitted → a read-only audit with no reset affordance. */
  onResetPin?: (node: string, year: number) => void;
  /** Request the focused comment prompt for an override (opens Penny's drawer). */
  onComment?: (node: string, year: number) => void;
  /** The override being justified now — renders the focused comment form. */
  commentFor?: OverrideCommentTarget | null;
  /** Existing note to seed the comment textarea. */
  commentInitial?: string;
  /** Persist the justification note onto the override (existing contract). */
  onSubmitComment?: (node: string, year: number, note: string) => void;
  /** Dismiss the comment form without saving. */
  onCancelComment?: () => void;
  /** Section heading text. */
  title?: string;
}

/** The focused "why did you override {node} {year}?" prompt. Mounted only while an
 *  override is being justified; its textarea is labelled + auto-focused so a keyboard
 *  user lands straight on it (a11y). Saving raises {@link OverrideAuditProps.onSubmitComment}
 *  which the host persists on the override exactly as today (no data-model change). */
function CommentForm({
  target,
  initial,
  onSubmit,
  onCancel,
}: {
  target: OverrideCommentTarget;
  initial: string;
  onSubmit?: (node: string, year: number, note: string) => void;
  onCancel?: () => void;
}) {
  const fieldId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);

  // Re-seed + focus whenever the targeted override changes (a fresh prompt each time).
  // Focus is deferred a frame so it lands AFTER the host drawer's own mount-focus (the
  // panel grabs focus on open) — a Penny slid out specifically to capture a comment
  // puts the keyboard on the prompt, not the panel shell (a11y, keyboard-first).
  useEffect(() => {
    setDraft(initial);
    const focus = () => ref.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      const raf = requestAnimationFrame(focus);
      return () => cancelAnimationFrame(raf);
    }
    focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.node, target.year]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const note = draft.trim();
    if (!note) return;
    onSubmit?.(target.node, target.year, note);
  }

  return (
    <form
      data-testid="override-comment-form"
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
        padding: "0.5rem 0.625rem",
        border: "1px solid var(--brand-primary, #35644f)",
        borderRadius: "10px",
        background: "var(--surface-alt, #f7f7f5)",
      }}
    >
      <label htmlFor={fieldId} className="override-audit__label override-audit__label--brand">
        {`Why did you override ${target.label}?`}
      </label>
      <textarea
        id={fieldId}
        ref={ref}
        data-testid="override-comment-input"
        autoFocus
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a short justification for the board packet…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          minHeight: "3.5rem",
          padding: "0.5rem 0.625rem",
          border: "1px solid var(--line, #e2e2e2)",
          borderRadius: "8px",
          fontFamily: "inherit",
          fontSize: "0.8125rem",
          lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="submit"
          data-testid="override-comment-save"
          disabled={draft.trim().length === 0}
          className="override-audit__pill override-audit__pill--primary"
        >
          Save justification
        </button>
        <button
          type="button"
          data-testid="override-comment-cancel"
          onClick={onCancel}
          className="override-audit__pill"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The overrides audit (relocated from the eliminated Override Inspector). Lists every
 * pinned override's label + server display string verbatim, the stale-upstream flag,
 * a per-pin reset, and an "Add/Edit justification" button that raises {@link
 * OverrideAuditProps.onComment} (which slides Penny out). When an override is being
 * justified ({@link OverrideAuditProps.commentFor}) the focused comment form renders
 * at the top of the section.
 */
export function OverrideAudit({
  overrides,
  onResetPin,
  onComment,
  commentFor,
  commentInitial = "",
  onSubmitComment,
  onCancelComment,
  title = "Overrides",
}: OverrideAuditProps) {
  const headingId = useId();

  return (
    <section data-testid="override-audit" aria-labelledby={headingId} className="override-audit__section">
      <h3 id={headingId} className="override-audit__heading">
        {title}
        {overrides.length > 0 && (
          <span aria-hidden="true" className="override-audit__muted override-audit__count">
            {overrides.length}
          </span>
        )}
      </h3>

      {commentFor && (
        <CommentForm
          target={commentFor}
          initial={commentInitial}
          onSubmit={onSubmitComment}
          onCancel={onCancelComment}
        />
      )}

      {overrides.length === 0 ? (
        <p data-testid="override-audit-empty" className="override-audit__muted">
          No overrides pinned. Pin a component cell to track it here.
        </p>
      ) : (
        <ul role="list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {overrides.map((o) => {
            const isTarget = !!commentFor && commentFor.node === o.node && commentFor.year === o.year;
            return (
              <li
                key={`${o.node}#${o.year}`}
                data-testid={`override-audit-${o.node}-y${o.year}`}
                style={{
                  border: "1px solid var(--line, #e2e2e2)",
                  borderRadius: "8px",
                  padding: "0.5rem 0.625rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.25rem",
                }}
              >
                <span className="override-audit__label">{o.label}</span>
                <span style={{ fontWeight: 700, fontSize: "0.8125rem" }}>{o.value}</span>
                {o.calculated && (
                  <span className="override-audit__muted">was computed {o.calculated}</span>
                )}
                {o.stale && (
                  <span
                    data-testid={`override-stale-${o.node}-y${o.year}`}
                    className="override-audit__muted override-audit__muted--warn"
                  >
                    {/* Meaning is in the text, never color alone (a11y). */}
                    ⚠ Upstream input changed — review this pin.
                  </span>
                )}
                {o.note ? (
                  <p data-testid={`override-note-${o.node}-y${o.year}`} style={{ margin: 0, fontSize: "0.8125rem", fontStyle: "italic" }}>
                    “{o.note}”
                  </p>
                ) : (
                  o.needsNote && (
                    <span
                      data-testid={`override-needs-note-${o.node}-y${o.year}`}
                      className="override-audit__muted override-audit__muted--warn"
                    >
                      Needs a justification for the board packet.
                    </span>
                  )
                )}
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.15rem", flexWrap: "wrap" }}>
                  {onComment && (
                    <button
                      type="button"
                      data-testid={`override-comment-${o.node}-y${o.year}`}
                      aria-expanded={isTarget}
                      onClick={() => onComment(o.node, o.year)}
                      className="override-audit__pill"
                    >
                      {o.note ? "Edit justification" : "Add justification"}
                    </button>
                  )}
                  {onResetPin && (
                    <button
                      type="button"
                      data-testid={`override-reset-${o.node}-y${o.year}`}
                      onClick={() => onResetPin(o.node, o.year)}
                      className="override-audit__pill"
                    >
                      Reset pin
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default OverrideAudit;

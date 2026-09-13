// web/src/components/ProposalUpload.tsx — PE9 (#128): the Penny composer's proposal
// upload affordance + the phase→month confirm UI. Spec B §5.1/§9.
//
// Two pieces, both purely additive UI (inline styles → no tokens.css merge churn):
//   • <ProposalUpload> — a PDF attach control in the composer. It posts the chosen PDF
//     to POST /api/penny/proposal (server-side, untrusted) and hands back the opaque
//     proposal_ref the NEXT Penny turn threads into parse_proposal. The client never
//     parses the document and computes NOTHING.
//   • <ProposalMonthMap> — renders the STATED phase→month mapping the server inferred,
//     with Confirm / Adjust. Per §9 nothing is populated until the user confirms; the
//     populate itself happens server-side via edit_cost_schedule (AI provenance).
import { useCallback, useRef, useState } from "react";

import { PennyError, uploadProposal } from "../api/penny";

const BRAND = "#35644f";

export interface ProposalUploadProps {
  /** Disable the control while a turn is in flight. */
  disabled?: boolean;
  /** When set, the chip shows this attached filename + a remove control. */
  attachedName?: string | null;
  /** Called with the opaque ref (+ filename) once the upload succeeds. */
  onUploaded: (proposalRef: string, filename?: string) => void;
  /** Called when the user removes the attached proposal. */
  onClear?: () => void;
  /** Called with a plain-language message on an upload failure (never a crash). */
  onError?: (message: string) => void;
}

function friendlyUploadError(err: unknown): string {
  if (err instanceof PennyError) {
    if (err.status === 413) return "That PDF is too large — try a smaller file.";
    if (err.status === 415) return "That file isn't a PDF — attach the proposal as a PDF.";
    if (err.status === 429) return "Too many uploads right now — please try again in a moment.";
    if (err.serverMessage) return err.serverMessage;
  }
  return "Couldn't upload that proposal — please try again, or attach a PDF.";
}

/** The PDF attach affordance hosted in the Penny composer (Spec §5.1). */
export function ProposalUpload({
  disabled = false,
  attachedName,
  onUploaded,
  onClear,
  onError,
}: ProposalUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const res = await uploadProposal({ file });
        onUploaded(res.proposalRef, res.filename);
      } catch (err) {
        onError?.(friendlyUploadError(err));
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = ""; // allow re-selecting same file
      }
    },
    [onUploaded, onError],
  );

  if (attachedName) {
    return (
      <div
        data-testid="proposal-attached"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          fontSize: "0.75rem",
          padding: "0.2rem 0.5rem",
          border: "1px solid var(--line, #e2e2e2)",
          borderRadius: "999px",
          background: "var(--surface-alt, #f7f7f5)",
          color: "var(--text, #1a1a1a)",
          maxWidth: "100%",
        }}
      >
        <span aria-hidden="true">📎</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {attachedName}
        </span>
        <button
          type="button"
          aria-label="Remove proposal"
          onClick={onClear}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "var(--text-muted, #666)",
            fontSize: "0.9rem",
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        data-testid="proposal-file-input"
        type="file"
        accept="application/pdf,.pdf"
        aria-label="Attach proposal PDF"
        disabled={disabled || busy}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onPick(file);
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        style={{
          fontSize: "0.75rem",
          padding: "0.2rem 0.55rem",
          border: "1px solid var(--line, #e2e2e2)",
          borderRadius: "999px",
          background: "var(--surface, #fff)",
          color: BRAND,
          cursor: disabled || busy ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Uploading…" : "📎 Attach proposal (PDF)"}
      </button>
    </>
  );
}

export interface ProposalMonthMapProps {
  /** The inferred phase→month mapping the server stated (rendered verbatim). */
  mapping: Array<{ phase: string; month: number }>;
  /** The inferred grand-opening anchor month, if any. */
  openingMonth?: number | null;
  /** Confirm the mapping (the host then asks Penny to populate via edit_cost_schedule). */
  onConfirm: () => void;
  /** Adjust the mapping (the host returns the user to the conversation to correct it). */
  onAdjust?: () => void;
  disabled?: boolean;
}

/**
 * The phase→month confirm panel (Spec §9 step 4).
 *
 * Renders the mapping the SERVER inferred and asks the user to confirm before any row
 * is populated. The client computes nothing here — it only relays the user's decision.
 */
export function ProposalMonthMap({
  mapping,
  openingMonth,
  onConfirm,
  onAdjust,
  disabled = false,
}: ProposalMonthMapProps) {
  if (!mapping || mapping.length === 0) return null;
  return (
    <div
      data-testid="proposal-month-map"
      role="group"
      aria-label="Proposed phase to month mapping"
      style={{
        margin: "0 1rem 0.5rem",
        padding: "0.625rem 0.75rem",
        border: "1px solid var(--line, #e2e2e2)",
        borderRadius: "10px",
        background: "var(--surface-alt, #f7f7f5)",
        fontSize: "0.8125rem",
        color: "var(--text, #1a1a1a)",
      }}
    >
      <p style={{ margin: "0 0 0.375rem" }}>
        I mapped the proposal&rsquo;s phases to project months — does this look right?
      </p>
      <ul style={{ margin: "0 0 0.5rem", padding: 0, listStyle: "none" }}>
        {mapping.map((m) => (
          <li key={`${m.phase}-${m.month}`} style={{ display: "flex", gap: "0.5rem" }}>
            <span style={{ fontWeight: 600 }}>{m.phase}</span>
            <span aria-hidden="true">→</span>
            <span>month {m.month}</span>
          </li>
        ))}
      </ul>
      {typeof openingMonth === "number" && (
        <p style={{ margin: "0 0 0.5rem", color: "var(--text-muted, #666)" }}>
          Grand opening at month {openingMonth}.
        </p>
      )}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          style={{
            padding: "0.35rem 0.75rem",
            border: "none",
            borderRadius: "8px",
            background: BRAND,
            color: "#fff",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onAdjust}
          style={{
            padding: "0.35rem 0.75rem",
            border: "1px solid var(--line, #e2e2e2)",
            borderRadius: "8px",
            background: "var(--surface, #fff)",
            color: "var(--text, #1a1a1a)",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          Adjust
        </button>
      </div>
    </div>
  );
}

export default ProposalUpload;

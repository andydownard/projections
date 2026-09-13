// web/src/api/penny.ts — PE6: the POST …/penny client (API_SPEC §12, Spec B §6/§12).
//
// Penny is another INPUT DEVICE for the same server-authoritative mutation path —
// not a parallel writer and not a second math authority. This project has no
// authentication (owner decision, 2026-09-13): the client sends only the user's
// message; the bounded tool-use loop runs SERVER-SIDE and any edit is applied
// through the normal PATCH/If-Match path (version++ + an actor:penny revision) as
// a side effect. The client computes NOTHING and formats NOTHING: it relays the
// message and renders the server's
// { turns_appended, provider, applied_revisions, narration } verbatim.
//
// There is no top-level If-Match here (§12): the loop's internal PATCHes carry it.
// Errors are CLASSIFIED into a `kind` the UI maps to friendly copy so chat is never
// the only path (issue #125): 409 ai_disabled, 503 ai_unavailable, 429 rate_limited
// (+retry_after_seconds), 422 a relayed rejection, anything else → unknown.

const BASE = "/api";

export type PennyProvider = "anthropic" | "openai";
export type PennyTurnRole = "user" | "assistant" | "tool";

/** One persisted transcript turn (Spec B §7). `content` is server-formatted text
 *  rendered VERBATIM — the client never derives a figure. */
export interface PennyTurnDTO {
  id?: string;
  role: PennyTurnRole;
  content: string;
  tool_name?: string;
  /** Links a mutating turn to the revision it produced (provenance ↔ §4 audit). */
  revision_id?: string;
  provider?: PennyProvider;
  ts?: string;
}

/** The POST …/penny response (API_SPEC §12). */
export interface PennyResponse {
  turns_appended: PennyTurnDTO[];
  /** The ACTUAL provider used this turn; flips to openai on fallback (§8). */
  provider: PennyProvider;
  /** Revision ids produced by edits applied inside the loop (empty if answer-only). */
  applied_revisions: string[];
  /** The final assistant message (also the last assistant turn). */
  narration: string;
}

export interface SendPennyArgs {
  viewSlug: string;
  message: string;
  /** Optional uploaded-proposal handle for parse_proposal (§9). */
  proposalRef?: string;
  /** Aborts the in-flight turn (the composer Stop control). */
  signal?: AbortSignal;
}

/** The opaque in-memory wizard draft state Penny reads + mutates (Spec §5.2/§12).
 *  The server defines its keys (`name`, `inputs`, `assumptions`, `trade_area`,
 *  `cost_schedule`); the client only round-trips it — it computes NOTHING. */
export type PennyDraftState = Record<string, unknown>;

/** One change Penny applied to the draft inside the loop. Scalar edits
 *  (`set_input` / `set_assumption`) carry the `{field, was, now}` the per-field
 *  undo affordance renders; `edit_cost_schedule` reports its tool name with an
 *  empty `changed[]` (the new schedule is on the returned draft). */
export interface PennyDraftApplied {
  tool: string;
  /** Always null for a wizard draft (no version/revision until Generate). */
  version: number | null;
  actor: string;
  changed: Array<{ field: string; was: unknown; now: unknown }>;
}

/** The POST /api/penny/draft response (API_SPEC §12). Nothing is persisted: the
 *  mutated `draft` is mapped back onto the wizard, the transcript stays ephemeral. */
export interface PennyDraftResponse {
  draft: PennyDraftState;
  /** The final assistant message, rendered verbatim. */
  narration: string;
  /** The ACTUAL provider used this turn; flips to openai on fallback (§8). */
  provider: PennyProvider;
  applied: PennyDraftApplied[];
}

export interface SendPennyDraftArgs {
  message: string;
  /** The current in-memory wizard draft Penny acts on; returned mutated, persisted nowhere. */
  draftState: PennyDraftState;
  /** Optional uploaded-proposal handle for parse_proposal (§9). */
  proposalRef?: string;
  /** Aborts the in-flight turn (the composer Stop control). */
  signal?: AbortSignal;
}

export type PennyErrorKind =
  | "ai_disabled" // 409 — AI opt-out / no provider key; mute Penny
  | "ai_unavailable" // 503 — both providers failed
  | "rate_limited" // 429 — LLM bucket; retry_after_seconds
  | "rejected" // 422 — server rejected the edit (relayed to the user)
  | "unknown"; // any other non-2xx — degrade gracefully, never a bare 500

/** A classified Penny failure. Carries the status + (for 422) the relayed server
 *  message and (for 429) the retry hint, so the UI shows plain copy, never a crash. */
export class PennyError extends Error {
  kind: PennyErrorKind;
  status: number;
  retryAfterSeconds?: number;
  serverMessage?: string;
  constructor(
    kind: PennyErrorKind,
    status: number,
    opts: { message?: string; serverMessage?: string; retryAfterSeconds?: number } = {},
  ) {
    super(opts.message ?? `penny_${kind}`);
    this.name = "PennyError";
    this.kind = kind;
    this.status = status;
    this.serverMessage = opts.serverMessage;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

const STATUS_KIND: Record<number, PennyErrorKind> = {
  409: "ai_disabled",
  503: "ai_unavailable",
  429: "rate_limited",
  422: "rejected",
};

async function readBody(resp: Response): Promise<Record<string, unknown>> {
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// The live server raises these via FastAPI `HTTPException(detail={...})`, which
// serializes as `{ "detail": {...} }`. Reading the body FLAT silently dropped the
// 429 countdown and the relayed 422 reason against the real backend (#188). These
// helpers unwrap the nested envelope and tolerate a flat body (existing mocks).

/** Unwrap the FastAPI `{detail:{...}}` error envelope (a flat body is tolerated). */
function errorDetail(body: Record<string, unknown>): Record<string, unknown> {
  const d = body.detail;
  return d && typeof d === "object" ? (d as Record<string, unknown>) : body;
}

/** The relayed human reason for a rejection: 422 emits `reason`, some paths `message`. */
function relayedMessage(detail: Record<string, unknown>): string | undefined {
  if (typeof detail.reason === "string") return detail.reason;
  if (typeof detail.message === "string") return detail.message;
  return undefined;
}

/** The 429 retry hint: prefer the body's `retry_after_seconds`, else the `Retry-After` header. */
function retryAfterSecondsOf(resp: Response, detail: Record<string, unknown>): number | undefined {
  const fromBody = detail.retry_after_seconds;
  if (typeof fromBody === "number") return fromBody;
  const header = Number.parseInt(resp.headers.get("Retry-After") ?? "", 10);
  return Number.isFinite(header) ? header : undefined;
}

/**
 * Send one user message to Penny on a saved projection.
 *
 * Resolves with the server's appended turns + provider + applied revisions +
 * narration. Rejects with a typed {@link PennyError} on a classified failure so
 * the caller can surface plain copy (and, on `applied_revisions.length > 0`,
 * refetch the view-model so decision metrics reflect the recomputed snapshot —
 * the client never streams a number ahead of the engine).
 */
export async function sendPennyMessage({
  viewSlug,
  message,
  proposalRef,
  signal,
}: SendPennyArgs): Promise<PennyResponse> {
  const body: Record<string, unknown> = { message };
  if (proposalRef) body.proposal_ref = proposalRef;

  const resp = await fetch(`${BASE}/projections/${encodeURIComponent(viewSlug)}/penny`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const detail = errorDetail(await readBody(resp));
    const kind = STATUS_KIND[resp.status] ?? "unknown";
    throw new PennyError(kind, resp.status, {
      serverMessage: relayedMessage(detail),
      retryAfterSeconds: retryAfterSecondsOf(resp, detail),
    });
  }

  return (await resp.json()) as PennyResponse;
}

/**
 * Send one user message to Penny on the WIZARD draft (Spec §5.2/§12).
 *
 * Runs the same bounded tool-use loop server-side, but acts only on the supplied
 * `draftState` (there is no projection yet) and persists NOTHING. Resolves with the
 * mutated draft + narration + provider + the applied changes (for the per-field
 * undo affordance). Rejects with the SAME typed {@link PennyError} taxonomy so the
 * wizard surfaces plain copy and Penny is never the only path — the manual wizard
 * stays fully intact (CLAUDE.md "AI opt-out must work end-to-end").
 */
export async function sendPennyDraftMessage({
  message,
  draftState,
  proposalRef,
  signal,
}: SendPennyDraftArgs): Promise<PennyDraftResponse> {
  const body: Record<string, unknown> = { message, draft_state: draftState };
  if (proposalRef) body.proposal_ref = proposalRef;

  const resp = await fetch(`${BASE}/penny/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const detail = errorDetail(await readBody(resp));
    const kind = STATUS_KIND[resp.status] ?? "unknown";
    throw new PennyError(kind, resp.status, {
      serverMessage: relayedMessage(detail),
      retryAfterSeconds: retryAfterSecondsOf(resp, detail),
    });
  }

  return (await resp.json()) as PennyDraftResponse;
}

export interface UploadProposalArgs {
  /** The chosen PDF (the bytes are sent verbatim; the server is the type authority). */
  file: File | Blob;
  /** Optional display name (defaults to the File's name). */
  filename?: string;
  /** Aborts the in-flight upload. */
  signal?: AbortSignal;
}

/** The POST /api/penny/proposal response — an opaque handle for parse_proposal (§9). */
export interface ProposalUploadResult {
  proposalRef: string;
  filename?: string;
  size?: number;
}

/**
 * Upload a consultant proposal PDF for Penny to parse (Spec §9/§12).
 *
 * The PDF is sent to the server as untrusted bytes; the server validates type/size,
 * holds it behind an opaque `proposal_ref`, and NEVER executes or renders it. The
 * returned ref is threaded into the next Penny turn (`proposal_ref`) so the
 * server-side `parse_proposal` tool can extract candidate cost rows — the client
 * never parses the document itself. Rejections are classified into the same typed
 * {@link PennyError} taxonomy so the composer shows plain copy, never a crash.
 */
export async function uploadProposal({
  file,
  filename,
  signal,
}: UploadProposalArgs): Promise<ProposalUploadResult> {
  const name = filename ?? (file as File).name ?? undefined;
  const qs = name ? `?filename=${encodeURIComponent(name)}` : "";
  const resp = await fetch(`${BASE}/penny/proposal${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
    signal,
  });

  if (!resp.ok) {
    const detail = errorDetail(await readBody(resp));
    const kind = STATUS_KIND[resp.status] ?? "unknown";
    throw new PennyError(kind, resp.status, {
      serverMessage: relayedMessage(detail),
    });
  }

  const data = await readBody(resp);
  return {
    proposalRef: String(data.proposal_ref ?? ""),
    filename: typeof data.filename === "string" ? data.filename : name,
    size: typeof data.size === "number" ? data.size : undefined,
  };
}

"""app/routers/penny.py — Penny assistant endpoints (Spec B §6.1/§12; issues #121/#124).

Penny's HTTP surface: the owner-scoped transcript read (PE2) plus the three PE5
write/loop endpoints.

- ``GET  /api/projections/{view_slug}/penny/transcript`` — owner/edit read of the
  persisted per-project transcript (the server is the one shape authority).
- ``POST /api/projections/{view_slug}/penny`` — run the bounded §6 tool-use loop for
  a saved projection. Mutations happen INSIDE the loop via the existing
  ``apply_projection_patch`` PATCH/If-Match path (version++ + one ``actor:penny``
  revision as a side effect — no parallel writer, no privileged path). Detail turns
  persist to ``penny_transcripts``. Capability-gated: a view-only caller is
  answer-only (mutate tools refuse; nothing persists to the owner's transcript).
- ``POST /api/penny/draft`` — the SAME loop over a supplied ``draft_state`` (no
  projection yet); mutates only the draft and **persists nothing** (Spec §7).
- ``POST /api/penny/proposal`` — accept the proposal PDF as untrusted bytes; return an
  opaque ``proposal_ref``; type/size/SSRF guarded, never executed/rendered (PE9 parses).

Error contract (Spec §8/§11): ``409 ai_disabled`` (opt-out / kill-switch / no provider
— ZERO provider calls), ``503 ai_unavailable`` (both providers down), ``429
rate_limited`` (``retry_after_seconds`` — BEFORE any provider call), ``422`` for a
rejected edit (relayed to the model). Providers are STUBBED in tests — no real
provider call ever happens (keys are server-env only, CLAUDE.md rule 7).
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates these annotations at
# runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import copy
import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app import ratelimit
from app.aisafety import is_computed_figure_token
from app.deps import token_matches
from app.penny import proposal as proposal_intake
from app.penny.loop import AIDisabledError as LoopAIDisabledError
from app.penny.loop import (
    CapExceededError,
    LoopCaps,
    Tool,
    ToolContext,
    ToolRegistry,
    run_turn,
)
from app.penny.providers import AIUnavailableError, ProviderChain, build_provider_chain
from app.penny.tools import build_registry
from app.store import Store, get_store

router = APIRouter(tags=["penny"])


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def _is_owner(token: Optional[str], row: dict) -> bool:
    return token is not None and token_matches(token, row["owner_token_hash"])


def _is_editor(token: Optional[str], row: dict) -> bool:
    return (
        token is not None
        and bool(row.get("edit_token_hash"))
        and token_matches(token, row["edit_token_hash"])
    )


@router.get("/api/projections/{view_slug}/penny/transcript")
def get_penny_transcript(
    view_slug: str,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Owner/edit-scoped read of the persisted per-project transcript (Spec §7)."""
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        # Unknown slug -> 404 (never reveal existence beyond the slug's grant).
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    if not (_is_owner(token, row) or _is_editor(token, row)):
        # view-only / no token / a different owner's token cannot read (SECURITY §2).
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    transcript = store.get_transcript_by_projection(row["id"])
    if transcript is None:
        return {
            "view_slug": view_slug,
            "transcript_id": None,
            "turns": [],
            "created_at": None,
            "updated_at": None,
        }
    return {
        "view_slug": view_slug,
        "transcript_id": transcript["id"],
        "turns": transcript["turns"],
        "created_at": transcript.get("created_at"),
        "updated_at": transcript.get("updated_at"),
    }


# ============================================================ PE5: loop endpoints
# Rate-limit budgets (per IP + per token, 1h window): tokens are free to mint, so
# both axes are capped (SECURITY §10.1). The loop spends provider tokens, so it is
# capped tighter than read; the upload holds bytes, so it is capped too.
_PENNY_IP_LIMIT = 60
_PENNY_TOKEN_LIMIT = 120
_PENNY_WINDOW_SECONDS = 3600
_UPLOAD_IP_LIMIT = 30
_UPLOAD_TOKEN_LIMIT = 60


class PennyTurnIn(BaseModel):
    """One detail-page Penny turn: a user message + an optional proposal ref."""

    message: str
    proposal_ref: Optional[str] = None


class PennyDraftIn(BaseModel):
    """One wizard-draft Penny turn: a message acting on a supplied draft state."""

    message: str
    draft_state: dict = Field(default_factory=dict)
    proposal_ref: Optional[str] = None


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None or request.client is None:
        return None
    return request.client.host


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_turn_id() -> str:
    return "turn_" + secrets.token_urlsafe(12)


def _load_json(row: dict, key: str) -> dict:
    try:
        return json.loads(row.get(key) or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


def get_penny_chain() -> ProviderChain:
    """Build the provider chain from server-env keys (Anthropic → OpenAI).

    A FastAPI dependency so tests override it with a scripted stub chain — no real
    provider call ever happens in a test (CLAUDE.md: stubbed providers). An empty
    chain (no keys) means AI-disabled to the loop (zero calls).
    """
    return build_provider_chain()


def _ai_disabled(chain: Any, row: Optional[dict] = None) -> bool:
    """Penny is disabled by a per-projection opt-out, a kill switch, or no provider.

    Key-presence is encapsulated by the chain (empty providers => disabled), so the
    router never reads keys directly; tests inject a stub chain independently of the
    per-projection ``ai_opt_out`` flag.
    """
    if row is not None and int(row.get("ai_opt_out") or 0):
        return True
    if os.environ.get("AI_DISABLED", "").lower() in ("1", "true", "yes"):
        return True
    return not getattr(chain, "providers", None)


def _check_rate(ip: Optional[str], token: Optional[str]) -> tuple[bool, int]:
    """Loop rate-limit (per IP + per token). Module-level so tests can monkeypatch."""
    return ratelimit.check(
        "penny", ip=ip, token=token, ip_limit=_PENNY_IP_LIMIT,
        token_limit=_PENNY_TOKEN_LIMIT, window_seconds=_PENNY_WINDOW_SECONDS)


def _rate_limited(retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail={"error": "rate_limited", "retry_after_seconds": retry_after},
        headers={"Retry-After": str(retry_after)})


def _run_loop(**kwargs: Any) -> Any:
    """Run the bounded loop, translating its terminal errors to the HTTP contract."""
    try:
        return run_turn(**kwargs)
    except LoopAIDisabledError as exc:  # backstop (router gates first)
        raise HTTPException(status_code=409, detail={"error": "ai_disabled"}) from exc
    except AIUnavailableError as exc:  # both providers down
        raise HTTPException(status_code=503, detail={"error": "ai_unavailable"}) from exc
    except CapExceededError as exc:  # oversized prompt rejected before any provider work
        raise HTTPException(
            status_code=422, detail={"error": "input_too_large", "reason": exc.reason}) from exc


def _collect_applied(result: Any) -> list[dict]:
    """The revisions the loop produced via the PATCH path (version + recompute diff)."""
    applied: list[dict] = []
    for inv in result.tool_invocations:
        r = inv.result
        if isinstance(r, dict) and r.get("applied"):
            applied.append({
                "tool": inv.name,
                "version": r.get("version"),
                "actor": r.get("actor", "penny"),
                "changed": r.get("changed", []),
            })
    return applied


def _grounding(row: dict) -> dict:
    """Trusted grounding facts for the loop (current computed_json + editable surface)."""
    vm = _load_json(row, "computed_json")
    inputs_d = _load_json(row, "inputs_json")
    return {
        "version": row["version"],
        "name": row["name"],
        "reco": vm.get("reco") or {},
        "metrics": vm.get("metrics") or {},
        "kpis": vm.get("kpis") or [],
        "editable_surface": {
            "inputs": {k: v for k, v in inputs_d.items() if k != "cost_schedule"},
            "assumptions": _load_json(row, "assumptions_json"),
            "trade_area": _load_json(row, "trade_area_json"),
        },
    }


@router.post("/api/projections/{view_slug}/penny")
def penny_turn(
    view_slug: str,
    body: PennyTurnIn,
    request: Request,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    chain: ProviderChain = Depends(get_penny_chain),  # noqa: B008
    authorization: Optional[str] = Header(default=None),
):
    """Run the bounded §6 tool-use loop for a saved projection (Spec §12).

    Mutations happen INSIDE the loop via ``apply_projection_patch`` (version++ +
    ``actor:penny`` revision); there is NO top-level If-Match (the loop's internal
    PATCHes carry it). Capability-gated: a view-only caller (not owner/editor) gets
    answer-only — mutate tools refuse and nothing persists to the owner's transcript.
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    can_mutate = _is_owner(token, row) or _is_editor(token, row)

    # AI-disabled gate FIRST: opt-out / kill switch / no provider => ZERO calls.
    if _ai_disabled(chain, row):
        raise HTTPException(status_code=409, detail={"error": "ai_disabled"})

    allowed, retry_after = _check_rate(_client_ip(request), token)
    if not allowed:
        raise _rate_limited(retry_after)

    ctx = ToolContext(
        view_slug=view_slug,
        bearer_token=token,
        can_mutate=can_mutate,
        version=int(row["version"]),
        extra={"turn_id": _new_turn_id(), "proposal_ref": body.proposal_ref},
    )
    result = _run_loop(
        user_message=body.message,
        chain=chain,
        registry=build_registry(store),
        context=ctx,
        grounding_context=_grounding(row),
        caps=LoopCaps(),
    )

    applied = _collect_applied(result)
    now = _utcnow()
    turns: list[dict] = [{"role": "user", "content": body.message, "ts": now}]
    for a in applied:
        turns.append({
            "role": "tool",
            "content": f"Applied {a['tool']} → version {a['version']}.",
            "tool_name": a["tool"],
            "revision_id": a["version"],
            "ts": now,
        })
    turns.append({
        "role": "assistant",
        "content": result.final_text,
        "provider": result.provider,
        "ts": now,
    })

    # Persist ONLY for an authorized editor — a view-only caller must never be able to
    # write into the owner's per-project transcript (answer-only stays ephemeral).
    if can_mutate:
        for turn in turns:
            store.append_transcript_turn(row["id"], turn)

    return {
        "turns_appended": turns,
        "provider": result.provider,
        "applied_revisions": applied,
        "narration": result.final_text,
    }


@router.post("/api/penny/draft")
def penny_draft(
    body: PennyDraftIn,
    request: Request,
    chain: ProviderChain = Depends(get_penny_chain),  # noqa: B008
    authorization: Optional[str] = Header(default=None),
):
    """Wizard-draft variant: the SAME loop over a supplied draft (Spec §12).

    Acts ONLY on ``draft_state`` (there is no projection yet) and **persists nothing**
    — no transcript row, no revision, no projection. Returns the mutated draft +
    narration; the ephemeral transcript stays in client state (Spec §7).
    """
    token = _bearer(authorization)
    if token is None:
        # Wizard-draft edits require an editing grant (Spec §12: edit Bearer).
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    if _ai_disabled(chain):
        raise HTTPException(status_code=409, detail={"error": "ai_disabled"})

    allowed, retry_after = _check_rate(_client_ip(request), token)
    if not allowed:
        raise _rate_limited(retry_after)

    draft = copy.deepcopy(body.draft_state or {})
    ctx = ToolContext(
        view_slug=None,
        bearer_token=token,
        can_mutate=True,  # the draft is the caller's own ephemeral state
        version=None,
        extra={"turn_id": _new_turn_id(), "proposal_ref": body.proposal_ref},
    )
    result = _run_loop(
        user_message=body.message,
        chain=chain,
        registry=build_draft_registry(draft),
        context=ctx,
        grounding_context={"draft": draft},
        caps=LoopCaps(),
    )

    return {
        "draft": draft,
        "narration": result.final_text,
        "provider": result.provider,
        "applied": _collect_applied(result),
    }


@router.post("/api/penny/proposal")
async def penny_proposal(
    request: Request,
    response: Response,
    filename: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    """Accept an untrusted proposal PDF; return an opaque ``proposal_ref`` (Spec §9/§12).

    Two intake shapes: a raw PDF body (``Content-Type: application/pdf``) is validated
    (magic-byte type sniff + size cap) and held behind a ref; a JSON ``{source_url}`` is
    SSRF-validated (a blocked host fails closed, 422) — remote fetching is PE9, so a
    clean URL returns ``remote_intake_unavailable``. Bytes are NEVER parsed/executed/
    rendered here.
    """
    token = _bearer(authorization)
    if token is None:
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    allowed, retry_after = ratelimit.check(
        "penny_proposal", ip=_client_ip(request), token=token,
        ip_limit=_UPLOAD_IP_LIMIT, token_limit=_UPLOAD_TOKEN_LIMIT,
        window_seconds=_PENNY_WINDOW_SECONDS)
    if not allowed:
        raise _rate_limited(retry_after)

    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        url = (payload or {}).get("source_url")
        if not url:
            raise HTTPException(status_code=422, detail={"error": "empty_upload"})
        try:
            proposal_intake.assert_safe_source_url(str(url))
        except proposal_intake.ProposalBlockedSource as exc:
            raise HTTPException(status_code=422, detail={"error": "ssrf_blocked"}) from exc
        # SSRF-clean, but a server-side remote fetch is out of scope here (PE9).
        raise HTTPException(status_code=422, detail={"error": "remote_intake_unavailable"})

    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail={"error": "empty_upload"})
    try:
        ref = proposal_intake.store_proposal(
            data, filename=filename, content_type=content_type or None)
    except proposal_intake.ProposalTooLarge as exc:
        raise HTTPException(
            status_code=413,
            detail={"error": "file_too_large", "max_bytes": proposal_intake.MAX_PROPOSAL_BYTES},
        ) from exc
    except proposal_intake.ProposalBadType as exc:
        raise HTTPException(status_code=415, detail={"error": "unsupported_type"}) from exc

    held = proposal_intake.get_proposal(ref) or {}
    response.status_code = 201
    return {
        "proposal_ref": ref,
        "filename": filename,
        "size": held.get("size"),
        "content_type": content_type or None,
    }


# =============================================================== draft tool surface
def _draft_refuse_view_only() -> dict:
    return {"error": "view_only", "status": 403,
            "message": "I can't apply an edit without an edit grant."}


def _draft_figure_guard(*values: object) -> Optional[dict]:
    """Strip a computed money/percent figure from a draft mutate arg (extends N2)."""
    for v in values:
        if is_computed_figure_token(v):
            return {"error": "figure_stripped", "status": 422, "value": v,
                    "message": ("I can only apply a raw input value, not a computed "
                                "figure. Tell me the underlying number (e.g. 0.08).")}
    return None


# draft set_input / set_assumption routing (mirrors app.penny.tools, but writes the
# draft dict). Overrides are intentionally absent: a wizard draft has no computed DAG
# to pin, so set_override/clear_override are a detail-page-only affordance (Spec §6.2).
_DRAFT_INPUT_FIELDS = {"city", "org_name", "target_opening_date", "opening_month_number"}
_DRAFT_ASSUMPTION_KEYS = {
    "labor_pct", "marketing_pct", "supplies_pct", "card_pct", "payroll_tax_pct",
    "salvage_pct", "escalator", "basket", "share_y1", "share_y2", "share_y3",
    "rent_per_sqft", "occupancy_annual", "donation_value",
}


def build_draft_registry(draft: dict) -> ToolRegistry:
    """Register Penny's wizard tools against an in-memory ``draft`` (persists nothing).

    The mutate tools edit the supplied draft dict (by reference) instead of routing
    through ``apply_projection_patch`` — there is no saved projection yet, so no
    version, no revision, no transcript. The figure-strip guard still applies so no
    LLM-computed figure reaches the draft (SECURITY §6.3).
    """
    draft.setdefault("inputs", {})
    draft.setdefault("assumptions", {})
    draft.setdefault("trade_area", {})
    draft.setdefault("cost_schedule", [])

    def read_projection(args: dict, ctx: ToolContext) -> dict:
        return {"draft": True, "name": draft.get("name"), "inputs": draft.get("inputs"),
                "assumptions": draft.get("assumptions"), "trade_area": draft.get("trade_area"),
                "cost_schedule": draft.get("cost_schedule")}

    def parse_proposal(args: dict, ctx: ToolContext) -> dict:
        # Same extract-only parser as the detail-page tool (PE9): line-items,
        # tiers/packages, and phase->month inference, all traceable to the document.
        text = str(args.get("proposal_text") or "")
        if not text:
            ref = args.get("proposal_ref") or (
                ctx.extra.get("proposal_ref") if isinstance(ctx.extra, dict) else None)
            if ref:
                held = proposal_intake.get_proposal(str(ref))
                if held is None:
                    return {"error": "proposal_not_found", "status": 404,
                            "message": "I couldn't find that uploaded proposal — re-attach it."}
                text = proposal_intake.extract_pdf_text(held.get("data") or b"")
        return proposal_intake.parse_proposal_text(text)

    def set_input(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _draft_refuse_view_only()
        field, value = args.get("field"), args.get("value")
        if value is None:
            return {"error": "invalid_inputs", "status": 422, "message": "value is required"}
        guard = _draft_figure_guard(value)
        if guard:
            return guard
        if field == "name":
            was, draft["name"] = draft.get("name"), value
        elif field == "households":
            ta = draft["trade_area"]
            was, ta["households"] = ta.get("households"), str(value)
        elif field in _DRAFT_INPUT_FIELDS:
            inp = draft["inputs"]
            was, inp[field] = inp.get(field), value
        else:
            return {"error": "unknown_field", "status": 422, "field": field}
        return {"applied": True, "changed": [{"field": field, "was": was, "now": value}]}

    def set_assumption(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _draft_refuse_view_only()
        name, value = args.get("name"), args.get("value")
        if value is None:
            return {"error": "invalid_inputs", "status": 422, "message": "value is required"}
        guard = _draft_figure_guard(value)
        if guard:
            return guard
        if name not in _DRAFT_ASSUMPTION_KEYS:
            return {"error": "unknown_field", "status": 422, "field": name}
        bucket = draft["assumptions"]
        was, bucket[name] = bucket.get(name), str(value)
        return {"applied": True, "changed": [{"field": name, "was": was, "now": str(value)}]}

    def edit_cost_schedule(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _draft_refuse_view_only()
        ops = args.get("ops") or []
        for op in ops:
            guard = _draft_figure_guard(op.get("amount"))
            if guard:
                return guard
        schedule = list(draft.get("cost_schedule") or [])
        applied_ops: list[dict] = []
        for op in ops:
            kind = str(op.get("op") or "").lower()
            category, month = op.get("category"), op.get("month")
            if kind == "add":
                schedule.append({"category": category, "month": month,
                                 "amount": op.get("amount"),
                                 "provenance": {"source": "ai",
                                                "turn_id": ctx.extra.get("turn_id")}})
            elif kind == "remove":
                schedule = [r for r in schedule
                            if not (r.get("category") == category and r.get("month") == month)]
            elif kind == "edit":
                for r in schedule:
                    if r.get("category") == category and r.get("month") == month:
                        if op.get("amount") is not None:
                            r["amount"] = op.get("amount")
                        if op.get("new_month") is not None:
                            r["month"] = op.get("new_month")
            else:
                return {"error": "bad_op", "status": 422, "op": kind}
            applied_ops.append({"op": kind, "category": category, "month": month})
        draft["cost_schedule"] = schedule
        if args.get("opening_month_number") is not None:
            draft["inputs"]["opening_month_number"] = args.get("opening_month_number")
        return {"applied": True, "cost_schedule": schedule, "schedule_ops_applied": applied_ops}

    handlers = {
        "read_projection": read_projection,
        "parse_proposal": parse_proposal,
        "set_input": set_input,
        "set_assumption": set_assumption,
        "edit_cost_schedule": edit_cost_schedule,
    }
    registry = ToolRegistry()
    for name, handler in handlers.items():
        registry.register(Tool(name=name, description=f"draft:{name}",
                               input_schema={"type": "object"}, handler=handler))
    return registry

"""app/penny/tools.py — Penny's seven tools (issue #123, spec §4/§6.2).

The confirmed seven-tool surface, registered into PE3's :class:`ToolRegistry`.
Every *mutate* tool converges on the EXISTING server mutation/recompute service
(:func:`app.routers.projections.apply_projection_patch`) — the same merge ->
recompute -> ``If-Match`` version-check -> one revision the manual UI hits. There
is **no parallel writer and no privileged Penny path**: Penny carries *intents*
through exactly the same wall, and each applied edit produces ONE revision tagged
``actor:penny`` (Spec B §4).

The tools (Spec B §6.2):

- ``read_projection`` (read) — the ONLY way Penny "knows" numbers: returns the
  grounded ``computed_json`` facts (rows, decision metrics, KPIs, overrides), the
  current cost schedule, and the editable surface. It computes nothing.
- ``parse_proposal`` (extract) — extract-only seam over an untrusted consultant
  proposal; returns structured candidates whose figures all trace to the document
  (full PDF parse lands in PE9).
- ``set_input`` / ``set_assumption`` (mutate) — set a projection input / assumption
  via the PATCH path; the server domain-validates.
- ``set_override`` / ``clear_override`` (mutate) — pin / unpin ``{node}#{year}``;
  the server enforces non-pinnable (422 ``node_not_pinnable``) + DAG rules and owns
  auto-clear-on-equal.
- ``edit_cost_schedule`` (mutate) — add / edit / remove timed rows
  ``{category, month, amount}`` + the opening anchor, stamping AI provenance on rows
  Penny creates; the server validates ``month >= 1``, ``amount >= 0``, ``opening >= 1``.

Guardrails enforced here (SECURITY §6.3):

- **Capability-gating** — a view-only caller (``ctx.can_mutate is False``) gets an
  answer-only refusal; a bad token still hits the 403 wall inside the service.
- **Figure-strip** — a *computed* money/percent figure an LLM puts in a mutate-tool
  argument (vs a raw user input value) is stripped/rejected before any write, so no
  LLM figure ever reaches the data (extends the N2 rule to the tool loop).
- **Plain-language relay** — a 422 (non-pinnable / domain) or 409 (version moved)
  from the service is returned as structured data the model relays truthfully.

Each applied mutate tool returns the recomputed view-model diff (``changed[]``
was->now) so Penny narrates the engine's effect without inventing a number.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.aisafety import is_computed_figure_token
from app.routers.projections import (
    MAX_COST_SCHEDULE_ROWS,
    PatchProjectionIn,
    apply_projection_patch,
)
from app.store import Store
from engine.model import DEFAULT_OPENING_MONTH_NUMBER, default_cost_schedule

from . import proposal as proposal_intake
from .loop import Tool, ToolContext, ToolRegistry

# set_input routes these straight onto the engine ``inputs`` bucket; ``name`` and
# ``households`` route to the projection name / trade-area respectively.
_SET_INPUT_INPUT_FIELDS = {
    "city", "org_name", "target_opening_date", "opening_month_number",
}

# set_assumption routes each assumption-like driver to the bucket the engine reads
# it from (the % assumptions live in ``assumptions``; the donor shares / rent /
# occupancy are stored on ``inputs``). Anything not listed is rejected, fail-closed.
_ASSUMPTION_BUCKET = {
    "labor_pct": "assumptions", "marketing_pct": "assumptions",
    "supplies_pct": "assumptions", "card_pct": "assumptions",
    "payroll_tax_pct": "assumptions", "salvage_pct": "assumptions",
    "escalator": "assumptions", "basket": "assumptions",
    "share_y1": "inputs", "share_y2": "inputs", "share_y3": "inputs",
    "rent_per_sqft": "inputs", "occupancy_annual": "inputs",
    "donation_value": "inputs",
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_json(row: dict, key: str) -> dict:
    try:
        return json.loads(row.get(key) or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


# --------------------------------------------------------------- refusals/relay
def _refuse_view_only() -> dict:
    """Answer-only refusal for a view-only caller (Spec §4 capability-gating)."""
    return {
        "error": "view_only",
        "status": 403,
        "message": ("You'd need the edit link to change this — I can explain the "
                    "numbers, but I can't apply an edit from a view-only link."),
    }


def _figure_stripped(value: object) -> dict:
    """Reject a computed money/percent figure in a mutate arg (no LLM figure applied)."""
    return {
        "error": "figure_stripped",
        "status": 422,
        "value": value,
        "message": ("I can only apply a raw input value, not a computed figure. "
                    "Tell me the underlying number (e.g. 0.08, not 8%)."),
    }


def _figure_guard(*values: object) -> dict | None:
    for v in values:
        if is_computed_figure_token(v):
            return _figure_stripped(v)
    return None


def _relay(exc: HTTPException) -> dict:
    """Turn a service HTTPException into structured data the model relays in prose."""
    detail = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
    return {**detail, "status": exc.status_code}


# --------------------------------------------------------------------- diff
def _diff_view_models(before: dict, after: dict) -> list[dict]:
    """Grounded was->now diff over the decision metrics + the editable rows.

    Both sides come from the engine's ``computed_json`` (the pre-edit stored
    snapshot and the post-edit recompute), so every figure here is grounded — Penny
    narrates the engine's effect, never an invented number.
    """
    changed: list[dict] = []
    bm = (before or {}).get("metrics") or {}
    am = (after or {}).get("metrics") or {}
    for key, label in (("capital", "Capital required"),
                       ("cashGap", "First-year cash gap"),
                       ("breakeven", "Break-even month")):
        bd = (bm.get(key) or {}).get("display")
        ad = (am.get(key) or {}).get("display")
        if bd != ad:
            changed.append({"label": label, "was": bd, "now": ad})

    brows = {(r.get("label"), r.get("group")): r
             for r in ((before or {}).get("rows") or [])}
    for r in (after or {}).get("rows") or []:
        b = brows.get((r.get("label"), r.get("group")))
        if b is None:
            continue
        for yr in ("y1", "y2", "y3"):
            bd = (b.get(yr) or {}).get("display")
            ad = (r.get(yr) or {}).get("display")
            if bd != ad:
                changed.append({"label": f"{r.get('label')} (Y{yr[-1]})",
                                "was": bd, "now": ad})
    return changed


# ------------------------------------------------------------- shared mutate
def _apply(
    store: Store,
    ctx: ToolContext,
    body: PatchProjectionIn,
    change_summary: str,
    *,
    row: dict | None = None,
) -> dict:
    """Route a built patch through the existing mutation service as ``actor:penny``.

    Reads the pre-edit snapshot for the diff, uses the version Penny GROUNDED on at
    the start of the turn (``ctx.version``, threaded by the loop from what it read)
    as the ``If-Match``, and advances ``ctx.version`` on success so multiple edits in
    one turn stay consistent.

    Fail-closed (issue #165): a missing ``ctx.version`` is NOT back-filled from a
    fresh read of the row — doing so manufactures a guaranteed-fresh ``If-Match`` that
    always matches and silently clobbers a concurrent human/edit-token change (a lost
    update). With no grounded version the write is refused with the SAME ``428
    if_match_required`` the manual PATCH raises (:func:`app.deps.parse_if_match`):
    Penny hits the identical optimistic-concurrency wall as the manual UI, no
    privileged path. A grounded-but-stale version writes 0 rows -> a real 409 the loop
    surfaces to Penny for a re-read/retry (or to relay to the user).
    """
    if row is None:
        row = store.get_projection_by_slug(ctx.view_slug or "")
    if row is None:
        return {"error": "not_found", "status": 404}
    if ctx.version is None:
        return {
            "error": "if_match_required",
            "status": 428,
            "message": ("I need to re-read the latest numbers before I can apply "
                        "that edit — let me reload and try again."),
        }
    before_vm = _load_json(row, "computed_json")
    if_match = ctx.version
    try:
        vm, new_version, _name = apply_projection_patch(
            row=row, body=body, store=store, token=ctx.bearer_token,
            if_match=if_match, actor="penny", change_summary=change_summary)
    except HTTPException as exc:
        return _relay(exc)
    ctx.version = new_version  # track for subsequent edits in the same turn
    return {
        "applied": True,
        "version": new_version,
        "actor": "penny",
        "changed": _diff_view_models(before_vm, vm),
    }


# ------------------------------------------------------------- cost-schedule ops
class _RowNotFound(Exception):
    def __init__(self, category: object, month: object) -> None:
        super().__init__("cost row not found")
        self.category = category
        self.month = month


class _BadOp(Exception):
    def __init__(self, op: object) -> None:
        super().__init__("unknown cost-schedule op")
        self.op = op


def _as_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return None


def _maybe_int(value: object) -> object:
    coerced = _as_int(value)
    return value if coerced is None else coerced


def _maybe_num(value: object) -> object:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return value
    return value


def _row_matches(row: dict, category: object, month: object) -> bool:
    if row.get("category") != category:
        return False
    if month is None:
        return True
    rm = _as_int(row.get("month"))
    target = _as_int(month)
    return rm is not None and target is not None and rm == target


def _apply_schedule_ops(
    schedule: list[dict], ops: list[dict], provenance: dict
) -> tuple[list[dict], list[dict]]:
    """Apply add/edit/remove ops to the timed cost schedule (server validates after).

    AI-created rows carry ``provenance`` (Spec §6.2/§9). Locator for edit/remove is
    (category, month). The engine never consumes the schedule yet (it is filtered
    out of the engine args), so these ops change stored data + audit only.
    """
    out = [dict(r) for r in schedule]
    applied: list[dict] = []
    for op in ops:
        kind = str(op.get("op") or "").lower()
        category = op.get("category")
        month = op.get("month")
        if kind == "add":
            new_row = {
                "category": category,
                "month": _maybe_int(month),
                "amount": _maybe_num(op.get("amount")),
                "provenance": dict(provenance),
            }
            out.append(new_row)
            applied.append({"op": "add", "category": category, "month": new_row["month"]})
        elif kind == "edit":
            match = next((r for r in out if _row_matches(r, category, month)), None)
            if match is None:
                raise _RowNotFound(category, month)
            if op.get("amount") is not None:
                match["amount"] = _maybe_num(op.get("amount"))
            if op.get("new_month") is not None:
                match["month"] = _maybe_int(op.get("new_month"))
            applied.append({"op": "edit", "category": category, "month": match["month"]})
        elif kind == "remove":
            keep = [r for r in out if not _row_matches(r, category, month)]
            if len(keep) == len(out):
                raise _RowNotFound(category, month)
            out = keep
            applied.append({"op": "remove", "category": category, "month": _maybe_int(month)})
        else:
            raise _BadOp(kind)
    return out, applied


def _provenance(ctx: ToolContext) -> dict:
    turn_id = ctx.extra.get("turn_id") if isinstance(ctx.extra, dict) else None
    return {"source": "ai", "turn_id": turn_id, "created_at": _utcnow()}


# ------------------------------------------------------------------ handlers
def _read_projection(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        row = store.get_projection_by_slug(ctx.view_slug or "")
        if row is None:
            return {"error": "not_found", "status": 404}
        vm = _load_json(row, "computed_json")
        inputs_d = _load_json(row, "inputs_json")
        assumptions_d = _load_json(row, "assumptions_json")
        trade_d = _load_json(row, "trade_area_json")
        schedule = inputs_d.get("cost_schedule") or default_cost_schedule()
        editable_inputs = {k: v for k, v in inputs_d.items() if k != "cost_schedule"}
        return {
            "version": row["version"],
            "name": row["name"],
            "reco": vm.get("reco") or {},
            "metrics": vm.get("metrics") or {},
            "kpis": vm.get("kpis") or [],
            "rows": vm.get("rows") or [],
            "overrides": vm.get("overrides") or [],
            "cost_schedule": schedule,
            "opening_month_number": inputs_d.get(
                "opening_month_number", DEFAULT_OPENING_MONTH_NUMBER),
            "editable_surface": {
                "inputs": editable_inputs,
                "assumptions": assumptions_d,
                "trade_area": trade_d,
            },
        }
    return handler


def _parse_proposal(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        """Extract-only parse over the uploaded proposal (PE9, spec §9).

        Resolves a held upload by ``proposal_ref`` (from the tool args, or threaded
        onto ``ctx.extra`` by the router) → reads its PDF text → parses candidate
        line-items / tiers / phase→month mapping. ``proposal_text`` (a pre-extracted
        body, e.g. from a test) takes precedence. Every figure traces to the document;
        nothing is invented (the untrusted bytes are never executed/rendered).
        """
        text = str(args.get("proposal_text") or "")
        if not text:
            ref = args.get("proposal_ref")
            if not ref and isinstance(ctx.extra, dict):
                ref = ctx.extra.get("proposal_ref")
            if ref:
                held = proposal_intake.get_proposal(str(ref))
                if held is None:
                    return {
                        "error": "proposal_not_found",
                        "status": 404,
                        "message": ("I couldn't find that uploaded proposal — try "
                                    "re-attaching the PDF and asking again."),
                    }
                text = proposal_intake.extract_pdf_text(held.get("data") or b"")
        return proposal_intake.parse_proposal_text(text)
    return handler


def _set_input(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _refuse_view_only()
        field = args.get("field")
        value = args.get("value")
        if value is None:
            return {"error": "invalid_inputs", "status": 422, "message": "value is required"}
        guard = _figure_guard(value)
        if guard:
            return guard
        if field == "name":
            body = PatchProjectionIn(name=str(value))
        elif field in _SET_INPUT_INPUT_FIELDS:
            body = PatchProjectionIn(inputs={field: value})
        elif field == "households":
            body = PatchProjectionIn(trade_area={"households": str(value)})
        else:
            return {"error": "unknown_field", "status": 422, "field": field}
        return _apply(store, ctx, body, f"penny: set {field}")
    return handler


def _set_assumption(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _refuse_view_only()
        name = args.get("name")
        value = args.get("value")
        if value is None:
            return {"error": "invalid_inputs", "status": 422, "message": "value is required"}
        guard = _figure_guard(value)
        if guard:
            return guard
        bucket = _ASSUMPTION_BUCKET.get(str(name))
        if bucket is None:
            return {"error": "unknown_field", "status": 422, "field": name}
        patch = {str(name): str(value)}
        if bucket == "assumptions":
            body = PatchProjectionIn(assumptions=patch)
        else:
            body = PatchProjectionIn(inputs=patch)
        return _apply(store, ctx, body, f"penny: set {name}")
    return handler


def _set_override(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _refuse_view_only()
        node = args.get("node")
        year = args.get("year")
        value = args.get("value")
        note = args.get("note") or ""
        if node is None or year is None or value is None:
            return {"error": "invalid_inputs", "status": 422,
                    "message": "node, year, and value are required"}
        guard = _figure_guard(value)
        if guard:
            return guard
        body = PatchProjectionIn(overrides={"set": [
            {"node": node, "year": int(year), "value": str(value), "note": note}]})
        return _apply(store, ctx, body, f"penny: pin {node}#{year}")
    return handler


def _clear_override(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _refuse_view_only()
        node = args.get("node")
        year = args.get("year")
        if node is None or year is None:
            return {"error": "invalid_inputs", "status": 422,
                    "message": "node and year are required"}
        body = PatchProjectionIn(overrides={"clear": [{"node": node, "year": int(year)}]})
        return _apply(store, ctx, body, f"penny: clear pin {node}#{year}")
    return handler


def _edit_cost_schedule(store: Store):
    def handler(args: dict, ctx: ToolContext) -> dict:
        if not ctx.can_mutate:
            return _refuse_view_only()
        ops = args.get("ops") or []
        for op in ops:
            guard = _figure_guard(op.get("amount"))
            if guard:
                return guard
        row = store.get_projection_by_slug(ctx.view_slug or "")
        if row is None:
            return {"error": "not_found", "status": 404}
        inputs_d = _load_json(row, "inputs_json")
        schedule = list(inputs_d.get("cost_schedule") or default_cost_schedule())
        try:
            new_schedule, applied = _apply_schedule_ops(schedule, ops, _provenance(ctx))
        except _RowNotFound as exc:
            return {"error": "row_not_found", "status": 422,
                    "category": exc.category, "month": exc.month}
        except _BadOp as exc:
            return {"error": "bad_op", "status": 422, "op": exc.op}

        # Same COUNT cap as the manual PATCH (issue #166): refuse before the write so
        # Penny can't balloon the schedule (a consultant-proposal parse appends rows
        # with no inherent bound) into a blob / revision-bloat DoS. Mirrors the
        # `invalid_inputs` 422 `_validate_schedule_inputs` would raise on this same
        # array, so the manual and AI paths reject identically.
        if len(new_schedule) > MAX_COST_SCHEDULE_ROWS:
            return {
                "error": "invalid_inputs",
                "status": 422,
                "message": (
                    f"That would leave {len(new_schedule)} cost rows, over the "
                    f"{MAX_COST_SCHEDULE_ROWS}-row limit. Remove some rows first."
                ),
            }

        patch_inputs: dict[str, Any] = {"cost_schedule": new_schedule}
        opening = args.get("opening_month_number")
        if opening is not None:
            patch_inputs["opening_month_number"] = opening
        body = PatchProjectionIn(inputs=patch_inputs)
        result = _apply(store, ctx, body, "penny: edit cost schedule", row=row)
        if result.get("applied"):
            result["cost_schedule"] = new_schedule
            result["schedule_ops_applied"] = applied
        return result
    return handler


# --------------------------------------------------------------- tool schemas
_VALUE_NOTE = ("Raw input value (a bare number or fraction, e.g. 0.08 or 5000); "
               "NEVER a display-formatted figure like $5,000 or 8% — those are "
               "rejected as computed figures.")

_SCHEMAS: dict[str, dict] = {
    "read_projection": {
        "type": "object", "properties": {}, "additionalProperties": False,
    },
    "parse_proposal": {
        "type": "object",
        "properties": {
            "proposal_ref": {"type": "string",
                             "description": "Server ref to an uploaded proposal (PE9)."},
            "proposal_text": {"type": "string",
                              "description": "Untrusted proposal text to extract from."},
        },
        "additionalProperties": False,
    },
    "set_input": {
        "type": "object",
        "properties": {
            "field": {"type": "string", "enum": sorted(
                {"name", "households", *_SET_INPUT_INPUT_FIELDS})},
            "value": {"description": _VALUE_NOTE},
        },
        "required": ["field", "value"],
        "additionalProperties": False,
    },
    "set_assumption": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "enum": sorted(_ASSUMPTION_BUCKET)},
            "value": {"description": _VALUE_NOTE},
        },
        "required": ["name", "value"],
        "additionalProperties": False,
    },
    "set_override": {
        "type": "object",
        "properties": {
            "node": {"type": "string", "description": "Pinnable component node."},
            "year": {"type": "integer", "enum": [1, 2, 3]},
            "value": {"description": _VALUE_NOTE},
            "note": {"type": "string"},
        },
        "required": ["node", "year", "value"],
        "additionalProperties": False,
    },
    "clear_override": {
        "type": "object",
        "properties": {
            "node": {"type": "string"},
            "year": {"type": "integer", "enum": [1, 2, 3]},
        },
        "required": ["node", "year"],
        "additionalProperties": False,
    },
    "edit_cost_schedule": {
        "type": "object",
        "properties": {
            "ops": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {"type": "string", "enum": ["add", "edit", "remove"]},
                        "category": {"type": "string"},
                        "month": {"type": "integer",
                                  "description": "Project month (>= 1)."},
                        "amount": {"description": "Dollar amount (>= 0); a raw number."},
                        "new_month": {"type": "integer"},
                    },
                    "required": ["op", "category"],
                },
            },
            "opening_month_number": {"type": "integer",
                                     "description": "Opening anchor month (>= 1)."},
        },
        "additionalProperties": False,
    },
}

_FACTORIES = {
    "read_projection": (_read_projection, "read"),
    "parse_proposal": (_parse_proposal, "extract"),
    "set_input": (_set_input, "mutate"),
    "set_assumption": (_set_assumption, "mutate"),
    "set_override": (_set_override, "mutate"),
    "clear_override": (_clear_override, "mutate"),
    "edit_cost_schedule": (_edit_cost_schedule, "mutate"),
}

_DESCRIPTIONS = {
    "read_projection": ("Read the current grounded projection facts: decision "
                        "metrics, KPIs, P&L rows, overrides, cost schedule, and the "
                        "editable surface. The only source of numbers — never guess."),
    "parse_proposal": ("Extract-only: pull candidate cost line-items and figures "
                       "from an untrusted consultant proposal. Numbers must come from "
                       "the document; nothing is invented."),
    "set_input": "Set a projection input (name, city, households, opening anchor/date).",
    "set_assumption": ("Set an assumption (donor shares, labor/marketing/supplies %, "
                       "rent, escalator, basket, …). The server domain-validates."),
    "set_override": ("Pin a component node {node}#{year} to a value. The server "
                     "rejects non-pinnable totals/KPIs and enforces DAG rules."),
    "clear_override": "Remove a pin on {node}#{year}.",
    "edit_cost_schedule": ("Add / edit / remove timed cost rows {category, month, "
                           "amount} and set the opening anchor. Server-validated."),
}


def build_registry(store: Store) -> ToolRegistry:
    """Register the seven Penny tools (bound to ``store``) into a fresh registry.

    PE5's router builds the registry per request with the resolved store and passes
    it to :func:`app.penny.loop.run_turn`; the loop sends each tool's schema to the
    model and executes the matching handler server-side.
    """
    registry = ToolRegistry()
    for name, (factory, kind) in _FACTORIES.items():
        registry.register(Tool(
            name=name,
            description=_DESCRIPTIONS[name],
            input_schema=_SCHEMAS[name],
            handler=factory(store),
            kind=kind,
        ))
    return registry

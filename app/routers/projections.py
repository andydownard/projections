"""app/routers/projections.py — M2 projections API: create / read / owner-list.

The server is the single math authority (CLAUDE.md): every create runs the pure
engine (`engine.compute`) and persists its native Appendix-D view-model as
`computed_json`. Reads return that stored snapshot verbatim — never a silent
recompute (PRD §13). Lists are owner-scoped via the SHA-256 hash of the bearer
owner token (SECURITY.md §2). Capability tokens are minted with a CSPRNG and
returned exactly once; only their hashes are stored.

This slice is create/read/list + PATCH (autosave). Every mutation requires a Bearer
owner/edit token + If-Match: <version>; recompute is server-side; optimistic
concurrency yields HTTP 409 with current state on a stale If-Match; one revision
snapshot is written per settle. The .xlsx export lands in a later slice.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field

from app.deps import hash_token, parse_if_match, token_matches
from app.store import Store, get_store
from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.viewmodel import to_view_model

router = APIRouter(prefix="/api/projections", tags=["projections"])


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    # App-generated, sortable-ish string PK (no DB autoincrement; Postgres-portable).
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + secrets.token_hex(8)


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


# ----------------------------------------------------------------- request body
class InputsIn(BaseModel):
    org_name: str = ""
    city: str
    opening_status: str = "pre_launch"
    share_y1: str
    share_y2: str
    share_y3: str
    donation_value: str
    building_sqft: str
    salesfloor_pct: str
    source_of_funds: str
    occupancy_annual: Optional[str] = None
    rent_per_sqft: Optional[str] = None
    lease_type: str = "gross"
    nnn_opex_annual: str = "0"


class TradeAreaIn(BaseModel):
    basis: str = "city"
    households: str = "0"
    acs_vintage: Optional[str] = None


class AssumptionsIn(BaseModel):
    labor_pct: Optional[str] = None
    marketing_pct: Optional[str] = None
    supplies_pct: Optional[str] = None
    card_pct: Optional[str] = None
    payroll_tax_pct: Optional[str] = None
    salvage_pct: Optional[str] = None
    escalator: Optional[str] = None
    basket: Optional[str] = None


class CreateProjectionIn(BaseModel):
    name: Optional[str] = None
    inputs: InputsIn
    trade_area: TradeAreaIn = Field(default_factory=TradeAreaIn)
    assumptions: Optional[AssumptionsIn] = None
    demand: Optional[dict] = None
    overrides: dict = Field(default_factory=dict)
    location: dict = Field(default_factory=dict)


class PatchProjectionIn(BaseModel):
    """A partial of the editable surface (API_SPEC §4.4). Every field optional."""
    name: Optional[str] = None
    inputs: Optional[dict] = None
    trade_area: Optional[dict] = None
    assumptions: Optional[dict] = None
    demand: Optional[dict] = None
    overrides: Optional[dict] = None


def _build_engine_args(body: CreateProjectionIn):
    return _build_engine_args_from_dicts(
        body.inputs.model_dump(),
        body.assumptions.model_dump() if body.assumptions else None,
        body.demand or {},
        body.trade_area.model_dump(),
    )


def _build_engine_args_from_dicts(
    inputs_d: dict, assumptions_d: Optional[dict], demand_d: dict, trade_d: dict
):
    inputs = Inputs(**inputs_d)
    akw = {k: v for k, v in (assumptions_d or {}).items() if v is not None}
    assumptions = Assumptions(**akw)
    demand = DemandDrivers(**(demand_d or {}))
    trade = TradeArea(**{k: v for k, v in (trade_d or {}).items() if v is not None})
    return inputs, assumptions, demand, trade


def _compute_view_model(body: CreateProjectionIn) -> dict[str, Any]:
    inputs, assumptions, demand, trade = _build_engine_args(body)
    result = compute(inputs, assumptions, demand, trade, overrides=body.overrides or {})
    # Native Appendix-D output; to_view_model is the same dict (defensive).
    return result.view_model or to_view_model(result)


def _compute_view_model_from_dicts(
    inputs_d: dict, assumptions_d: Optional[dict], demand_d: dict,
    trade_d: dict, overrides_d: dict,
) -> dict[str, Any]:
    inputs, assumptions, demand, trade = _build_engine_args_from_dicts(
        inputs_d, assumptions_d, demand_d, trade_d)
    result = compute(inputs, assumptions, demand, trade, overrides=overrides_d or {})
    return result.view_model or to_view_model(result)


# -------------------------------------------------------------------- endpoints
@router.post("", status_code=201)
def create_projection(
    body: CreateProjectionIn,
    store: Store = Depends(get_store),
    authorization: Optional[str] = Header(default=None),
):
    """Create: compute server-side, persist, return the view-model + one-time tokens.

    If a valid owner bearer token is presented the projection joins that workspace;
    otherwise a new owner token is minted and returned exactly once.
    """
    try:
        vm = _compute_view_model(body)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail={"error": "invalid_inputs", "message": str(exc)})

    presented_owner = _bearer(authorization)
    minted_owner = None
    if presented_owner is None:
        presented_owner = secrets.token_urlsafe(32)  # ~256-bit
        minted_owner = presented_owner
    owner_hash = hash_token(presented_owner)

    view_slug = secrets.token_urlsafe(16)  # ~128-bit
    edit_token = secrets.token_urlsafe(32)
    pid = _new_id()
    now = _utcnow()
    name = body.name or body.inputs.org_name or "Untitled projection"

    row = {
        "id": pid,
        "view_slug": view_slug,
        "owner_token_hash": owner_hash,
        "edit_token_hash": hash_token(edit_token),
        "name": name,
        "model_version": vm.get("model_version", ""),
        "compute_schema_version": vm.get("compute_schema_version", ""),
        "location_json": json.dumps(body.location or {}),
        "trade_area_json": json.dumps(body.trade_area.model_dump()),
        "inputs_json": json.dumps(body.inputs.model_dump()),
        "demand_drivers_json": json.dumps(body.demand or {}),
        "assumptions_json": json.dumps(body.assumptions.model_dump() if body.assumptions else {}),
        "overrides_json": json.dumps(body.overrides or {}),
        "computed_json": json.dumps(vm),
        "created_at": now,
        "updated_at": now,
    }
    store.create_projection(row)

    out = {
        **vm,
        "view_slug": view_slug,
        "version": 1,
        "name": name,
        "edit_token": edit_token,  # one-time
    }
    if minted_owner is not None:
        out["owner_token"] = minted_owner  # one-time; client stores in localStorage
    return out


@router.get("")
def list_projections(
    store: Store = Depends(get_store),
    authorization: Optional[str] = Header(default=None),
):
    """Owner-scoped list (never global). No/invalid token -> empty list."""
    owner = _bearer(authorization)
    if owner is None:
        return {"projections": []}
    rows = store.list_by_owner(hash_token(owner))
    items = []
    for r in rows:
        try:
            vm = json.loads(r.get("computed_json") or "{}")
        except json.JSONDecodeError:
            vm = {}
        y1_rev = None
        try:
            y1_rev = (vm.get("kpis") or [{}])[0]
        except Exception:
            y1_rev = None
        items.append({
            "view_slug": r["view_slug"],
            "name": r["name"],
            "version": r["version"],
            "updated_at": r["updated_at"],
            "reco": vm.get("reco", {}).get("tag"),
            "y1": y1_rev,
        })
    return {"projections": items}


@router.get("/{view_slug}")
def get_projection(view_slug: str, response: Response, store: Store = Depends(get_store)):
    """Read by capability slug: return the STORED snapshot verbatim (no recompute)."""
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        vm = {}
    response.headers["ETag"] = str(row["version"])
    return {**vm, "view_slug": view_slug, "version": row["version"], "name": row["name"]}


@router.patch("/{view_slug}")
def patch_projection(
    view_slug: str,
    body: PatchProjectionIn,
    response: Response,
    store: Store = Depends(get_store),
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Autosave (API_SPEC §4.4): merge patch -> recompute server-side -> persist.

    Requires Authorization: Bearer (owner OR this projection's edit token) and
    If-Match: <version>. Optimistic concurrency: a stale version writes 0 rows and
    returns HTTP 409 with the current server state. One revision snapshot per settle.
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    is_owner = token is not None and token_matches(token, row["owner_token_hash"])
    is_editor = (
        token is not None
        and bool(row.get("edit_token_hash"))
        and token_matches(token, row["edit_token_hash"])
    )
    if not (is_owner or is_editor):
        # view-only (no/invalid token) cannot mutate (SECURITY.md §2; API_SPEC §4.4).
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    # Merge the partial onto the stored source-of-truth, then recompute.
    inputs_d = json.loads(row["inputs_json"] or "{}")
    assumptions_d = json.loads(row["assumptions_json"] or "{}")
    demand_d = json.loads(row["demand_drivers_json"] or "{}")
    trade_d = json.loads(row["trade_area_json"] or "{}")
    overrides_d = json.loads(row["overrides_json"] or "{}")
    if body.inputs:
        inputs_d.update(body.inputs)
    if body.assumptions:
        assumptions_d.update(body.assumptions)
    if body.demand:
        demand_d.update(body.demand)
    if body.trade_area:
        trade_d.update(body.trade_area)
    if body.overrides is not None:
        overrides_d = body.overrides
    name = body.name if body.name is not None else row["name"]

    try:
        vm = _compute_view_model_from_dicts(inputs_d, assumptions_d, demand_d, trade_d, overrides_d)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail={"error": "invalid_inputs", "message": str(exc)})

    patch = {
        "name": name,
        "inputs_json": json.dumps(inputs_d),
        "assumptions_json": json.dumps(assumptions_d),
        "demand_drivers_json": json.dumps(demand_d),
        "trade_area_json": json.dumps(trade_d),
        "overrides_json": json.dumps(overrides_d),
        "computed_json": json.dumps(vm),
        "model_version": vm.get("model_version", ""),
    }
    affected = store.update_with_version_check(row["id"], if_match, patch)
    if affected == 0:
        current = store.get_projection_by_slug(view_slug)
        try:
            cur_vm = json.loads(current["computed_json"] or "{}") if current else {}
        except json.JSONDecodeError:
            cur_vm = {}
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict",
            "current_version": current["version"] if current else None,
            "your_version": if_match,
            "current_state": {**cur_vm, "view_slug": view_slug,
                              "version": current["version"] if current else None},
            "recovery": "reload | overwrite | save_as_copy",
        })

    new_version = if_match + 1
    store.insert_revision({
        "id": _new_id(),
        "projection_id": row["id"],
        "seq": new_version,
        "inputs_json": patch["inputs_json"],
        "assumptions_json": patch["assumptions_json"],
        "overrides_json": patch["overrides_json"],
        "monthly_json": "{}",
        "computed_json": patch["computed_json"],
        "model_version": patch["model_version"],
        "actor_token_hash": hash_token(token),
        "change_summary": "autosave",
        "created_at": _utcnow(),
    })
    response.headers["ETag"] = str(new_version)
    return {**vm, "view_slug": view_slug, "version": new_version, "name": name}

"""app/routers/projections.py — M2 projections API: create / read / owner-list.

The server is the single math authority (CLAUDE.md): every create runs the pure
engine (`engine.compute`) and persists its native Appendix-D view-model as
`computed_json`. Reads return that stored snapshot verbatim — never a silent
recompute (PRD §13). Lists are owner-scoped via the SHA-256 hash of the bearer
owner token (SECURITY.md §2). Capability tokens are minted with a CSPRNG and
returned exactly once; only their hashes are stored.

This slice is create/read/list. PATCH (autosave) + If-Match/409 + .xlsx land in
the next slice (app/routers/projections_mutations.py).
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field

from app.deps import hash_token
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


def _build_engine_args(body: CreateProjectionIn):
    inputs = Inputs(**body.inputs.model_dump())
    akw = {k: v for k, v in (body.assumptions.model_dump().items() if body.assumptions else [])
           if v is not None}
    assumptions = Assumptions(**akw)
    demand = DemandDrivers(**(body.demand or {}))
    trade = TradeArea(**{k: v for k, v in body.trade_area.model_dump().items() if v is not None})
    return inputs, assumptions, demand, trade


def _compute_view_model(body: CreateProjectionIn) -> dict[str, Any]:
    inputs, assumptions, demand, trade = _build_engine_args(body)
    result = compute(inputs, assumptions, demand, trade, overrides=body.overrides or {})
    # Native Appendix-D output; to_view_model is the same dict (defensive).
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

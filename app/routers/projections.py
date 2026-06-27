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

# ruff: noqa: UP045 -- keep typing.Optional: Pydantic/FastAPI evaluate these
# annotations at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.background import BackgroundTask

from app import config, narrative_provider, ratelimit
from app.deps import hash_token, parse_if_match, token_matches
from app.geo.client import GeoUpstreamError, static_map_bytes
from app.narrative import (
    GroundingError,
    canonical_grounded_figures,
    compute_hash,
    format_was_now,
    sanitize_body_md,
    stale_diff,
    validate_grounding,
)
from app.packet import build_packet, render_packet_docx, render_packet_md
from app.store import Store, get_store
from engine import dag
from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute, compute_annual
from engine.model import DEFAULT_OPENING_MONTH_NUMBER, default_cost_schedule
from engine.money import D, number_view
from engine.viewmodel import to_view_model
from engine.xlsx import build_xlsx

# Auto-clear-on-equal tolerance (API_SPEC §4.4): a pin within $0.50 of the
# calculated value deletes the pin (matches the design's commit semantics).
_AUTO_CLEAR_TOLERANCE = D("0.50")

XLSX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

# Preview is a read-only dry-run on the read bucket (API_SPEC §2.3): generous,
# since it backs a debounced "what-if" surface, but still capped against abuse.
_PREVIEW_IP_LIMIT = 600
_PREVIEW_TOKEN_LIMIT = 600
_PREVIEW_WINDOW_SECONDS = 300

# Cost-DoS caps (SECURITY.md §10; issues #164/#168). create is UNAUTHENTICATED and
# each call mints tokens + runs the engine + a durable write -> 20/hr/IP per §10.1
# (per-token is "—" since the flood is anonymous). The export surfaces are reachable
# with only the public view_slug: xlsx/packet rebuild an uncached workbook/packet on
# every call (CPU), staticmap proxies the billed Google Static Maps API (bytes are
# cached per location, so the Google-bill blast radius is first-fetch-per-location).
_CREATE_IP_LIMIT = 20
_CREATE_WINDOW_SECONDS = 3600
_EXPORT_IP_LIMIT = 30  # xlsx + packet, per IP
_EXPORT_TOKEN_LIMIT = 60  # xlsx + packet, per token when a bearer is presented
_EXPORT_WINDOW_SECONDS = 3600
_STATICMAP_IP_LIMIT = 120  # cached per (lat,lng,kind); per IP only (view-capability)
_STATICMAP_WINDOW_SECONDS = 3600

router = APIRouter(prefix="/api/projections", tags=["projections"])


def _client_ip(request: Request) -> str:
    """Right-most untrusted hop from X-Forwarded-For, else the socket peer.

    Railway terminates TLS at a single proxy that appends the real client IP as the
    LAST X-Forwarded-For entry, so the right-most hop is the only one a client cannot
    spoof (anything it sends arrives to the left of the proxy's append). SECURITY §10.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit_bypassed() -> bool:
    """True only under the non-prod E2E seed flag (mirrors app/main.py's seed gate).

    The Playwright gate drives create->export across three viewports (plus CI retries)
    against one server from one IP; bypassing the caps there keeps the cost-DoS brakes
    real in production while the E2E flow never trips them. Never active in prod.
    """
    return os.environ.get("E2E_SEED") == "1" and not config.is_production()


def _rate_limited(
    endpoint: str,
    request: Request,
    *,
    ip_limit: int,
    token: Optional[str] = None,
    token_limit: Optional[int] = None,
    window_seconds: int = 3600,
) -> Optional[JSONResponse]:
    """Shared §10 gate: a 429 JSONResponse when over the per-IP/per-token cap, else
    None. Emitted BEFORE any compute/build/upstream call (the cheapest rejection)."""
    if _rate_limit_bypassed():
        return None
    allowed, retry_after = ratelimit.check(
        endpoint,
        ip=_client_ip(request),
        token=token,
        ip_limit=ip_limit,
        token_limit=token_limit,
        window_seconds=window_seconds,
    )
    if allowed:
        return None
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limited", "retry_after_seconds": retry_after, "scope": "ip"},
        headers={"Retry-After": str(retry_after)},
    )


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    # App-generated, sortable-ish string PK (no DB autoincrement; Postgres-portable).
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + secrets.token_hex(8)


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


def _require_owner(store: Store, view_slug: str, authorization: Optional[str]) -> dict:
    """Load the projection and assert the bearer is the OWNER (owner-only routes).

    Edit/view tokens get 403 owner_required (rotate/trash/restore/delete/revisions
    are owner-scoped — API_SPEC §1.2). Unknown slug -> 404 (never reveal existence
    beyond what the slug already grants).
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    token = _bearer(authorization)
    if _is_owner(token, row):
        return row
    if _is_editor(token, row):
        raise HTTPException(status_code=403, detail={"error": "owner_required"})
    raise HTTPException(status_code=403, detail={"error": "forbidden"})


# ----------------------------------------------------------------- request body
class CostScheduleItemIn(BaseModel):
    """One timed startup line item (Spec §5): a labelled cost landing on a project
    month. Server-validated — ``month >= 1`` and ``amount >= 0`` (no client math).

    A row MAY also carry opaque ``provenance`` metadata (DATA_MODEL §7) — Penny
    stamps ``{"source": "ai", ...}`` on rows she creates (Spec B §6.2/§9). Provenance
    is validated/stored by ``_validate_schedule_inputs`` (not modelled here so the
    create round-trip stays ``{category, month, amount}`` exactly); it never feeds
    the engine (cost_schedule is filtered out of the engine args)."""
    category: str
    month: int = Field(ge=1)
    amount: float = Field(ge=0)

    class Config:
        extra = "forbid"


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
    # Timed cost schedule + opening anchor (Spec §5/§7). The fixed STARTUP lump is
    # superseded by cost_schedule; when omitted the engine/migration default (the
    # month-1 lump from engine.model.STARTUP) applies, reproducing today's numbers.
    target_opening_date: Optional[str] = None
    opening_month_number: int = Field(default=DEFAULT_OPENING_MONTH_NUMBER, ge=1)
    cost_schedule: Optional[list[CostScheduleItemIn]] = None


# Inputs keys that are part of the saved projection but are NOT positional args of
# the engine's frozen ``Inputs`` dataclass (the engine consumes the schedule/anchor
# separately, in a later wave). They are filtered out before constructing Inputs.
_NON_ENGINE_INPUT_KEYS = (
    "target_opening_date",
    "opening_month_number",
    "cost_schedule",
)

# Max rows in a timed ``cost_schedule`` (DoS guard, issue #166). The schedule is
# JSON-serialized into ``inputs_json``/``cost_schedule_json`` AND snapshotted into a
# fresh revision on every save, so an unbounded array is a per-projection blob /
# revision-bloat amplifier (durable volume + Litestream cost, large-JSON CPU/mem).
# 200 is generous — far above any real launch schedule (~10-30 timed startup rows)
# yet a hard domain bound below the request-body ceiling — and mirrors the existing
# 200-row cap used elsewhere (the Penny transcript ``MAX_TURNS`` retention bound,
# DATA_MODEL §penny_transcripts). Enforced server-side on the manual PATCH
# (``_validate_schedule_inputs``) and after Penny's ``edit_cost_schedule`` ops.
MAX_COST_SCHEDULE_ROWS = 200


class TradeAreaIn(BaseModel):
    basis: str = "city"
    households: str = "0"
    acs_vintage: Optional[str] = None
    # Census provenance (set by the Places->Census derivation; not engine inputs).
    geography_name: Optional[str] = None
    geography_fips: Optional[str] = None
    households_source: Optional[str] = None  # "census_acs" | "user_edited" | "manual"
    moe: Optional[int] = None

    class Config:
        extra = "ignore"


# Only these trade-area keys are engine inputs; provenance keys are filtered out
# before constructing engine.compute.TradeArea (which accepts only these).
_ENGINE_TRADE_KEYS = ("basis", "households", "acs_vintage")


class AssumptionsIn(BaseModel):
    labor_pct: Optional[str] = None
    marketing_pct: Optional[str] = None
    supplies_pct: Optional[str] = None
    card_pct: Optional[str] = None
    payroll_tax_pct: Optional[str] = None
    salvage_pct: Optional[str] = None
    escalator: Optional[str] = None
    basket: Optional[str] = None


class LocationIn(BaseModel):
    """Resolved store location. lat/lng are typed floats so non-numeric input is
    rejected at create (422) and can never be stored to crash the map proxy."""
    query: Optional[str] = None
    place_id: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    formatted_address: Optional[str] = None

    class Config:
        extra = "ignore"


class CreateProjectionIn(BaseModel):
    name: Optional[str] = None
    inputs: InputsIn
    trade_area: TradeAreaIn = Field(default_factory=TradeAreaIn)
    assumptions: Optional[AssumptionsIn] = None
    demand: Optional[dict] = None
    overrides: dict = Field(default_factory=dict)
    location: LocationIn = Field(default_factory=LocationIn)
    # Terms acceptance (PRD §21 / API_SPEC §4.2): the operator's explicit "these are
    # planning estimates, not advice" check. Persisted as terms_accepted_at on create
    # so exports (.xlsx / packet) are reachable; defaults False so an unchecked box
    # never silently accepts and the export gate stays honest.
    terms_accepted: bool = False


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


def _validate_schedule_inputs(inputs_d: dict) -> None:
    """Server-side validation of the timed cost schedule + opening anchor (Spec §5).

    Enforces ``month >= 1``, ``amount >= 0``, ``opening_month_number >= 1`` and a
    ``len(cost_schedule) <= MAX_COST_SCHEDULE_ROWS`` count cap (issue #166) on the
    PATCH path (create is validated by ``InputsIn`` at body parse). Raises HTTP 422
    with ``invalid_inputs`` on a bad/oversized schedule so the client never relies on
    client math.

    An optional ``provenance`` object (Penny's AI-created rows, DATA_MODEL §7) is
    tolerated and must be an object; it is stripped before the ``{category, month,
    amount}`` shape is validated so any other unknown key is still rejected.
    """
    try:
        schedule = inputs_d.get("cost_schedule")
        if schedule is not None:
            # COUNT cap first (issue #166): reject an oversized array before paying to
            # validate/serialize every row — bounds blob + per-save revision bloat.
            if len(schedule) > MAX_COST_SCHEDULE_ROWS:
                raise ValueError(
                    f"cost_schedule may not exceed {MAX_COST_SCHEDULE_ROWS} rows "
                    f"(got {len(schedule)})"
                )
            for item in schedule:
                if not isinstance(item, dict):
                    raise TypeError("cost row must be an object")
                provenance = item.get("provenance")
                if provenance is not None and not isinstance(provenance, dict):
                    raise ValueError("provenance must be an object")
                CostScheduleItemIn(**{k: v for k, v in item.items()
                                      if k != "provenance"})
        anchor = inputs_d.get("opening_month_number")
        if anchor is not None and int(anchor) < 1:
            raise ValueError("opening_month_number must be >= 1")
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=422, detail={"error": "invalid_inputs", "message": str(exc)}
        ) from exc


def _schedule_columns(inputs_d: dict) -> dict:
    """Denormalized schedule/anchor columns mirrored from ``inputs`` (DATA_MODEL §7).

    The canonical copy lives in ``inputs_json`` (what the engine consumes); these
    first-class columns mirror it for queryability and match the m0005 backfill
    contract. A row without a schedule resolves to the month-1 lump default so every
    row always carries a resolvable schedule (legacy parity, Spec §7).
    """
    schedule = inputs_d.get("cost_schedule") or default_cost_schedule()
    opening = inputs_d.get("opening_month_number")
    return {
        "cost_schedule_json": json.dumps(schedule),
        "target_opening_date": inputs_d.get("target_opening_date"),
        "opening_month_number": int(opening) if opening is not None
        else DEFAULT_OPENING_MONTH_NUMBER,
    }


def _build_engine_args_from_dicts(
    inputs_d: dict, assumptions_d: Optional[dict], demand_d: dict, trade_d: dict
):
    engine_inputs_d = {
        k: v for k, v in inputs_d.items() if k not in _NON_ENGINE_INPUT_KEYS
    }
    inputs = Inputs(**engine_inputs_d)
    akw = {k: v for k, v in (assumptions_d or {}).items() if v is not None}
    assumptions = Assumptions(**akw)
    demand = DemandDrivers(**(demand_d or {}))
    trade = TradeArea(**{
        k: v for k, v in (trade_d or {}).items()
        if v is not None and k in _ENGINE_TRADE_KEYS
    })
    return inputs, assumptions, demand, trade


def _compute_view_model(body: CreateProjectionIn) -> dict[str, Any]:
    inputs, assumptions, demand, trade = _build_engine_args(body)
    result = compute(inputs, assumptions, demand, trade, overrides=body.overrides or {})
    # Native Appendix-D output; to_view_model is the same dict (defensive).
    return result.view_model or to_view_model(result)


def _enrich_view_model(vm: dict, location_d: dict, trade_d: dict) -> None:
    """Attach location + trade-area provenance + evidence[] to the view-model.

    These are API METADATA, not engine math (the engine stays the single math
    authority): the detail-page map, the City/County basis line, and the evidence
    panel all render from this one stored snapshot, so a read is verbatim and a
    map is never drawn over a number with no resolved location. Mutates `vm`.
    """
    loc = location_d or {}
    lat, lng = loc.get("lat"), loc.get("lng")
    vm["location"] = (
        {
            "place_id": loc.get("place_id"),
            "lat": lat,
            "lng": lng,
            "formatted_address": loc.get("formatted_address", ""),
        }
        if lat is not None and lng is not None
        else None
    )

    ta = trade_d or {}
    vm["trade_area"] = {
        "basis": ta.get("basis", "city"),
        "households": ta.get("households"),
        "geography_name": ta.get("geography_name"),
        "geography_fips": ta.get("geography_fips"),
        "acs_vintage": ta.get("acs_vintage"),
        "households_source": ta.get("households_source"),
        "moe": ta.get("moe"),
    }

    evidence = []
    if ta.get("households_source") == "census_acs":
        vintage = ta.get("acs_vintage") or ""
        households = ta.get("households")
        moe = ta.get("moe")
        # Server is the sole formatting authority (PRD §13): emit display strings
        # the client renders verbatim — no client-side Intl / number formatting.
        value_display = (
            f"~{number_view(households)['display']} households"
            if households is not None
            else None
        )
        moe_display = (
            f"±{number_view(moe)['display']} households (MOE)"
            if moe is not None
            else None
        )
        evidence.append({
            "field": "households",
            "label": "Trade-area households",
            "value": households,
            "value_display": value_display,
            "method": "census_acs",
            "source": f"U.S. Census Bureau, ACS 5-year ({vintage}), table B11001",
            "source_date": vintage,
            "confidence": "estimated",
            "geography": ta.get("geography_name"),
            "moe": moe,
            "moe_display": moe_display,
        })
    vm["evidence"] = evidence


def _compute_result_from_dicts(
    inputs_d: dict, assumptions_d: Optional[dict], demand_d: dict,
    trade_d: dict, overrides_d: dict,
):
    """Recompute the full ComputeResult from stored inputs (the .xlsx source).

    The workbook builder consumes resolved node values, which equal the stored
    computed_json by the single-math-authority invariant (golden gate, §18).
    """
    inputs, assumptions, demand, trade = _build_engine_args_from_dicts(
        inputs_d, assumptions_d, demand_d, trade_d)
    return compute(inputs, assumptions, demand, trade, overrides=overrides_d or {})


def _compute_view_model_from_dicts(
    inputs_d: dict, assumptions_d: Optional[dict], demand_d: dict,
    trade_d: dict, overrides_d: dict,
) -> dict[str, Any]:
    result = _compute_result_from_dicts(
        inputs_d, assumptions_d, demand_d, trade_d, overrides_d)
    return result.view_model or to_view_model(result)


def _safe_filename_stem(name: str) -> str:
    """Sanitize a user-supplied org/projection name for Content-Disposition.

    No path separators, control chars, or quotes ever reach the header — the
    on-disk path is server-controlled (tempfile); this only labels the download.
    """
    stem = re.sub(r"[^A-Za-z0-9 _.-]", "", name or "").strip()
    return stem or "Projection"


def _calculated_unpinned(inputs_d, assumptions_d, demand_d, trade_d):
    """The engine's value for every (node, year) with NO overrides applied.

    Source for auto-clear-on-equal: a pin whose value matches the calculated
    value is dropped. Pure recompute of the annual chain; no back-solve.
    """
    inputs, assumptions, demand, trade = _build_engine_args_from_dicts(
        inputs_d, assumptions_d, demand_d, trade_d)
    years, _s, _st, _occ = compute_annual(inputs, assumptions, demand, trade, {})
    out = {}
    for y in (1, 2, 3):
        yr = years[y]
        out[("share", y)] = D(yr.share)
        for label, val in yr.expenses.items():
            out[(label, y)] = D(val)
    return out


def _apply_override_ops(stored: dict, ops, calc):
    """Translate a set/clear override op (or a full dict) into the storage map.

    storage keys are "{node}#{year}" -> {value, note, ts} (DATA_MODEL §4.6).
    - set: validate the node is pinnable (else PinRejected -> 422); auto-clear if
      the value equals the calculated value within $0.50 (auto-clear-on-equal).
    - clear: drop the pin.
    A non-dict-ops object (legacy full map) replaces the map wholesale after
    validating every key.
    """
    result = dict(stored)
    # Legacy/full-map form: a plain dict of "{node}#{year}" -> pin.
    if not isinstance(ops, dict) or ("set" not in ops and "clear" not in ops):
        dag.validate_all(ops or {})
        return dict(ops or {})

    for item in ops.get("clear", []) or []:
        key = f"{item['node']}#{int(item['year'])}"
        result.pop(key, None)

    for item in ops.get("set", []) or []:
        node = item["node"]
        year = int(item["year"])
        key = f"{node}#{year}"
        dag.validate_pin(key)  # raises PinRejected on a derived/unknown node
        value = D(item["value"])
        calc_val = calc.get((node, year))
        if calc_val is not None and abs(value - calc_val) <= _AUTO_CLEAR_TOLERANCE:
            result.pop(key, None)  # auto-clear-on-equal
            continue
        pin = {"value": str(item["value"]), "note": item.get("note", ""),
               "ts": _utcnow()}
        result[key] = pin
    return result


def _merge_patch(row: dict, body: PatchProjectionIn):
    """Merge an editable-surface partial onto the stored source-of-truth.

    Returns (inputs_d, assumptions_d, demand_d, trade_d, overrides_d, name). This
    is the SHARED merge used by both PATCH (persisting) and /preview (read-only)
    so the two paths can never drift. Raises dag.PinRejected on a non-pinnable
    node (the caller maps it to 422).
    """
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
        calc = _calculated_unpinned(inputs_d, assumptions_d, demand_d, trade_d)
        overrides_d = _apply_override_ops(overrides_d, body.overrides, calc)
    name = body.name if body.name is not None else row["name"]
    return inputs_d, assumptions_d, demand_d, trade_d, overrides_d, name


def _diff_changed(before: dict, after: dict) -> list[dict]:
    """Build the changed[] list of {label, was, now, sign} for the decision metrics.

    Both before/after are subsets of the view-model metrics; we compare display
    strings and derive a direction sign from the raw values.
    """
    out: list[dict[str, str]] = []
    for key, label in (("capital", "Capital required"),
                       ("cashGap", "First-year cash gap"),
                       ("breakeven", "Break-even month")):
        b = before.get(key) or {}
        a = after.get(key) or {}
        if b.get("display") == a.get("display"):
            continue
        b_raw, a_raw = b.get("raw"), a.get("raw")
        sign = "flat"
        if isinstance(b_raw, (int, float)) and isinstance(a_raw, (int, float)):
            sign = "up" if a_raw > b_raw else "down" if a_raw < b_raw else "flat"
        out.append({"label": label, "was": str(b.get("display") or ""),
                    "now": str(a.get("display") or ""), "sign": sign})
    # N11: route through the ONE shared was->now formatter so /preview changed[]
    # and the narrative stale_diff never drift in shape.
    return format_was_now(out)


def _metrics_subset(vm: dict) -> dict:
    """The three decision metrics as {key: {raw, display}} for before/after."""
    m = vm.get("metrics") or {}
    return {k: m.get(k) for k in ("capital", "cashGap", "breakeven") if k in m}


# -------------------------------------------------------------------- endpoints
@router.post("", status_code=201)
def create_projection(
    body: CreateProjectionIn,
    request: Request,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Create: compute server-side, persist, return the view-model + one-time tokens.

    If a valid owner bearer token is presented the projection joins that workspace;
    otherwise a new owner token is minted and returned exactly once.
    """
    # §10.1: create is unauthenticated and mints tokens + runs the engine + a durable
    # write on every call, so cap it per-IP BEFORE any compute/insert (#164).
    limited = _rate_limited(
        "create_projection", request,
        ip_limit=_CREATE_IP_LIMIT, window_seconds=_CREATE_WINDOW_SECONDS,
    )
    if limited is not None:
        return limited
    try:
        vm = _compute_view_model(body)
    except (ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise HTTPException(
            status_code=422, detail={"error": "invalid_inputs", "message": str(exc)}
        ) from exc
    _enrich_view_model(vm, body.location.model_dump(), body.trade_area.model_dump())

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

    inputs_dump = body.inputs.model_dump()
    row = {
        "id": pid,
        "view_slug": view_slug,
        "owner_token_hash": owner_hash,
        "edit_token_hash": hash_token(edit_token),
        "name": name,
        "model_version": vm.get("model_version", ""),
        "compute_schema_version": vm.get("compute_schema_version", ""),
        "location_json": json.dumps(body.location.model_dump(exclude_none=True)),
        "trade_area_json": json.dumps(body.trade_area.model_dump()),
        "inputs_json": json.dumps(inputs_dump),
        "demand_drivers_json": json.dumps(body.demand or {}),
        "assumptions_json": json.dumps(body.assumptions.model_dump() if body.assumptions else {}),
        "overrides_json": json.dumps(body.overrides or {}),
        "computed_json": json.dumps(vm),
        # Server-checked terms gate (PRD §21): stamp acceptance now when the operator
        # actively accepted; NULL otherwise so exports correctly 403 terms_required.
        "terms_accepted_at": now if body.terms_accepted else None,
        "created_at": now,
        "updated_at": now,
        **_schedule_columns(inputs_dump),
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
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Owner-scoped list (never global). No/invalid token -> empty list."""
    owner = _bearer(authorization)
    if owner is None:
        return {"projections": []}
    # #178: read the small denormalized card columns (summary_json) only — the store
    # never SELECTs or parses the full ~10KB computed_json per row for the owner list.
    rows = store.list_card_summaries(hash_token(owner))
    items = []
    for r in rows:
        try:
            summary = json.loads(r.get("summary_json") or "{}")
        except json.JSONDecodeError:
            summary = {}
        items.append({
            "view_slug": r["view_slug"],
            "name": r["name"],
            "status": r.get("status") or "active",
            "version": r["version"],
            "updated_at": r["updated_at"],
            # card fields denormalized at write time (build_card_summary)
            "location": summary.get("location", ""),
            "basis": summary.get("basis", ""),
            "y1_revenue": summary.get("y1_revenue") or {"raw": 0, "display": "—"},
            "y1_net": summary.get("y1_net") or {"raw": 0, "display": "—"},
            "capital_required": summary.get("capital_required")
                                or {"raw": 0, "display": "—"},
            "reco_tag": summary.get("reco_tag") or "revise",
            # lat/lng for the list-row mini-map; null when location was never resolved.
            "coords": summary.get("coords"),
        })
    return {"projections": items}


@router.get("/{view_slug}")
def get_projection(view_slug: str, response: Response, store: Store = Depends(get_store)):  # noqa: B008  FastAPI dependency default (accepted pattern)
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


@router.get("/{view_slug}/staticmap")
def static_map(
    view_slug: str,
    request: Request,
    size: str = "thumb",
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
):
    """Server-proxied Google Static Map for the projection's resolved location.

    The Places key is appended server-side and never reaches the browser (hard
    rule 7). 404 when the projection has no resolved lat/lng so the client shows a
    neutral placeholder instead of a broken image (never a map over a typed count).
    """
    # §10/#168: the slug alone reaches this billed-Google proxy; cap per IP first.
    limited = _rate_limited(
        "export_staticmap", request,
        ip_limit=_STATICMAP_IP_LIMIT, window_seconds=_STATICMAP_WINDOW_SECONDS,
    )
    if limited is not None:
        return limited
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        loc = json.loads(row.get("location_json") or "{}")
    except json.JSONDecodeError:
        loc = {}
    lat, lng = loc.get("lat"), loc.get("lng")
    if lat is None or lng is None:
        raise HTTPException(status_code=404, detail={"error": "no_location"})
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        # Unparseable stored coords -> treat as no resolved location (never a 500).
        raise HTTPException(status_code=404, detail={"error": "no_location"}) from None
    kind = "detail" if size == "detail" else "thumb"
    try:
        img = static_map_bytes(lat_f, lng_f, kind)
    except GeoUpstreamError:
        raise HTTPException(status_code=502, detail={"error": "map_unavailable"}) from None
    return Response(
        content=img,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/{view_slug}/xlsx")
def export_xlsx(
    view_slug: str,
    request: Request,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Formula-driven .xlsx export (API_SPEC §6.3).

    Owner/edit/view may download (the slug already grants read). Terms acceptance
    is required first (§21) -> 403 terms_required. The workbook is rendered from
    the SAME resolved node values as computed_json (one math surface): blue inputs,
    live formulas, orange overrides + audit comment, guarded IF divisions, monthly
    tab. Written to a server-controlled temp file, streamed, then deleted.
    """
    # §10/#168: an uncached workbook rebuild on every call, reachable with just the
    # public slug -> cap per IP (and per token when a bearer is presented) FIRST.
    _xlsx_token = _bearer(authorization)
    limited = _rate_limited(
        "export_xlsx", request,
        ip_limit=_EXPORT_IP_LIMIT,
        token=hash_token(_xlsx_token) if _xlsx_token else None,
        token_limit=_EXPORT_TOKEN_LIMIT, window_seconds=_EXPORT_WINDOW_SECONDS,
    )
    if limited is not None:
        return limited

    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    if not row.get("terms_accepted_at"):
        raise HTTPException(status_code=403, detail={"error": "terms_required"})

    result = _compute_result_from_dicts(
        json.loads(row["inputs_json"] or "{}"),
        json.loads(row["assumptions_json"] or "{}"),
        json.loads(row["demand_drivers_json"] or "{}"),
        json.loads(row["trade_area_json"] or "{}"),
        json.loads(row["overrides_json"] or "{}"),
    )

    fd, path = tempfile.mkstemp(suffix=".xlsx", prefix="projection-")
    os.close(fd)
    # Stamp the export with the terms version + acceptance date (#192): the
    # "planning estimates, not advice" caveat travels into the workbook itself.
    build_xlsx(result, path, terms_accepted_at=row.get("terms_accepted_at"))

    stem = _safe_filename_stem(row.get("name") or "")
    filename = f"{stem} 3-Year Projection.xlsx"
    return FileResponse(
        path,
        media_type=XLSX_CONTENT_TYPE,
        filename=filename,
        background=BackgroundTask(lambda: os.remove(path) if os.path.exists(path) else None),
    )


# ============================================================ M5: narrative
# The narrative is the primary trust surface (API_SPEC §6.1, SECURITY.md §5/§6.3).
# Three HARD server-side invariants live here: (1) body_md is allowlist-sanitized
# before storage, (2) every figure in regenerated prose must exist in computed_json
# or generation is REJECTED, never overwriting the prior narrative, (3) staleness is
# a stored-hash vs live-hash compare and NEVER auto-overwrites user-edited prose.


def _ai_disabled(row: dict) -> bool:
    """AI opt-out (§21): per-projection flag OR deployment-wide AI kill switch.

    With AI disabled, regenerate -> 409 ai_disabled; compute/save/.xlsx are
    untouched (verified by test running the full flow with AI keys unset).
    """
    if int(row.get("ai_opt_out") or 0):
        return True
    return os.environ.get("AI_DISABLED", "").lower() in ("1", "true", "yes")


def _generate_narrative_md(vm: dict[str, Any], role: Optional[str] = None) -> str:
    """Low-temperature, grounded Board-Packet prose drawn from computed_json.

    Every figure inserted here is copied verbatim from a computed_json display
    string, so the output is grounded BY CONSTRUCTION — the validator that runs
    after generation is a hard backstop, not the only line of defense (a future
    LLM provider swaps in here behind the SAME post-generation grounding gate).
    Rent and other estimates are stated as estimates, never as facts.
    """
    metrics = vm.get("metrics") or {}
    reco = vm.get("reco") or {}
    cap = (metrics.get("capital") or {}).get("display", "")
    gap = (metrics.get("cashGap") or {}).get("display", "")
    be = (metrics.get("breakeven") or {}).get("display", "")
    headline = reco.get("headline", "")
    parts = [f"<p><strong>{headline}</strong></p>"]
    sentence = "<p>The plan requires "
    if cap:
        sentence += f"{cap} in startup capital"
    if be:
        sentence += f" and reaches break-even at {be}" if cap else f"Break-even is reached at {be}"
    sentence += ".</p>"
    parts.append(sentence)
    if gap:
        parts.append(f"<p>The most-negative first-year cash position is {gap}; "
                     "estimated figures (e.g. market rent) are planning ranges, "
                     "not quotes.</p>")
    return "".join(parts)


def _narrative_response(row: dict, store: Store) -> dict:
    """Assemble the GET narrative payload: stored prose + staleness + ai flag."""
    try:
        live_vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        live_vm = {}
    nar = store.get_narrative(row["id"]) or {}
    body_md = nar.get("body_md") or ""
    stored_hash = nar.get("computed_hash")
    live_hash = compute_hash(live_vm)
    stale = bool(body_md) and stored_hash is not None and stored_hash != live_hash
    diff: list[dict[str, str]] = []
    if stale and nar.get("snapshot_json"):
        try:
            diff = stale_diff(json.loads(nar["snapshot_json"]), live_vm)
        except (json.JSONDecodeError, TypeError):
            diff = []
    return {
        "body_md": body_md,
        "edited": bool(nar.get("edited")),
        "edit_origin": nar.get("edit_origin"),
        "computed_hash": stored_hash,
        "stale": stale,
        "stale_diff": diff,
        # N3: the server-built canonical grounded-figure list + display variants,
        # so the client never re-derives figures with a regex (API_SPEC §6.1).
        "grounded_figures": canonical_grounded_figures(live_vm),
        "ai_disabled": _ai_disabled(row),
        "updated_at": nar.get("updated_at"),
    }


@router.get("/{view_slug}/narrative")
def get_narrative(view_slug: str, store: Store = Depends(get_store)):  # noqa: B008  FastAPI dependency default (accepted pattern)
    """Fetch the stored narrative + staleness (owner/edit/view — the slug grants read)."""
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return _narrative_response(row, store)


class NarrativeIn(BaseModel):
    body_md: str = Field(default="")


@router.put("/{view_slug}/narrative")
def put_narrative(
    view_slug: str,
    body: NarrativeIn,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Save user-edited prose. body_md is allowlist-sanitized BEFORE storage.

    Sanitization is the stored-XSS -> localStorage-token-theft defense
    (SECURITY.md §5). Owner/edit only; view-only is 403.
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    token = _bearer(authorization)
    if not (_is_owner(token, row) or _is_editor(token, row)):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    clean = sanitize_body_md(body.body_md)
    try:
        live_vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        live_vm = {}
    # N4: numeric grounding is FAIL-CLOSED even for a HUMAN edit — an ungrounded
    # figure rejects the save and leaves the prior narrative untouched (the board
    # packet must never carry a hand-typed hallucinated figure, SECURITY §6.3).
    try:
        validate_grounding(clean, live_vm)
    except GroundingError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "grounding_failed",
            "ungrounded_figures": exc.ungrounded,
        }) from exc
    store.upsert_narrative(row["id"], {
        "body_md": clean,
        "edited": 1,
        "edit_origin": "human",
        "computed_hash": compute_hash(live_vm),
        "snapshot_json": json.dumps(live_vm),
        "provider": None,
        "model_version": live_vm.get("model_version"),
    })
    return {"body_md": clean, "edited": True, "edit_origin": "human",
            "computed_hash": compute_hash(live_vm)}


@router.post("/{view_slug}/narrative:regenerate")
def regenerate_narrative(
    view_slug: str,
    confirm: bool = False,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Regenerate grounded prose from current computed_json (owner/edit only).

    N6: provider is Anthropic primary -> OpenAI fallback; the response ``provider``
    field reflects the ACTUAL provider used. Both providers failing -> 503
    ai_unavailable (compute/save/.xlsx remain untouched, §21). AI opt-out -> 409
    ai_disabled. The generated prose passes the HARD numeric-grounding validator
    before storage; a hallucinated figure -> 409 grounding_failed and the prior
    narrative is NOT overwritten. A user-edited narrative is NEVER silently
    discarded: regenerating over ``edit_origin == 'human'`` without ``?confirm=true``
    -> 409 edited_confirm_required (confirm-before-discard gate).
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    token = _bearer(authorization)
    if not (_is_owner(token, row) or _is_editor(token, row)):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})
    if _ai_disabled(row):
        raise HTTPException(status_code=409, detail={"error": "ai_disabled"})

    try:
        live_vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        live_vm = {}

    # Provider failover (Anthropic -> OpenAI). The local grounded builder is the
    # generator seam (also the patch point for the grounding-rejection test).
    try:
        draft, provider = narrative_provider.generate(
            live_vm, generator=_generate_narrative_md)
    except narrative_provider.AIUnavailableError:
        raise HTTPException(status_code=503, detail={"error": "ai_unavailable"}) from None

    # Grounding is checked BEFORE the confirm gate: a failed generation has
    # nothing to discard, so a hallucinated figure is rejected regardless.
    try:
        validate_grounding(draft, live_vm)
    except GroundingError as exc:
        # HARD reject — prior narrative is NEVER overwritten.
        raise HTTPException(status_code=409, detail={
            "error": "grounding_failed",
            "ungrounded_figures": exc.ungrounded,
        }) from exc

    # Confirm-before-discard: never silently overwrite hand-edited prose.
    prior = store.get_narrative(row["id"]) or {}
    if prior.get("edit_origin") == "human" and not confirm:
        raise HTTPException(status_code=409, detail={
            "error": "edited_confirm_required"})

    clean = sanitize_body_md(draft)
    store.upsert_narrative(row["id"], {
        "body_md": clean,
        "edited": 0,
        "edit_origin": "ai",
        "computed_hash": compute_hash(live_vm),
        "snapshot_json": json.dumps(live_vm),
        "provider": provider,
        "model_version": live_vm.get("model_version"),
    })
    return {"body_md": clean, "edited": False, "edit_origin": "ai",
            "computed_hash": compute_hash(live_vm), "provider": provider}


@router.get("/{view_slug}/packet")
def export_packet(
    view_slug: str,
    request: Request,
    role: Optional[str] = None,
    format: str = "md",
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Board / Funder / Advisor packet (API_SPEC §6.4).

    Built ENTIRELY from the stored computed_json (one math/format surface): banner,
    verified-vs-estimated assumptions, sensitivity, provenance, KPIs. The grounded
    narrative is included only when AI is enabled (§21 opt-out keeps every
    structured/evidence section). Terms acceptance required (§21) -> 403 otherwise.
    The role flag tailors emphasis/CTAs only — never the numbers.
    """
    # §10/#168: an uncached packet render on every call, reachable with just the
    # public slug -> cap per IP (and per token when a bearer is presented) FIRST.
    _pkt_token = _bearer(authorization)
    limited = _rate_limited(
        "export_packet", request,
        ip_limit=_EXPORT_IP_LIMIT,
        token=hash_token(_pkt_token) if _pkt_token else None,
        token_limit=_EXPORT_TOKEN_LIMIT, window_seconds=_EXPORT_WINDOW_SECONDS,
    )
    if limited is not None:
        return limited

    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    if not row.get("terms_accepted_at"):
        raise HTTPException(status_code=403, detail={"error": "terms_required"})

    try:
        live_vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        live_vm = {}
    live_vm.setdefault("name", row.get("name") or "")

    # N11: the packet uses the CURRENT stored (possibly edited:true) sanitized
    # body_md verbatim — the board's last-edited prose. It is NOT dropped just
    # because it is stale (a stale narrative still carries the operator's words;
    # the staleness banner lives on the editing surface, not the export). Prose is
    # omitted ONLY when AI is disabled (§21) or no narrative is stored. The stored
    # body_md was already allowlist-sanitized at PUT/regenerate time.
    narrative_md = None
    if not _ai_disabled(row):
        nar = store.get_narrative(row["id"]) or {}
        narrative_md = (nar.get("body_md") or "") or None

    pkt = build_packet(live_vm, role=role or "board", narrative_md=narrative_md,
                       terms_accepted_at=row.get("terms_accepted_at"))

    stem = _safe_filename_stem(row.get("name") or "")
    if (format or "md").lower() == "docx":
        data = render_packet_docx(pkt)
        filename = f"{stem} Board Packet.docx"
        return Response(
            content=data,
            media_type=(
                "application/vnd.openxmlformats-officedocument."
                "wordprocessingml.document"),
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    md = render_packet_md(pkt)
    filename = f"{stem} Board Packet.md"
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def apply_projection_patch(
    *,
    row: dict,
    body: PatchProjectionIn,
    store: Store,
    token: Optional[str],
    if_match: int,
    actor: str = "user",
    change_summary: str = "autosave",
) -> tuple[dict[str, Any], int, str]:
    """The single server-authoritative mutation/recompute write path (API_SPEC §4.4).

    Shared by the manual autosave PATCH (``actor='user'``) AND the Penny tool loop
    (``actor='penny'``, Spec B §4/§6.2): there is NO parallel writer and NO
    privileged Penny path. Auth, override-DAG validation, cost-schedule validation,
    optimistic concurrency, recompute, and the one-revision-per-write audit are
    therefore IDENTICAL for an AI edit and a human edit — Penny carries intents
    through exactly the same wall the manual UI hits.

    Auth: requires the owner OR this projection's edit token; a view-only/absent
    token -> 403 forbidden. Raises HTTPException(403 forbidden | 422 node_not_pinnable
    | 422 invalid_inputs | 409 version_conflict) exactly as the manual PATCH does.
    Returns ``(view_model, new_version, name)`` and writes ONE revision tagged
    ``actor`` (DATA_MODEL §4: the revision ``actor`` enum — user | penny | …).
    """
    is_owner = token is not None and token_matches(token, row["owner_token_hash"])
    is_editor = (
        token is not None
        and bool(row.get("edit_token_hash"))
        and token_matches(token, row["edit_token_hash"])
    )
    if not (is_owner or is_editor):
        # view-only (no/invalid token) cannot mutate (SECURITY.md §2; API_SPEC §4.4).
        # A Penny mutate tool gates on capability first, but this is the real wall.
        raise HTTPException(status_code=403, detail={"error": "forbidden"})
    # is_owner/is_editor both imply a presented token (see checks above).
    assert token is not None

    # Merge the partial onto the stored source-of-truth, then recompute.
    try:
        inputs_d, assumptions_d, demand_d, trade_d, overrides_d, name = _merge_patch(
            row, body)
    except dag.PinRejected as exc:
        node = exc.node if hasattr(exc, "node") else None
        raise HTTPException(status_code=422, detail={
            "error": "node_not_pinnable", "node": node, "message": str(exc)}) from exc

    # Server-validates the merged schedule/anchor (PATCH inputs is a raw dict, so it
    # bypasses the InputsIn body validation that guards create).
    _validate_schedule_inputs(inputs_d)

    try:
        vm = _compute_view_model_from_dicts(inputs_d, assumptions_d, demand_d, trade_d, overrides_d)
    except (ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise HTTPException(
            status_code=422, detail={"error": "invalid_inputs", "message": str(exc)}
        ) from exc
    try:
        location_d = json.loads(row.get("location_json") or "{}")
    except json.JSONDecodeError:
        location_d = {}
    _enrich_view_model(vm, location_d, trade_d)

    patch = {
        "name": name,
        "inputs_json": json.dumps(inputs_d),
        "assumptions_json": json.dumps(assumptions_d),
        "demand_drivers_json": json.dumps(demand_d),
        "trade_area_json": json.dumps(trade_d),
        "overrides_json": json.dumps(overrides_d),
        "computed_json": json.dumps(vm),
        "model_version": vm.get("model_version", ""),
        **_schedule_columns(inputs_d),
    }
    affected = store.update_with_version_check(row["id"], if_match, patch)
    if affected == 0:
        current = store.get_projection_by_slug(row["view_slug"])
        try:
            cur_vm = json.loads(current["computed_json"] or "{}") if current else {}
        except json.JSONDecodeError:
            cur_vm = {}
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict",
            "current_version": current["version"] if current else None,
            "your_version": if_match,
            "current_state": {**cur_vm, "view_slug": row["view_slug"],
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
        "actor": actor,
        "change_summary": change_summary,
        "created_at": _utcnow(),
    })
    return vm, new_version, name


@router.patch("/{view_slug}")
def patch_projection(
    view_slug: str,
    body: PatchProjectionIn,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Autosave (API_SPEC §4.4): merge patch -> recompute server-side -> persist.

    Requires Authorization: Bearer (owner OR this projection's edit token) and
    If-Match: <version>. Optimistic concurrency: a stale version writes 0 rows and
    returns HTTP 409 with the current server state. One revision snapshot per settle.
    The merge/recompute/persist/audit body lives in :func:`apply_projection_patch`
    so the Penny tool loop converges on the exact same write path (actor:penny).
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    vm, new_version, name = apply_projection_patch(
        row=row, body=body, store=store, token=token, if_match=if_match)
    response.headers["ETag"] = str(new_version)
    return {**vm, "view_slug": view_slug, "version": new_version, "name": name}


@router.post("/{view_slug}/preview")
def preview_projection(
    view_slug: str,
    body: PatchProjectionIn,
    request: Request,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Dry-run /preview (epic-N N1): merge -> recompute -> diff, READ-ONLY.

    Bearer owner/edit, NO If-Match. It MUST NOT persist, MUST NOT bump version, and
    MUST NOT write a revision — it only recomputes the merged editable surface in
    memory and returns {before, after, changed[], reco_before, reco_after}. Same
    422 rejections as PATCH (invalid input, non-pinnable node). Rate-limited on the
    read bucket (it backs a debounced "what-if" surface). The provable read-only
    invariant is a CI gate (test_ai_safety / test_projections_preview).
    """
    row = store.get_projection_by_slug(view_slug)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    token = _bearer(authorization)
    if not (_is_owner(token, row) or _is_editor(token, row)):
        # view-only (no/invalid token) cannot preview (SECURITY.md §2).
        raise HTTPException(status_code=403, detail={"error": "forbidden"})

    allowed, retry_after = ratelimit.check(
        "preview",
        ip=_client_ip(request),
        token=hash_token(token) if token else None,
        ip_limit=_PREVIEW_IP_LIMIT,
        token_limit=_PREVIEW_TOKEN_LIMIT,
        window_seconds=_PREVIEW_WINDOW_SECONDS,
    )
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited",
                     "retry_after_seconds": retry_after, "scope": "ip"},
            headers={"Retry-After": str(retry_after)},
        )

    # BEFORE = the stored snapshot verbatim (no recompute on the unchanged state).
    try:
        before_vm = json.loads(row.get("computed_json") or "{}")
    except json.JSONDecodeError:
        before_vm = {}

    # AFTER = recompute on the merged partial. NOTHING is written.
    try:
        inputs_d, assumptions_d, demand_d, trade_d, overrides_d, _name = _merge_patch(
            row, body)
    except dag.PinRejected as exc:
        node = exc.node if hasattr(exc, "node") else None
        raise HTTPException(status_code=422, detail={
            "error": "node_not_pinnable", "node": node, "message": str(exc)}) from exc

    try:
        after_vm = _compute_view_model_from_dicts(
            inputs_d, assumptions_d, demand_d, trade_d, overrides_d)
    except (ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_inputs", "message": str(exc)}) from exc

    before = _metrics_subset(before_vm)
    after = _metrics_subset(after_vm)
    return {
        "before": before,
        "after": after,
        "changed": _diff_changed(before, after),
        "reco_before": before_vm.get("reco") or {},
        "reco_after": after_vm.get("reco") or {},
    }


# ---------------------------------------------------- rotate / share (owner-only)
@router.post("/{view_slug}/rotate-tokens")
def rotate_tokens(
    view_slug: str,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Rotate owner/edit/view_slug + every role link in ONE transaction (API_SPEC §4.7).

    Owner-only. Immediately invalidates every previously-shared link (compromise
    response, SECURITY.md §3): the old owner/edit tokens and the old view_slug all
    die at once. Writes a rotation event to the audit/revision log. The new secrets
    are returned exactly once (never re-derivable from the server).
    """
    row = _require_owner(store, view_slug, authorization)

    new_owner = secrets.token_urlsafe(32)   # ~256-bit
    new_edit = secrets.token_urlsafe(32)
    new_slug = secrets.token_urlsafe(16)    # ~128-bit

    # Re-mint role links keeping role NAMES, replacing slugs/hashes (atomic).
    try:
        old_roles = json.loads(row.get("role_tokens_json") or "{}")
    except json.JSONDecodeError:
        old_roles = {}
    new_role_secrets: dict[str, str] = {}
    new_role_map: dict[str, str] = {}
    for _old_slug, role_name in old_roles.items():
        rs = secrets.token_urlsafe(16)
        new_role_map[rs] = role_name
        new_role_secrets[role_name] = rs

    new_hashes = {
        "owner_token_hash": hash_token(new_owner),
        "edit_token_hash": hash_token(new_edit),
        "view_slug": new_slug,
        "role_tokens_json": json.dumps(new_role_map),
    }
    affected = store.rotate_tokens(row["id"], if_match, new_hashes)
    if affected == 0:
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict", "your_version": if_match,
            "recovery": "reload | overwrite | save_as_copy"})

    new_version = if_match + 1
    store.insert_revision({
        "id": _new_id(),
        "projection_id": row["id"],
        "seq": new_version,
        "inputs_json": row.get("inputs_json") or "{}",
        "assumptions_json": row.get("assumptions_json") or "{}",
        "overrides_json": row.get("overrides_json") or "{}",
        "monthly_json": row.get("monthly_json") or "{}",
        "computed_json": row.get("computed_json") or "{}",
        "model_version": row.get("model_version") or "",
        "actor_token_hash": hash_token(new_owner),
        "change_summary": "tokens_rotated",
        "created_at": _utcnow(),
    })
    response.headers["ETag"] = str(new_version)
    return {
        "view_slug": new_slug,
        "version": new_version,
        "tokens": {
            "owner_token": new_owner,
            "edit_token": new_edit,
            "view_slug": new_slug,
            "roles": new_role_secrets,
        },
    }


# --------------------------------------------------------- revisions (owner-only)
@router.get("/{view_slug}/revisions")
def list_revisions(
    view_slug: str,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
):
    """Owner-scoped revision history (API_SPEC §5.1).

    Metadata + change_summary only — snapshot bodies are not inlined. Edit/view
    tokens cannot browse history (owner_required).
    """
    row = _require_owner(store, view_slug, authorization)
    revs = store.list_revisions(row["id"])
    return {"revisions": [
        {
            "id": r["id"],
            "version": r["seq"],
            "change_summary": r.get("change_summary", ""),
            "actor": "owner",
            "event": _revision_event(r.get("change_summary", "")),
            "created_at": r["created_at"],
        }
        for r in revs
    ]}


@router.post("/{view_slug}/revisions/{revision_id}/restore")
def restore_revision(
    view_slug: str,
    revision_id: str,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Restore a snapshot as a NEW forward revision (API_SPEC §5.2).

    Owner-only. Appends rather than rewinds history: the snapshot's
    inputs/assumptions/overrides are recomputed and persisted at the next version.
    """
    row = _require_owner(store, view_slug, authorization)
    rev = store.get_revision(revision_id)
    if rev is None or rev["projection_id"] != row["id"]:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    inputs_d = json.loads(rev["inputs_json"] or "{}")
    assumptions_d = json.loads(rev["assumptions_json"] or "{}")
    overrides_d = json.loads(rev["overrides_json"] or "{}")
    demand_d = json.loads(row["demand_drivers_json"] or "{}")
    trade_d = json.loads(row["trade_area_json"] or "{}")

    try:
        vm = _compute_view_model_from_dicts(
            inputs_d, assumptions_d, demand_d, trade_d, overrides_d)
    except (ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_inputs", "message": str(exc)}) from exc

    patch = {
        "inputs_json": json.dumps(inputs_d),
        "assumptions_json": json.dumps(assumptions_d),
        "overrides_json": json.dumps(overrides_d),
        "computed_json": json.dumps(vm),
        "model_version": vm.get("model_version", ""),
        # keep the denormalized schedule/anchor columns consistent with the
        # restored inputs_json (the canonical copy).
        **_schedule_columns(inputs_d),
    }
    affected = store.update_with_version_check(row["id"], if_match, patch)
    if affected == 0:
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict", "your_version": if_match,
            "recovery": "reload | overwrite | save_as_copy"})

    new_version = if_match + 1
    token = _bearer(authorization)
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
        "actor_token_hash": hash_token(token) if token else None,
        "change_summary": f"restore from v{rev['seq']}",
        "created_at": _utcnow(),
    })
    response.headers["ETag"] = str(new_version)
    return {**vm, "view_slug": view_slug, "version": new_version, "name": row["name"]}


# ------------------------------------------------- trash lifecycle (owner-only)
def _set_status_or_conflict(store, row, if_match, status):
    affected = store.set_status(row["id"], status, if_match)
    if affected == 0:
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict", "your_version": if_match,
            "recovery": "reload | overwrite | save_as_copy"})


@router.post("/{view_slug}/trash")
def trash_projection(
    view_slug: str,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Soft delete (API_SPEC §4.8): status -> trashed. Owner-only, If-Match required."""
    row = _require_owner(store, view_slug, authorization)
    _set_status_or_conflict(store, row, if_match, "trashed")
    current = store.get_projection_by_slug(view_slug)
    try:
        vm = json.loads(current["computed_json"] or "{}") if current else {}
    except json.JSONDecodeError:
        vm = {}
    new_version = if_match + 1
    response.headers["ETag"] = str(new_version)
    return {**vm, "view_slug": view_slug, "version": new_version,
            "name": row["name"], "status": "trashed"}


@router.post("/{view_slug}/restore")
def restore_projection(
    view_slug: str,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Restore from trash (API_SPEC §4.8): status -> active. Owner-only."""
    row = _require_owner(store, view_slug, authorization)
    _set_status_or_conflict(store, row, if_match, "active")
    current = store.get_projection_by_slug(view_slug)
    try:
        vm = json.loads(current["computed_json"] or "{}") if current else {}
    except json.JSONDecodeError:
        vm = {}
    new_version = if_match + 1
    response.headers["ETag"] = str(new_version)
    return {**vm, "view_slug": view_slug, "version": new_version,
            "name": row["name"], "status": "active"}


@router.delete("/{view_slug}", status_code=204)
def delete_projection(
    view_slug: str,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
    authorization: Optional[str] = Header(default=None),
    if_match: int = Depends(parse_if_match),
):
    """Hard delete / purge (API_SPEC §4.8). Owner-only; permitted ONLY when the
    projection is already trashed (else 409 not_trashed). Irreversible: hard-DELETEs
    the projection AND cascades to every child it owns (revisions, narratives,
    evidence, penny_transcripts, actuals, role links) so the confidential financials
    and Penny conversation are actually ERASED, not merely hidden (#202, DATA_MODEL
    §5.4)."""
    row = _require_owner(store, view_slug, authorization)
    if row.get("status") != "trashed":
        raise HTTPException(status_code=409, detail={"error": "not_trashed"})
    affected = store.purge_projection(row["id"], if_match)
    if affected == 0:
        raise HTTPException(status_code=409, detail={
            "error": "version_conflict", "your_version": if_match,
            "recovery": "reload | overwrite | save_as_copy"})
    return Response(status_code=204)


def _revision_event(summary: str) -> str:
    """Map a change_summary -> the revision event enum (API_SPEC §5.1)."""
    if "rotate" in summary:
        return "rotate"
    if summary.startswith("restore"):
        return "restore"
    if "override" in summary or "pin" in summary:
        return "override"
    if "upgrade" in summary:
        return "upgrade_model"
    return "edit"

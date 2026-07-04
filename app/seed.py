"""app/seed.py — deterministic `example` projection for the E2E gate.

The Playwright flows (e2e/) drive a fixed projection so the gate is reproducible
across machines: view_slug `example`, edit token `edit-secret` (the URL fragment
the override-conflict / feedback specs read), terms accepted (so .xlsx export is
reachable read-only), and a board role link `board-slug` (the readonly-share
spec's /r/ path). This is e2e/demo scaffolding — NOT a production data path; it
runs only when E2E_SEED=1 (or explicitly in tests).

It uses the SAME pure engine + persisted Appendix-D view-model as a real create,
so the seeded numbers are the engine's, not a fixture's (single math authority).
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any

from app.deps import hash_token
from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.viewmodel import to_view_model

EXAMPLE_SLUG = "example"
EXAMPLE_EDIT_TOKEN = "edit-secret"
EXAMPLE_OWNER_TOKEN = "owner-secret"
ROLE_SLUG = "board-slug"
ROLE_NAME = "board"

# Design-parity (40% labor) House of Hope — the Appendix-D headline the prototype
# screenshots use (reco=proceed, capital ~ $278k, break-even ~month 5).
_INPUTS: dict[str, Any] = dict(
    org_name="House of Hope",
    city="Longview, Texas",
    opening_status="pre_launch",
    share_y1="0.06",
    share_y2="0.08",
    share_y3="0.10",
    share_y4="0.11",
    share_y5="0.12",
    donation_value="74",
    building_sqft="10000",
    salesfloor_pct="0.70",
    occupancy_annual="120000",
    lease_type="nnn",
    source_of_funds="300000",
)
_ASSUMPTIONS = dict(labor_pct="0.40")
# Census provenance + a resolved location for the demo, so the example shows the
# trade-area map and the evidence/confidence panel (not just a placeholder).
_TRADE = dict(
    basis="city", households="31798",
    geography_name="Longview city", geography_fips="4843012",
    acs_vintage="2022", households_source="census_acs", moe=412,
)
_LOCATION = dict(
    place_id="seed-longview-tx", lat=32.5007, lng=-94.7405,
    formatted_address="Longview, TX, USA",
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def example_view_model() -> dict:
    from app.routers.projections import _enrich_view_model

    inputs = Inputs(**_INPUTS)
    akw: dict[str, Any] = {k: v for k, v in _ASSUMPTIONS.items() if v is not None}
    acs_vintage = _TRADE.get("acs_vintage")
    result = compute(
        inputs, Assumptions(**akw), DemandDrivers(),
        # The engine takes only basis/households/acs_vintage; provenance is metadata.
        TradeArea(basis=str(_TRADE["basis"]), households=str(_TRADE["households"]),
                  acs_vintage=str(acs_vintage) if acs_vintage is not None else None),
        overrides={},
    )
    vm = result.view_model or to_view_model(result)
    _enrich_view_model(vm, _LOCATION, _TRADE)
    return vm


def seed_example(store) -> None:
    """Insert (idempotently) the fixed `example` projection used by e2e."""
    if store.get_projection_by_slug(EXAMPLE_SLUG) is not None:
        return
    vm = example_view_model()
    now = _utcnow()
    # Plain json.dumps (not dumps_finite) throughout this row is intentional, not an
    # oversight (batch3-review finding A / Minor 1): every value here is either a
    # static seed constant (_LOCATION/_TRADE/_INPUTS/_ASSUMPTIONS, hand-authored, no
    # floats that could be non-finite) or `vm`, the engine's own view-model, which
    # always emits explicit `null` — never NaN/Infinity (PRD §12.4) — and this whole
    # path only runs under the non-prod E2E_SEED gate, never a real user PATCH.
    row = {
        "id": "seed-example-" + secrets.token_hex(4),
        "view_slug": EXAMPLE_SLUG,
        "owner_token_hash": hash_token(EXAMPLE_OWNER_TOKEN),
        "edit_token_hash": hash_token(EXAMPLE_EDIT_TOKEN),
        "role_tokens_json": json.dumps({ROLE_SLUG: ROLE_NAME}),
        "name": "House of Hope",
        "model_version": vm.get("model_version", ""),
        "compute_schema_version": vm.get("compute_schema_version", ""),
        "location_json": json.dumps(_LOCATION),
        "trade_area_json": json.dumps(_TRADE),
        "inputs_json": json.dumps(_INPUTS),
        "demand_drivers_json": json.dumps({}),
        "assumptions_json": json.dumps(_ASSUMPTIONS),
        "overrides_json": json.dumps({}),
        "computed_json": json.dumps(vm),
        "terms_accepted_at": now,  # export reachable read-only in the demo
        "created_at": now,
        "updated_at": now,
    }
    store.create_projection(row)


def reset_example(store) -> bool:
    """Reset the seeded `example` projection to its canonical state (E2E only).

    The stateful override/409 flow mutates `example` (labor, name, version). With
    a single in-memory DB shared by all three viewport projects, that state leaks
    across tests and makes the gate order-dependent. A per-test reset restores the
    canonical content (labor 0.4, name "House of Hope", overrides cleared) so each
    flow starts from a known fixture. Content is reset via the normal version-check
    UPDATE; the version may advance (the specs read the live version on load and
    never assume a literal starting number).

    Returns True if the row was reset, False if it was missing (seeds it instead).
    """
    row = store.get_projection_by_slug(EXAMPLE_SLUG)
    if row is None:
        seed_example(store)
        return False
    vm = example_view_model()
    # Plain json.dumps exemption: same reasoning as seed_example() above (static seed
    # constants + the engine's own null-not-NaN vm, non-prod E2E gate only).
    patch = {
        "name": "House of Hope",
        "inputs_json": json.dumps(_INPUTS),
        "assumptions_json": json.dumps(_ASSUMPTIONS),
        "demand_drivers_json": json.dumps({}),
        "trade_area_json": json.dumps(_TRADE),
        "overrides_json": json.dumps({}),
        "computed_json": json.dumps(vm),
        "model_version": vm.get("model_version", ""),
    }
    store.update_with_version_check(row["id"], row["version"], patch)
    return True

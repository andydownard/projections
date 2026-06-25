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
_INPUTS = dict(
    org_name="House of Hope",
    city="Longview, Texas",
    opening_status="pre_launch",
    share_y1="0.06",
    share_y2="0.08",
    share_y3="0.10",
    donation_value="74",
    building_sqft="10000",
    salesfloor_pct="0.70",
    occupancy_annual="120000",
    lease_type="nnn",
    source_of_funds="300000",
)
_ASSUMPTIONS = dict(labor_pct="0.40")
_TRADE = dict(basis="city", households="31798")


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def example_view_model() -> dict:
    inputs = Inputs(**_INPUTS)
    akw = {k: v for k, v in _ASSUMPTIONS.items() if v is not None}
    result = compute(
        inputs, Assumptions(**akw), DemandDrivers(),
        TradeArea(**_TRADE), overrides={},
    )
    return result.view_model or to_view_model(result)


def seed_example(store) -> None:
    """Insert (idempotently) the fixed `example` projection used by e2e."""
    if store.get_projection_by_slug(EXAMPLE_SLUG) is not None:
        return
    vm = example_view_model()
    now = _utcnow()
    row = {
        "id": "seed-example-" + secrets.token_hex(4),
        "view_slug": EXAMPLE_SLUG,
        "owner_token_hash": hash_token(EXAMPLE_OWNER_TOKEN),
        "edit_token_hash": hash_token(EXAMPLE_EDIT_TOKEN),
        "role_tokens_json": json.dumps({ROLE_SLUG: ROLE_NAME}),
        "name": "House of Hope",
        "model_version": vm.get("model_version", ""),
        "compute_schema_version": vm.get("compute_schema_version", ""),
        "location_json": json.dumps({"query": "Longview, Texas"}),
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

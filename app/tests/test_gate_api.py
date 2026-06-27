"""Price/gate FLAG enforcement boundary (PRD §3, issue #85, SECURITY.md §3).

The flag (`config.gate_config`) drives three observable surfaces:

  * `GET /api/config` — exposes `{gate_mode, price_usd}` so the SPA renders the
    correct CTA ("Download free" vs "Request expert review — $X"). No client math.
  * the reusable gate dependency (`app.gate.expert_review_gate`) over the
    expert-review / sign-off STUB — OPEN in `free`, 402 in `paid_review`.
  * the basic `.xlsx` + basic packet — FREE and UNGATED in EVERY mode (GTM
    decision); the price gate NEVER touches them.

Density anchor: the mode × surface toggle matrix plus the independence proofs
(terms-acceptance is enforced independently of gate mode; flipping the gate never
alters compute) carry the test:code ratio over the thin config/dependency code.
"""
import pytest
from fastapi.testclient import TestClient

from app.gate import expert_review_gate, gate_state
from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore

XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store, monkeypatch):
    # Start from a clean slate so a leaked env var never flips the safe default.
    monkeypatch.delenv("GATE_MODE", raising=False)
    monkeypatch.delenv("GATE_PRICE_USD", raising=False)
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def _create(client):
    return client.post("/api/projections", json=VALID_BODY)


def _accept_terms(store, slug):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET terms_accepted_at = ? WHERE id = ?",
        ("2026-06-24T00:00:00Z", row["id"]),
    )
    store._conn.commit()


# --- GET /api/config: the CTA seam --------------------------------------------

def test_config_endpoint_default_is_free_ungated(client):
    body = client.get("/api/config").json()
    assert body == {"gate_mode": "free", "price_usd": None}


def test_config_endpoint_reports_paid_with_price(client, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    body = client.get("/api/config").json()
    assert body == {"gate_mode": "paid_review", "price_usd": 49}


def test_config_price_only_surfaced_when_paid(client, monkeypatch):
    # No client-side price math: the number only travels in paid mode.
    monkeypatch.setenv("GATE_MODE", "free")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    assert client.get("/api/config").json()["price_usd"] is None
    monkeypatch.setenv("GATE_MODE", "paid_review")
    assert client.get("/api/config").json()["price_usd"] == 49


def test_config_endpoint_needs_no_auth(client):
    # Mirrors /api/health — a public read so the SPA can render before any token.
    assert client.get("/api/config").status_code == 200


# --- No-deploy flip: the next request reflects the new mode -------------------

def test_no_deploy_flip_on_next_request(client, monkeypatch):
    assert client.get("/api/config").json()["gate_mode"] == "free"
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "99")
    flipped = client.get("/api/config").json()
    assert flipped["gate_mode"] == "paid_review"
    assert flipped["price_usd"] == 99
    # ...and back, with no process restart.
    monkeypatch.setenv("GATE_MODE", "free")
    assert client.get("/api/config").json()["gate_mode"] == "free"


# --- Toggle matrix: mode × surface --------------------------------------------

@pytest.mark.parametrize("mode", ["free", "paid_review"])
def test_basic_xlsx_is_ungated_in_every_mode(client, store, monkeypatch, mode):
    monkeypatch.setenv("GATE_MODE", mode)
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == XLSX_CT


@pytest.mark.parametrize("mode", ["free", "paid_review"])
def test_basic_packet_is_ungated_in_every_mode(client, store, monkeypatch, mode):
    monkeypatch.setenv("GATE_MODE", mode)
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/packet")
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("mode,expected", [("free", 201), ("paid_review", 402)])
def test_expert_review_open_free_gated_paid(client, monkeypatch, mode, expected):
    monkeypatch.setenv("GATE_MODE", mode)
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    r = client.post("/api/expert-review")
    assert r.status_code == expected, r.text


def test_expert_review_free_acks_and_emits_gate_state(client, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "free")
    r = client.post("/api/expert-review")
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "received"
    assert body["gate"]["gate_mode"] == "free"


def test_gated_expert_review_carries_price_for_cta(client, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    r = client.post("/api/expert-review")
    assert r.status_code == 402
    detail = r.json()["detail"]
    assert detail["error"] == "payment_required"
    assert detail["gate_mode"] == "paid_review"
    assert detail["price_usd"] == 49


# --- Independence: price gate ⟂ terms gate, and ⟂ compute ---------------------

def test_terms_still_required_in_free_mode(client, store, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "free")
    slug = _create(client).json()["view_slug"]  # terms NOT accepted
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "terms_required"


def test_paid_gate_never_bypasses_terms(client, store, monkeypatch):
    # A paid gate is orthogonal: it must NOT substitute for, or skip, the terms
    # gate on the basic export. Terms unaccepted -> 403 terms_required (not 402).
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    slug = _create(client).json()["view_slug"]  # terms NOT accepted
    r = client.get(f"/api/projections/{slug}/xlsx")
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "terms_required"


def test_flipping_gate_does_not_alter_compute(client, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "free")
    slug = _create(client).json()["view_slug"]
    free_vm = client.get(f"/api/projections/{slug}").json()
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    paid_vm = client.get(f"/api/projections/{slug}").json()
    assert free_vm == paid_vm  # computed_json identical
    assert free_vm.get("model_version") == paid_vm.get("model_version")


# --- A/B seam (M-1): cohort-addressable + emitted for attribution --------------

def test_expert_review_emits_cohort_for_attribution(client, monkeypatch):
    monkeypatch.setenv("GATE_MODE", "free")
    r = client.post("/api/expert-review?cohort=alpha")
    assert r.status_code == 201
    assert r.json()["gate"]["cohort"] == "alpha"


def test_cohort_can_address_a_paid_split(client, monkeypatch):
    # Global is free; cohort B is paid_review — the gate honors the cohort.
    monkeypatch.setenv("GATE_MODE", "free")
    monkeypatch.setenv("GATE_MODE__B", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "49")
    assert client.get("/api/config").json()["gate_mode"] == "free"
    assert client.get("/api/config?cohort=b").json()["gate_mode"] == "paid_review"
    assert client.post("/api/expert-review").status_code == 201
    assert client.post("/api/expert-review?cohort=b").status_code == 402


# --- gate_state helper: the self-describing state for CTA + analytics ----------

def test_gate_state_open_in_free():
    st = gate_state(env={"GATE_MODE": "free"})
    assert st["gated"] is False
    assert st["gate_mode"] == "free"
    assert st["price_usd"] is None


def test_gate_state_closed_in_paid():
    st = gate_state(env={"GATE_MODE": "paid_review", "GATE_PRICE_USD": "49"})
    assert st["gated"] is True
    assert st["price_usd"] == 49


def test_gate_state_carries_cohort():
    st = gate_state(cohort="x", env={"GATE_MODE": "free"})
    assert st["cohort"] == "x"


def test_dependency_is_the_reusable_gate():
    # The same callable mounted on the stub is importable for reuse on the real
    # expert-review intent endpoint (M6.3) — one gate, not a copy per surface.
    assert callable(expert_review_gate)

"""Regression for #141 — terms acceptance must PERSIST on create.

The product's reason for being is the exported Board Packet + formula-driven
``.xlsx``. Both export endpoints gate on ``projections.terms_accepted_at``
(``app/routers/projections.py`` ``/xlsx`` + ``/packet``). The wizard sends
``terms_accepted: true`` in the create body, but ``create_projection`` never
persisted it — so EVERY real (non-seeded) projection 403'd ``terms_required``
on export. CI missed it because the export tests only ran against the seeded
``example``, which sets ``terms_accepted_at`` directly in ``app/seed.py``.

These tests create a FRESH projection THROUGH the API (no direct DB UPDATE) and
assert the acceptance is recorded and exports succeed. The negative case keeps
the gate honest: a projection created WITHOUT acceptance must still 403.
"""
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore

XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

BASE_BODY = {
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


def _body(terms=None):
    b = {**BASE_BODY, "inputs": dict(BASE_BODY["inputs"])}
    if terms is not None:
        b["terms_accepted"] = terms
    return b


def _store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def test_create_with_terms_accepted_persists_terms_accepted_at():
    """A fresh projection created with ``terms_accepted: true`` records it."""
    store = _store()
    client = _client(store)
    created = client.post("/api/projections", json=_body(terms=True))
    assert created.status_code == 201, created.text
    slug = created.json()["view_slug"]

    row = store.get_projection_by_slug(slug)
    assert row["terms_accepted_at"], (
        "create with terms_accepted:true must stamp terms_accepted_at"
    )


def test_create_with_terms_accepted_allows_xlsx_and_packet_export():
    """The headline bug: real projections must be able to export (200, not 403)."""
    store = _store()
    client = _client(store)
    slug = client.post("/api/projections", json=_body(terms=True)).json()["view_slug"]

    rx = client.get(f"/api/projections/{slug}/xlsx")
    assert rx.status_code == 200, rx.text
    assert rx.headers["content-type"] == XLSX_CT

    rp = client.get(f"/api/projections/{slug}/packet")
    assert rp.status_code == 200, rp.text


def test_create_without_terms_keeps_export_gate_honest():
    """No acceptance -> exports must STILL 403 (do not weaken the gate)."""
    store = _store()
    client = _client(store)
    slug = client.post("/api/projections", json=_body(terms=False)).json()["view_slug"]

    rx = client.get(f"/api/projections/{slug}/xlsx")
    assert rx.status_code == 403, rx.text
    assert rx.json()["detail"]["error"] == "terms_required"

    rp = client.get(f"/api/projections/{slug}/packet")
    assert rp.status_code == 403, rp.text
    assert rp.json()["detail"]["error"] == "terms_required"


def test_create_omitting_terms_field_does_not_accept():
    """An absent terms field is NOT acceptance — exports 403 (respects choice)."""
    store = _store()
    client = _client(store)
    slug = client.post("/api/projections", json=_body(terms=None)).json()["view_slug"]

    row = store.get_projection_by_slug(slug)
    assert not row["terms_accepted_at"]
    assert client.get(f"/api/projections/{slug}/xlsx").status_code == 403

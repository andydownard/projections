"""Cash-flow CSV export — GET /api/projections/{view_slug}/cashflow.csv.

Mirrors the sibling .xlsx / packet view-slug export routes EXACTLY: same view-slug
read grant, same terms-acceptance gate (§21), same per-IP + per-token rate-limit legs
(§10.1). UNLIKE the .xlsx route (which recomputes the workbook), the CSV is served
from the STORED computed_json monthly[] VERBATIM — a read is never a recompute
(Regression #12). The CSV's audience is "sum a column in a spreadsheet", so the four
money columns are RAW SIGNED INTEGERS (e.g. -263269), never the ($263,269) display
string (parenthesized text imports as a text cell and breaks the sum).

RED-first: written before the endpoint exists.

Coverage:
  - happy path: text/csv content-type + attachment Content-Disposition; header row +
    60 data rows; the six spec columns; months grouped (Year 1 … Year 5); the four
    money columns are raw signed integers (a loss reads "-263269", never "($263,269)")
  - pre-opening labeling: a stored snapshot whose grand opening is month 3 labels
    months 1-2 "Pre-opening" and month 3 "Year 1"
  - terms gate: 403 terms_required when terms not accepted (identical to xlsx)
  - 404 for unknown slug
  - rate-limit BOTH legs: per-IP cap and per-token cap
  - legacy snapshot (a 12-row 2.6.0-era monthly, NO milestones) degrades gracefully
    (12 rows, no crash, G=1 fallback so months 1-12 are Year 1)
"""
import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

import app.routers.projections as P
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore

CSV_CT = "text/csv"

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


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def _create(client, body=None):
    return client.post("/api/projections", json=body or VALID_BODY)


def _accept_terms(store, slug):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET terms_accepted_at = ? WHERE id = ?",
        ("2026-06-24T00:00:00Z", row["id"]),
    )
    store._conn.commit()


def _set_computed_json(store, slug, computed):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET computed_json = ? WHERE id = ?",
        (json.dumps(computed), row["id"]),
    )
    store._conn.commit()


def _rows(resp):
    return list(csv.reader(io.StringIO(resp.text)))


def test_cashflow_csv_returns_csv_content_type_and_attachment(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith(CSV_CT)
    cd = r.headers.get("content-disposition", "")
    assert "attachment" in cd
    assert 'filename="House of Hope Cash Flow.csv"' in cd


def test_cashflow_csv_shape_header_plus_60_rows(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 200, r.text
    rows = _rows(r)
    assert rows[0] == ["Month", "Group", "Revenue", "Expenses", "Net", "Cumulative Cash"]
    data = [row for row in rows[1:] if row]
    assert len(data) == 60


def test_cashflow_csv_money_columns_are_raw_signed_integers(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    rows = _rows(r)
    first = rows[1]
    # Month 1 of House of Hope is a deep startup-loss month: net/cumulative are large
    # negatives that MUST render as a bare signed integer, never "($263,269)".
    assert first[0] == "1"
    net = first[4]
    assert net.lstrip("-").isdigit(), f"net not a bare integer: {net!r}"
    assert int(net) < 0
    assert "(" not in net and "$" not in net and "," not in net
    # Ties out to round(raw) of the stored monthly[0].net.
    row = store.get_projection_by_slug(slug)
    monthly = json.loads(row["computed_json"])["monthly"]
    assert int(net) == round(monthly[0]["net"]["raw"])


def test_cashflow_csv_groups_by_project_year(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    rows = _rows(r)
    data = [row for row in rows[1:] if row]
    # House of Hope opens month 1 -> no pre-opening; months 1-12 Year 1 ... 49-60 Year 5.
    by_month = {int(row[0]): row[1] for row in data}
    assert by_month[1] == "Year 1"
    assert by_month[12] == "Year 1"
    assert by_month[13] == "Year 2"
    assert by_month[60] == "Year 5"


def test_cashflow_csv_labels_pre_opening_months(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    # Craft a stored snapshot whose grand opening is month 3 so months 1-2 pre-open.
    computed = {
        "milestones": {"grandOpening": {"raw": 3, "display": "Month 3"}},
        "monthly": [
            {
                "month": i,
                "revenue": {"raw": 0.0, "display": "$0"},
                "expenses": {"raw": 0.0, "display": "$0"},
                "net": {"raw": -100.0 * i, "display": f"(${100 * i})"},
                "cumulativeCash": {"raw": -100.0 * i, "display": f"(${100 * i})"},
            }
            for i in range(1, 16)
        ],
    }
    _set_computed_json(store, slug, computed)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 200, r.text
    by_month = {int(row[0]): row[1] for row in _rows(r)[1:] if row}
    assert by_month[1] == "Pre-opening"
    assert by_month[2] == "Pre-opening"
    assert by_month[3] == "Year 1"
    assert by_month[14] == "Year 1"
    assert by_month[15] == "Year 2"


def test_cashflow_csv_requires_terms_acceptance(client):
    slug = _create(client).json()["view_slug"]
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "terms_required"


def test_cashflow_csv_unknown_slug_404(client):
    r = client.get("/api/projections/does-not-exist/cashflow.csv")
    assert r.status_code == 404


def test_cashflow_csv_per_ip_rate_limit(client, store, monkeypatch):
    monkeypatch.setattr(P, "_EXPORT_IP_LIMIT", 3, raising=False)
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    for _ in range(3):
        assert client.get(f"/api/projections/{slug}/cashflow.csv").status_code == 200
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"


def test_cashflow_csv_per_token_rate_limit(client, store, monkeypatch):
    # A generous IP cap but a tight per-token cap proves the per-token leg fires
    # independently when a bearer is presented.
    monkeypatch.setattr(P, "_EXPORT_IP_LIMIT", 1000, raising=False)
    monkeypatch.setattr(P, "_EXPORT_TOKEN_LIMIT", 3, raising=False)
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    headers = {"Authorization": "Bearer tok-abc"}
    for _ in range(3):
        assert client.get(
            f"/api/projections/{slug}/cashflow.csv", headers=headers
        ).status_code == 200
    r = client.get(f"/api/projections/{slug}/cashflow.csv", headers=headers)
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"


def test_cashflow_csv_legacy_12_row_snapshot_degrades(client, store):
    slug = _create(client).json()["view_slug"]
    _accept_terms(store, slug)
    # A 2.6.0-era snapshot: 12 monthly rows, NO milestones block -> G=1 fallback.
    computed = {
        "monthly": [
            {
                "month": i,
                "revenue": {"raw": 1000.0 * i, "display": f"${1000 * i}"},
                "expenses": {"raw": 500.0 * i, "display": f"${500 * i}"},
                "net": {"raw": 500.0 * i, "display": f"${500 * i}"},
                "cumulativeCash": {"raw": 500.0 * i, "display": f"${500 * i}"},
            }
            for i in range(1, 13)
        ],
    }
    _set_computed_json(store, slug, computed)
    r = client.get(f"/api/projections/{slug}/cashflow.csv")
    assert r.status_code == 200, r.text
    data = [row for row in _rows(r)[1:] if row]
    assert len(data) == 12
    by_month = {int(row[0]): row[1] for row in data}
    assert by_month[1] == "Year 1"
    assert by_month[12] == "Year 1"

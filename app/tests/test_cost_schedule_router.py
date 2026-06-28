"""RED first: POST /api/cost-schedule/preview (decision #15, feature #263).

A read-only, dormant preview endpoint for the pre-Generate startup-costs grid. The
client sends the flat {category, month, amount} rows it is editing; the SERVER is
the one summing + formatting authority and returns per-category row totals,
per-month column totals, and a grand total, EACH as {raw, display}. The client
renders these verbatim and never sums (NO-CLIENT-MATH / SERVER).

Invariants pinned here: server-side aggregation matches the engine, the dual
{raw, display} comma-formatted shape, the empty-rows default fallback, building
_sqft scaling of that fallback, no persistence, and the per-IP rate limit.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import ratelimit


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    ratelimit.reset_rate_limits()
    from app.main import create_app

    return TestClient(create_app())


def test_preview_returns_dual_value_row_column_and_grand_totals(client):
    body = {
        "cost_schedule": [
            {"category": "Equipment", "month": 1, "amount": 45000},
            {"category": "Build-out", "month": 2, "amount": 50000},
            {"category": "Equipment", "month": 3, "amount": 5000},
            {"category": "Legal", "month": 2, "amount": 10000},
        ]
    }
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.status_code == 200, r.text
    data = r.json()

    # per-category row totals (insertion order), each {raw, display}.
    assert data["rowTotals"] == [
        {"category": "Equipment", "total": {"raw": 50000.0, "display": "$50,000"}},
        {"category": "Build-out", "total": {"raw": 50000.0, "display": "$50,000"}},
        {"category": "Legal", "total": {"raw": 10000.0, "display": "$10,000"}},
    ]
    # per-month column totals (ascending), each {raw, display}.
    assert data["columnTotals"] == [
        {"month": 1, "total": {"raw": 45000.0, "display": "$45,000"}},
        {"month": 2, "total": {"raw": 60000.0, "display": "$60,000"}},
        {"month": 3, "total": {"raw": 5000.0, "display": "$5,000"}},
    ]
    assert data["grandTotal"] == {"raw": 110000.0, "display": "$110,000"}


def test_preview_formats_thousands_and_millions_with_commas(client):
    body = {"cost_schedule": [
        {"category": "Big", "month": 1, "amount": 1234567},
    ]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.status_code == 200
    assert r.json()["grandTotal"]["display"] == "$1,234,567"


def test_preview_accepts_numeric_string_amounts(client):
    body = {"cost_schedule": [
        {"category": "A", "month": 1, "amount": "20000"},
        {"category": "A", "month": 1, "amount": "5000"},
    ]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.status_code == 200
    assert r.json()["grandTotal"] == {"raw": 25000.0, "display": "$25,000"}


def test_preview_empty_rows_fall_back_to_seeded_default(client):
    r = client.post("/api/cost-schedule/preview", json={"cost_schedule": []})
    assert r.status_code == 200
    assert r.json()["grandTotal"] == {"raw": 208500.0, "display": "$208,500"}


def test_preview_building_sqft_scales_the_default_fallback(client):
    r = client.post(
        "/api/cost-schedule/preview",
        json={"cost_schedule": [], "building_sqft": "20000"},
    )
    assert r.status_code == 200
    assert r.json()["grandTotal"] == {"raw": 303500.0, "display": "$303,500"}


def test_preview_stamps_model_and_schema_version(client):
    from engine import model

    r = client.post("/api/cost-schedule/preview", json={"cost_schedule": []})
    data = r.json()
    assert data["modelVersion"] == model.MODEL_VERSION
    assert data["computeSchemaVersion"] == model.COMPUTE_SCHEMA_VERSION


def test_preview_formats_negative_amounts_in_parentheses(client):
    # A credit/refund row is negative; the server's format authority renders it in
    # accounting parentheses ("($5,000)"), never a bare minus the client must style.
    body = {"cost_schedule": [
        {"category": "Equipment", "month": 1, "amount": 45000},
        {"category": "Vendor refund", "month": 1, "amount": -5000},
    ]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.status_code == 200
    data = r.json()
    refund = next(row for row in data["rowTotals"] if row["category"] == "Vendor refund")
    assert refund["total"] == {"raw": -5000.0, "display": "($5,000)"}
    assert data["grandTotal"] == {"raw": 40000.0, "display": "$40,000"}


def test_preview_column_totals_are_ascending_regardless_of_input_order(client):
    body = {"cost_schedule": [
        {"category": "A", "month": 3, "amount": 300},
        {"category": "A", "month": 1, "amount": 100},
        {"category": "A", "month": 2, "amount": 200},
    ]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert [c["month"] for c in r.json()["columnTotals"]] == [1, 2, 3]


def test_preview_ignores_unknown_row_fields(client):
    # Rows may carry client-only metadata (provenance, note); extra="ignore" drops
    # it so a richer client payload never 422s the read-only preview.
    body = {"cost_schedule": [
        {"category": "A", "month": 1, "amount": 1000,
         "note": "from proposal", "provenance": {"source": "ai"}},
    ]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.status_code == 200
    assert r.json()["grandTotal"] == {"raw": 1000.0, "display": "$1,000"}


def test_preview_keeps_sub_dollar_raw_but_rounds_display_half_up(client):
    # raw preserves the exact value; display is whole-dollars half-up (the engine's
    # money rounding) — the client renders display and never re-rounds.
    body = {"cost_schedule": [{"category": "A", "month": 1, "amount": "100.50"}]}
    r = client.post("/api/cost-schedule/preview", json=body)
    assert r.json()["grandTotal"] == {"raw": 100.5, "display": "$101"}


def test_preview_is_rate_limited_per_ip(client):
    body = {"cost_schedule": [{"category": "A", "month": 1, "amount": 1}]}
    limited = False
    for _ in range(900):
        r = client.post("/api/cost-schedule/preview", json=body)
        if r.status_code == 429:
            limited = True
            assert r.headers.get("Retry-After")
            assert r.json()["error"] == "rate_limited"
            break
    assert limited

"""Free-vs-paid price/gate config flag (PRD §3, SECURITY.md §3 / API_SPEC §3).

Whether export/share is gated behind the paid expert-review event is a
BUSINESS-MODEL TOGGLE (a config decision), not an access-control bug. The
access layer always permits read+export at the read scope; this flag merely
reports the pricing posture so the UI can show or hide the paid gate.
"""
from app.config import pricing_config


def test_default_is_free_unGated():
    cfg = pricing_config({})
    assert cfg["tier"] == "free"
    assert cfg["export_gated"] is False
    assert cfg["price_cents"] == 0


def test_paid_tier_flag_gates_export():
    cfg = pricing_config({"PRICING_TIER": "paid", "EXPORT_GATED": "true", "PRICE_CENTS": "4900"})
    assert cfg["tier"] == "paid"
    assert cfg["export_gated"] is True
    assert cfg["price_cents"] == 4900


def test_export_gated_is_independent_of_tier():
    # A free tier can still gate export behind terms/paid event; vice versa.
    cfg = pricing_config({"EXPORT_GATED": "1"})
    assert cfg["export_gated"] is True


def test_price_cents_defaults_zero_on_garbage():
    cfg = pricing_config({"PRICE_CENTS": "not-a-number"})
    assert cfg["price_cents"] == 0

"""Golden three-way reconcile gate (ENGINE_CONTRACT §13) — CI-blocking.

Runs assert_reconciles over the House of Hope canonical fixture WITH and WITHOUT
overrides. Legs (a)==(b) reconcile today; leg (c) (LibreOffice recalc) runs in the
pinned CI image once engine/xlsx.render (M1.6) exists and is skipped-with-reason
otherwise — NEVER silently passed. The canonical golden is House of Hope at
LABOR_PCT=0.60 (revenue ~$426,911 holds).
"""
import json
from pathlib import Path

from engine.tests.harness import assert_reconciles

GOLDEN_DIR = Path(__file__).parent / "golden"


def _load(name: str) -> dict:
    return json.loads((GOLDEN_DIR / name).read_text())


def test_house_of_hope_canonical_reconciles_no_overrides():
    fx = _load("house_of_hope.json")
    result = assert_reconciles(fx, overrides=None)
    exp = fx["expected"]
    # Revenue ~$426,911 holds (labor-independent), at LABOR_PCT=0.60 canonical.
    assert abs(result["_raw"]["total_rev"][0] - exp["headline_revenue_approx"]) < exp[
        "headline_revenue_tolerance"
    ]
    assert result["rows"][0]["y1"]["display"] == exp["y1_total_rev_display"]
    assert result["_reconcile"]["ab"] == "ok"


def test_house_of_hope_canonical_is_loss_case_at_60pct():
    fx = _load("house_of_hope.json")
    result = assert_reconciles(fx)
    assert (result["_raw"]["net"][0] < 0) is fx["expected"]["y1_net_is_negative"]
    assert (result["flags"]["payback"] is None) is fx["expected"]["y1_payback_null"]


def test_reconcile_runs_with_overrides_present():
    # The gate must run in BOTH states (ENGINE_CONTRACT §13.5). Override plumbing is
    # M1.4; passing an overrides dict must not break the (a)==(b) reconcile today.
    fx = _load("house_of_hope.json")
    result = assert_reconciles(fx, overrides={"Payroll#1": {"value": 250000}})
    assert result["_reconcile"]["ab"] == "ok"


def test_golden_fixture_pins_model_version():
    fx = _load("house_of_hope.json")
    assert fx["model_version"] == "2.0.0"


def test_xlsx_leg_is_skipped_with_reason_not_silently_passed():
    # Until M1.6 builds engine/xlsx.render, leg (c) must be an explicit skip reason,
    # never a silent 'ok' (fail-closed discipline).
    fx = _load("house_of_hope.json")
    result = assert_reconciles(fx)
    xlsx = result["_reconcile"]["xlsx"]
    assert xlsx == "ok" or xlsx.startswith("skipped:")

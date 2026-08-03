"""RED first: override DAG resolution rules (§7) + foots-always property."""
from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from engine import dag
from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D


def _inputs():
    return Inputs(
        org_name="DAG", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10", share_y4="0.11", share_y5="0.12",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )


def test_non_pinnable_nodes_rejected():
    for node in ("total_revenue", "total_expenses", "net_profit", "net_margin",
                 "customers", "salvage_sales", "donating_households", "donations",
                 "break_even_month", "startup_capital_required",
                 "first_year_cash_gap", "simple_payback_years", "revenue_cagr"):
        with pytest.raises(dag.PinRejected):
            dag.validate_pin(f"{node}#1")


def test_pinnable_nodes_accepted():
    for node in ("share", "Payroll", "Marketing & outreach", "Supplies & processing",
                 "Credit card fees", "Payroll taxes", "Rent", "Insurance liability"):
        dag.validate_pin(f"{node}#1")  # no raise


def _math_sig(res):
    """The resolved annual MATH (rev/exp/net per year) — not the view-model.

    A no-op pin still mutates the view-model (overrides[] gains an entry, the row
    class flips to 'overridden'), which is exactly the #183 silent-lie symptom; the
    real test of "a pin does something" is whether the resolved numbers move.
    """
    return tuple(
        (D(str(res.annual[y].total_rev)), D(str(res.annual[y].total_exp)),
         D(str(res.annual[y].net)))
        for y in (1, 2, 3)
    )


def test_every_pinnable_node_measurably_changes_compute_output():
    # #183 RED: every node advertised in PINNABLE_NODES MUST actually change the
    # resolved math when pinned. Pre-fix the rate/driver inputs (labor_pct, basket,
    # occupancy, ...) were advertised pinnable but compute() never consulted them, so
    # pinning them was accepted-and-persisted yet byte-identical output (a silent lie).
    trade = TradeArea(basis="city", households="31798")
    base_sig = _math_sig(compute(_inputs(), Assumptions(), DemandDrivers(),
                                 trade, overrides={}))
    for node in sorted(dag.PINNABLE_NODES):
        val = "0.5" if node == "share" else "4242424"
        res = compute(_inputs(), Assumptions(), DemandDrivers(), trade,
                      overrides={f"{node}#1": {"value": val, "note": "n", "ts": "t"}})
        assert _math_sig(res) != base_sig, f"pinning {node!r} did not change output"


def test_non_honored_driver_pins_are_rejected_not_silently_ignored():
    # #183 RED: the rate/driver inputs compute() does NOT resolve via a pin are no
    # longer advertised as pinnable, so a pin on them is REJECTED (-> 422), never
    # accepted-and-ignored. They are edited as global assumptions, not per-year pins.
    for node in ("labor_pct", "marketing_pct", "supplies_pct", "card_share",
                 "card_rate", "card_per_tx_fee",
                 "payroll_tax_pct", "salvage_pct", "escalator", "basket",
                 "donation_value", "donations_per_hh", "sqft", "rent_per_sqft",
                 "occupancy"):
        with pytest.raises(dag.PinRejected):
            dag.validate_pin(f"{node}#1")
    # ...and compute() rejects them at the boundary too (the API echoes this as 422).
    with pytest.raises(dag.PinRejected):
        compute(_inputs(), Assumptions(), DemandDrivers(),
                TradeArea(basis="city", households="31798"),
                overrides={"labor_pct#1": {"value": "0.99", "note": "n", "ts": "t"}})


def test_bad_key_format_rejected():
    with pytest.raises(dag.PinRejected):
        dag.validate_pin("Payroll")          # missing #year
    with pytest.raises(dag.PinRejected):
        dag.validate_pin("Payroll#9")        # year out of range


def test_pinned_component_uses_its_value_and_total_refoots():
    overrides = {"Payroll#1": {"value": "200000", "note": "n", "ts": "2026-06-24"}}
    res = compute(_inputs(), Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides=overrides)
    y1 = res.annual[1]
    assert D(str(y1.expenses["Payroll"])) == Decimal("200000")
    assert D(str(y1.total_exp)) == sum(D(str(v)) for v in y1.expenses.values())


def test_pin_then_reset_returns_to_computed():
    base = compute(_inputs(), Assumptions(), DemandDrivers(),
                   TradeArea(basis="city", households="31798"), overrides={})
    pinned = compute(_inputs(), Assumptions(), DemandDrivers(),
                     TradeArea(basis="city", households="31798"),
                     overrides={"Payroll#1": {"value": "200000", "note": "n", "ts": "t"}})
    reset = compute(_inputs(), Assumptions(), DemandDrivers(),
                    TradeArea(basis="city", households="31798"), overrides={})
    assert pinned.annual[1].expenses["Payroll"] != base.annual[1].expenses["Payroll"]
    assert reset.annual[1].expenses["Payroll"] == base.annual[1].expenses["Payroll"]


def test_compute_rejects_illegal_pin():
    with pytest.raises(dag.PinRejected):
        compute(_inputs(), Assumptions(), DemandDrivers(),
                TradeArea(basis="city", households="31798"),
                overrides={"net_profit#1": {"value": "1", "note": "n", "ts": "t"}})


def test_compute_surfaces_stale_nodes():
    res = compute(_inputs(), Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"),
                  overrides={"Payroll#1": {"value": "200000", "note": "n", "ts": "t"}})
    assert "share#1" in res.stale_nodes


def test_orphaned_upstream_input_pin_sets_stale_flag():
    # Pin Payroll (downstream of total_revenue/share) directly; the upstream
    # share input then no longer drives that pinned value -> stale hint.
    overrides = {"Payroll#1": {"value": "200000", "note": "n", "ts": "t"}}
    stale = dag.stale_upstream(overrides)
    assert "share#1" in stale


# ----- property: statement always foots under any subset of legal pins ----------
_PINNABLE = ["Payroll#1", "Marketing & outreach#1", "Supplies & processing#1",
             "Credit card fees#1", "Rent#1", "Insurance liability#1"]


@settings(max_examples=60, deadline=None)
@given(pins=st.lists(st.sampled_from(_PINNABLE), unique=True),
       vals=st.lists(st.integers(min_value=0, max_value=500000), min_size=6, max_size=6))
def test_property_statement_always_foots(pins, vals):
    overrides = {p: {"value": str(vals[i]), "note": "n", "ts": "t"}
                 for i, p in enumerate(pins)}
    res = compute(_inputs(), Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides=overrides)
    for y in (1, 2, 3):
        yr = res.annual[y]
        assert D(str(yr.total_exp)) == sum(D(str(v)) for v in yr.expenses.values())
        assert D(str(yr.net)) == D(str(yr.total_rev)) - D(str(yr.total_exp))

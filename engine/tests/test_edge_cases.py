"""RED first: N/A sentinels + flags (§8). Never 0-masquerading-as-N/A."""
from decimal import Decimal

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D


def _inputs(**kw):
    base = dict(
        org_name="Edge", city="x", opening_status="pre_launch",
        share_y1="0.06", share_y2="0.08", share_y3="0.10",
        donation_value="74", building_sqft="10000", salesfloor_pct="0.70",
        occupancy_annual="120000", lease_type="nnn", source_of_funds="300000",
    )
    base.update(kw)
    return Inputs(**base)


def test_zero_revenue_makes_margin_null_not_zero():
    res = compute(_inputs(share_y1="0", share_y2="0", share_y3="0"),
                  Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert res.annual[1].total_rev == 0
    assert res.annual[1].margin is None        # explicit null, not Decimal(0)
    assert res.flags.get("margin") == "N/A — no revenue"


def test_zero_revenue_makes_cagr_null():
    res = compute(_inputs(share_y1="0", share_y2="0", share_y3="0"),
                  Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert res.decision.revenue_cagr is None
    assert res.flags.get("cagr") == "N/A"


def test_grace_mission_loss_case_payback_null():
    # High rent / low share -> negative Y1 net -> payback N/A.
    res = compute(_inputs(share_y1="0.03", share_y2="0.035", share_y3="0.04",
                          occupancy_annual="140000"),
                  Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides={})
    assert res.annual[1].net < 0
    assert res.decision.simple_payback_years is None
    assert res.flags.get("payback") == "N/A — no Year 1 profit"


def test_grace_mission_with_payroll_override_still_clean():
    # One overridden Payroll cell (Payroll#1); statement must still foot.
    overrides = {"Payroll#1": {"value": "100000", "note": "frozen", "ts": "2026-06-24"}}
    res = compute(_inputs(share_y1="0.03", share_y2="0.035", share_y3="0.04",
                          occupancy_annual="140000"),
                  Assumptions(), DemandDrivers(),
                  TradeArea(basis="city", households="31798"), overrides=overrides)
    y1 = res.annual[1]
    assert D(str(y1.expenses["Payroll"])) == Decimal("100000")
    assert D(str(y1.total_exp)) == sum(D(str(v)) for v in y1.expenses.values())
    assert D(str(y1.net)) == D(str(y1.total_rev)) - D(str(y1.total_exp))


def test_negative_net_renders_in_parentheses():
    from engine.money import money_view
    assert money_view(Decimal("-12400"))["display"].startswith("(")

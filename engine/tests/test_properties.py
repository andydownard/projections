"""Property-based invariants for the pure compute core (Task 4.4).

Six invariants the engine must hold for *any* in-range projection, checked with
Hypothesis rather than a handful of hand-picked fixtures:

  1. Regression #15 — the Year-1 annual P&L is EXACTLY the roll-up of the 12
     operating months (the monthly model and the annual table can never drift).
  2. §6.1 — startup capital = |peak cumulative-cash trough| + reserve, with the
     trough recomputed independently from the monthly rows (the one-time startup is
     embedded in the trough, never double-counted).
  3. §3/§5 — the rent line compounds by the escalator: Rent Yₙ = Rent Y1·(1+e)^(n-1).
  4. §9.2 — every money {raw, display} pair round-trips: the display parses back to
     the engine's whole-dollar rounding of raw (parentheses = negative).
  5. §8 — break-even is either N/A or a project month at/after grand opening G.
  6. §9 — the view-model settings echo the inputs they were built from (no mangling,
     no y4/y5 swap).

HARD RULE (per the task brief): a counter-example is an ENGINE BUG FINDING, not a
license to weaken the test. If Hypothesis shrinks one, reproduce it as a plain
case, mark that ONE property xfail(strict) with the bug, and report it — never
"fix" the engine here (engine-math changes are Wave-6 scope with a version bump).
"""
from __future__ import annotations

import re
from decimal import Decimal

from hypothesis import example, given, settings
from hypothesis import strategies as st

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute
from engine.money import D, round_dollars

_YEARS = (1, 2, 3, 4, 5)


# --------------------------------------------------------------- strategies
_SHARE = st.decimals(min_value=Decimal("0.001"), max_value=Decimal("0.3"),
                     places=4, allow_nan=False, allow_infinity=False)


@st.composite
def cases(draw):
    """One in-range projection: strings/ints ready for the engine dataclasses.

    Rent is driven by ``rent_per_sqft × building_sqft`` (gross lease) so property 3
    can assert the escalator against the resolved occupancy. Assumptions are the
    engine defaults except ``basket`` (which the brief varies); labour/escalator/
    reserve stay at their named-constant defaults.
    """
    households = draw(st.integers(min_value=100, max_value=500_000))
    shares = [str(draw(_SHARE)) for _ in _YEARS]
    basket = str(draw(st.decimals(min_value=Decimal("1"), max_value=Decimal("100"),
                                  places=2, allow_nan=False, allow_infinity=False)))
    donation_value = str(draw(st.decimals(min_value=Decimal("1"), max_value=Decimal("500"),
                                          places=2, allow_nan=False, allow_infinity=False)))
    sqft = draw(st.integers(min_value=500, max_value=50_000))
    rent = str(draw(st.decimals(min_value=Decimal("1"), max_value=Decimal("60"),
                                places=2, allow_nan=False, allow_infinity=False)))
    opening = draw(st.integers(min_value=1, max_value=12))
    schedule_rows = draw(st.lists(
        st.fixed_dictionaries({
            "month": st.integers(min_value=1, max_value=24),
            "amount": st.integers(min_value=0, max_value=500_000),
        }),
        min_size=0, max_size=10))
    schedule = tuple(
        {"category": f"Line {i}", "month": r["month"], "amount": str(r["amount"])}
        for i, r in enumerate(schedule_rows))
    return {
        "households": households, "shares": shares, "basket": basket,
        "donation_value": donation_value, "sqft": sqft, "rent": rent,
        "opening": opening, "schedule": schedule,
    }


def _run(case):
    inputs = Inputs(
        org_name="Prop", city="x", opening_status="pre_launch",
        share_y1=case["shares"][0], share_y2=case["shares"][1],
        share_y3=case["shares"][2], share_y4=case["shares"][3],
        share_y5=case["shares"][4],
        donation_value=case["donation_value"],
        building_sqft=str(case["sqft"]), salesfloor_pct="0.70",
        rent_per_sqft=case["rent"], lease_type="gross",
        source_of_funds="1000000",
        opening_month_number=case["opening"], cost_schedule=case["schedule"],
    )
    assumptions = Assumptions(basket=case["basket"])
    result = compute(inputs, assumptions, DemandDrivers(),
                     TradeArea(basis="city", households=str(case["households"])),
                     overrides={})
    return result, inputs, assumptions


# ------------------------------------------------- 1) annual == Σ(12 months)
@settings(max_examples=50, deadline=None)
@given(case=cases())
def test_year1_annual_equals_sum_of_twelve_operating_months(case):
    result, inputs, _ = _run(case)
    g = inputs.opening_month_number
    op = [m for m in result.monthly if m.kind == "operating" and g <= m.index <= g + 11]
    assert len(op) == 12
    y1 = result.annual[1]
    # Decimal-exact (Regression #15): the roll-up is bit-identical, not "within $0.50".
    assert sum((m.revenue for m in op), Decimal("0")) == y1.total_rev
    assert sum((m.expenses for m in op), Decimal("0")) == y1.total_exp
    assert sum((m.net for m in op), Decimal("0")) == y1.net


# ---------------------------------------- 2) capital == |trough| + reserve
@settings(max_examples=50, deadline=None)
@given(case=cases())
def test_capital_is_trough_plus_reserve_no_startup_double_count(case):
    result, _, assumptions = _run(case)
    cum = [D(str(m.cumulative_cash)) for m in result.monthly]
    trough = min(cum) if cum else Decimal("0")
    # The trough already embeds the timed startup outflow; capital adds ONLY the
    # reserve buffer on top (never startup a second time — the §6.1 bug).
    expected = abs(min(Decimal("0"), trough)) + D(assumptions.reserve_buffer)
    assert result.decision.startup_capital_required == expected


# ------------------------------------------------ 3) rent compounds by escalator
@settings(max_examples=50, deadline=None)
@given(case=cases())
def test_rent_line_compounds_by_the_escalator(case):
    result, _, assumptions = _run(case)
    e = D(assumptions.escalator)
    rent1 = D(str(result.annual[1].expenses["Rent"]))
    for n in (2, 3, 4, 5):
        expected = rent1 * (Decimal("1") + e) ** (n - 1)
        assert D(str(result.annual[n].expenses["Rent"])) == expected


# --------------------------------------- 4) money display round-trips to raw
_MONEY_RE = re.compile(r"^\(\$[\d,]+\)$|^\$[\d,]+$")


def _money_pairs(node):
    """Yield every ``{raw, display}`` pair in the view-model whose display is a
    money string ("$1,234" / "($1,234)") — never a percent / count / month / N/A."""
    if isinstance(node, dict):
        disp = node.get("display")
        if (node.get("raw") is not None and isinstance(disp, str)
                and _MONEY_RE.match(disp)):
            yield node
        for v in node.values():
            yield from _money_pairs(v)
    elif isinstance(node, list):
        for v in node:
            yield from _money_pairs(v)


def _parse_money(display: str) -> int:
    negative = display.startswith("(")
    digits = display.strip("()$").replace(",", "")
    value = int(digits)
    return -value if negative else value


# The knife-edge counter-example Hypothesis once shrank to (Wave-4 finding, fixed in
# Wave-6/2.7.0 — see test_lease_deposit_raw_and_display_agree_... below). Kept as a
# permanent @example so this property is exercised on the historically-buggy input on
# EVERY run, never only when a random seed happens to land on it — a deterministic
# regression pin against the money_view single-rounding-authority regressing.
_LEASE_DEPOSIT_REGRESSION_CASE = {
    "households": 100, "shares": ["0.0010"] * 5, "basket": "1.00",
    "donation_value": "1.00", "sqft": 500, "rent": "37.70",
    "opening": 1, "schedule": (),
}


@settings(max_examples=50, deadline=None)
@given(case=cases())
@example(case=_LEASE_DEPOSIT_REGRESSION_CASE)
def test_every_money_display_parses_back_to_rounded_raw(case):
    result, _, _ = _run(case)
    pairs = list(_money_pairs(result.view_model))
    assert pairs  # the view-model always carries money (revenue, capital, ...)
    for pair in pairs:
        # `round_dollars` is the engine's whole-dollar rounding authority (ROUND_HALF_UP)
        # — the SAME one that produced `display`; the display must round-trip to it.
        assert _parse_money(pair["display"]) == int(round_dollars(pair["raw"])), pair


def test_lease_deposit_raw_and_display_agree_on_a_half_dollar():
    # Permanent regression guard for the Wave-4 finding, fixed in 2.7.0. occ1 = 500 sq ft
    # × $37.70 = $18,850; the deposit line is 3 months of monthly occupancy. The exact
    # value is $4,712.50. Pre-fix the line computed occ1/12*3 = 4712.4999… (a 28-digit
    # Decimal just under the half-dollar), so display=round_dollars(Decimal)="$4,712"
    # (rounds DOWN) disagreed with raw=float=4712.5 (which rounds UP to $4,713). The fix
    # is twofold: the deposit is now computed occ1*3/12 (exact 4712.5), and money_view
    # single-sources display+raw from D(repr(float(value))) so the pair can NEVER disagree.
    inputs = Inputs(
        org_name="Prop", city="x", opening_status="pre_launch",
        share_y1="0.001", share_y2="0.001", share_y3="0.001",
        share_y4="0.001", share_y5="0.001", donation_value="1",
        building_sqft="500", salesfloor_pct="0.70",
        rent_per_sqft="37.70", lease_type="gross", source_of_funds="1000000",
    )
    result = compute(inputs, Assumptions(basket="1"), DemandDrivers(),
                     TradeArea(basis="city", households="100"), overrides={})
    deposit = next(c for c in result.view_model["startupCosts"]
                   if c["category"].startswith("Lease Deposit"))
    # The {raw,display} contract: display must round-trip to the whole-dollar rounding
    # of raw. (Underlying quantity is now exactly $4,712.50 → both render $4,713.)
    assert _parse_money(deposit["amount"]["display"]) == int(
        round_dollars(deposit["amount"]["raw"])
    )
    assert deposit["amount"]["display"] == "$4,713"


# ------------------------------------------ 5) break-even None or >= opening
@settings(max_examples=50, deadline=None)
@given(case=cases())
def test_break_even_month_is_none_or_at_least_grand_opening(case):
    result, inputs, _ = _run(case)
    g = inputs.opening_month_number
    be = result.decision.break_even_month
    assert be is None or be >= g
    # the raw monthly mirror must agree (there is one break-even, not two).
    assert result.monthly_breakeven == be
    assert result.monthly_breakeven is None or result.monthly_breakeven >= g


# --------------------------------------------- 6) settings echo the inputs
@settings(max_examples=50, deadline=None)
@given(case=cases())
def test_settings_echo_the_inputs_given(case):
    result, inputs, assumptions = _run(case)
    s = result.view_model["settings"]
    # per-year shares echo in the RIGHT slots (a y4/y5 swap would be caught here).
    assert s["shareY1"] == float(D(inputs.share_y1))
    assert s["shareY2"] == float(D(inputs.share_y2))
    assert s["shareY3"] == float(D(inputs.share_y3))
    assert s["shareY4"] == float(D(inputs.share_y4))
    assert s["shareY5"] == float(D(inputs.share_y5))
    assert s["basket"] == float(D(assumptions.basket))
    assert s["donationValue"] == float(D(inputs.donation_value))
    assert s["buildingSqft"] == float(D(inputs.building_sqft))
    assert s["laborPct"] == float(D(assumptions.labor_pct))
    assert s["rentPerSqft"] == float(D(inputs.rent_per_sqft))

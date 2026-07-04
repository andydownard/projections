"""Shared fixtures: the canonical (60% labor) and design-parity (40%) inputs.

House of Hope canonical (ENGINE_CONTRACT §10): shares 6/8/10%, basket $17.08,
labor 60% (owner default), donation_value $74, H=31,798, 10,000 sqft, 70%
salesfloor. Occupancy is pinned as an explicit annual-$ (DECISIONS.md M1-FIX) so
the three-way gate is deterministic.
"""
import pytest

from engine.compute import Assumptions, DemandDrivers, Inputs, TradeArea, compute


def _canonical_inputs(labor_pct="0.60"):
    inputs = Inputs(
        org_name="House of Hope",
        city="Longview, Texas",
        opening_status="pre_launch",
        share_y1="0.06",
        share_y2="0.08",
        share_y3="0.10",
        share_y4="0.11",
        share_y5="0.12",
        donation_value="74",
        building_sqft="10000",
        salesfloor_pct="0.70",
        occupancy_annual="120000",   # explicit annual-$ pin (M1-FIX)
        lease_type="nnn",
        source_of_funds="300000",
    )
    assumptions = Assumptions(labor_pct=labor_pct)  # all others default
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="31798")
    return inputs, assumptions, demand, trade


def build_canonical_inputs():
    """Plain (non-fixture) builder — importable from outside pytest, e.g. by
    scripts/regen_goldens.py, which needs the exact same fixture inputs the
    frozen goldens were generated from without going through pytest collection.
    """
    return _canonical_inputs("0.60")


def build_design_parity_inputs():
    return _canonical_inputs("0.40")


def build_canonical_result():
    return compute(*build_canonical_inputs(), overrides={})


def build_design_parity_result():
    return compute(*build_design_parity_inputs(), overrides={})


# --------------------------------------------------------------- Aggressive
# The §12.2 guardrail fixture (ENGINE_CONTRACT §10 / AGENTS.md fixture 2): the
# legacy house_of_hope.json shares 15/20/25 (+ the 5-year plateau Y4/Y5 = 26/27),
# else the canonical House of Hope inputs. It MUST trigger the net-margin (>30%)
# AND share (>8%) guardrails and yield reco = "revise".
#
# Labor is 40% here — NOT the 60% owner default — and that is load-bearing, not an
# oversight: at 60% labor the %-of-revenue cost stack alone is ~75.25% of revenue,
# so the net margin can never exceed ~24.75% no matter how high the share, and the
# net-margin guardrail (>30%) could never fire. 40% is the design-parity labor the
# "~39% margin, reco=revise" scenario was always calibrated against; it makes the
# guardrail fixture actually guard. (The doc "else defaults" predates the 60% flip,
# exactly like the House-of-Hope-canonical-is-now-a-loss note.)
def build_aggressive_inputs():
    inputs = Inputs(
        org_name="Aggressive Thrift",
        city="Longview, Texas",
        opening_status="pre_launch",
        share_y1="0.15", share_y2="0.20", share_y3="0.25",
        share_y4="0.26", share_y5="0.27",
        donation_value="74",
        building_sqft="10000",
        salesfloor_pct="0.70",
        occupancy_annual="120000",
        lease_type="nnn",
        source_of_funds="300000",
    )
    assumptions = Assumptions(labor_pct="0.40")
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="31798")
    return inputs, assumptions, demand, trade


def build_aggressive_result():
    return compute(*build_aggressive_inputs(), overrides={})


# ------------------------------------------------------------- Grace Mission
# The loss / edge-case fixture (ENGINE_CONTRACT §10 / AGENTS.md fixture 3): a
# negative-Year-1-net store on a low-confidence $14/sq-ft rent (rent_per_sqft="14"
# × 6,000 sq ft ⇒ $84,000 occupancy) with ONE overridden Payroll cell. It exercises
# the §12.4 guarded blank-string paths — payback =IF(net<=0,"",...) — that the
# legacy engine's unguarded =startup/Y1net would have turned into a #DIV/0!. Shares
# stay inside the ≤8% band so the ONLY advisory flag is the payback N/A. The frozen
# golden is generated WITH the Payroll#1 pin present (that pin is part of Grace's
# identity), and the statement still foots to the penny.
#
# ("Low confidence" on the $14/sq-ft rent is an evidence-layer property, not a
# compute input — it never reaches the pure engine — so it is documented here but
# not encoded in DemandDrivers.)
GRACE_PAYROLL_OVERRIDE = {
    "Payroll#1": {
        "value": "110000",
        "note": "2 FTE managers + PT staff, benefits (justification)",
        "ts": "2026-07-04T00:00:00Z",
    }
}


def build_grace_inputs():
    inputs = Inputs(
        org_name="Grace Mission",
        city="Tyler, Texas",
        opening_status="pre_launch",
        share_y1="0.04", share_y2="0.05", share_y3="0.06",
        share_y4="0.07", share_y5="0.08",
        donation_value="74",
        building_sqft="6000",
        salesfloor_pct="0.70",
        rent_per_sqft="14",          # low-confidence market rent (evidence-layer)
        lease_type="gross",
        source_of_funds="250000",
    )
    assumptions = Assumptions()       # 60% labor default; Y1 payroll is overridden
    demand = DemandDrivers()
    trade = TradeArea(basis="city", households="25000")
    return inputs, assumptions, demand, trade


def build_grace_result():
    return compute(*build_grace_inputs(), overrides=dict(GRACE_PAYROLL_OVERRIDE))


@pytest.fixture
def canonical_inputs():
    return build_canonical_inputs()


@pytest.fixture
def design_parity_inputs():
    return build_design_parity_inputs()


@pytest.fixture
def canonical_result(canonical_inputs):
    return compute(*canonical_inputs, overrides={})


@pytest.fixture
def design_parity_result(design_parity_inputs):
    return compute(*design_parity_inputs, overrides={})


@pytest.fixture
def aggressive_inputs():
    return build_aggressive_inputs()


@pytest.fixture
def aggressive_result():
    return build_aggressive_result()


@pytest.fixture
def grace_inputs():
    return build_grace_inputs()


@pytest.fixture
def grace_result():
    return build_grace_result()

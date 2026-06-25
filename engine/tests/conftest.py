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


@pytest.fixture
def canonical_inputs():
    return _canonical_inputs("0.60")


@pytest.fixture
def design_parity_inputs():
    return _canonical_inputs("0.40")


@pytest.fixture
def canonical_result(canonical_inputs):
    return compute(*canonical_inputs, overrides={})


@pytest.fixture
def design_parity_result(design_parity_inputs):
    return compute(*design_parity_inputs, overrides={})

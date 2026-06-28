"""unpinned_node_values: the single 'no-override calculated cell' source (§14).

Both the router's auto-clear-on-equal check and the Override Inspector's
``calculated`` column read this one helper, so they can never drift in WHICH
(node, year) cells they expose, nor in the value each cell holds. These tests
lock the helper to a pure no-override recompute of the annual chain.
"""
from engine.compute import compute_annual, unpinned_node_values


def test_exposes_share_and_every_expense_for_all_three_years(canonical_inputs):
    inputs, assumptions, demand, trade = canonical_inputs
    values = unpinned_node_values(inputs, assumptions, demand, trade)

    years, _startup, _total, _occ = compute_annual(
        inputs, assumptions, demand, trade, {})
    expected_keys = set()
    for y in (1, 2, 3):
        expected_keys.add(("share", y))
        for label in years[y].expenses:
            expected_keys.add((label, y))
    assert set(values) == expected_keys


def test_values_match_the_no_override_annual_chain(canonical_inputs):
    inputs, assumptions, demand, trade = canonical_inputs
    values = unpinned_node_values(inputs, assumptions, demand, trade)

    years, _startup, _total, _occ = compute_annual(
        inputs, assumptions, demand, trade, {})
    for y in (1, 2, 3):
        assert values[("share", y)] == years[y].share
        for label, val in years[y].expenses.items():
            assert values[(label, y)] == val


def test_ignores_any_pinned_overrides(canonical_inputs):
    # The helper is the CALCULATED (pin-absent) baseline: a wildly different pin
    # on Payroll#1 must not move its reported value — that is exactly what makes
    # it usable both as the router's auto-clear-on-equal baseline and the Override
    # Inspector's ``calculated`` column.
    inputs, assumptions, demand, trade = canonical_inputs
    baseline = unpinned_node_values(inputs, assumptions, demand, trade)

    pinned, _s, _t, _o = compute_annual(
        inputs, assumptions, demand, trade, {"Payroll#1": {"value": "999999"}})
    assert pinned[1].expenses["Payroll"] != baseline[("Payroll", 1)]
    # The helper itself is override-free, so its output is unchanged.
    assert unpinned_node_values(inputs, assumptions, demand, trade) == baseline

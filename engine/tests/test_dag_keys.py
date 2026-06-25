"""RED first: override-key parsing edge branches + affected-row mapping (§7).

These pin the exact PinRejected semantics the API boundary depends on to emit
its 422 ``node_not_pinnable`` / malformed-key bodies, and the descriptive
``affected_rows`` mapping the Override Inspector renders. Every branch in
``dag.parse_key`` / ``dag.validate_pin`` is exercised here so the gate that
"a derived/total cell can never be pinned" cannot silently rot.
"""
import pytest

from engine import dag


def test_parse_key_missing_hash_rejected():
    with pytest.raises(dag.PinRejected) as ei:
        dag.parse_key("Payroll")
    assert "node}#{year" in str(ei.value)


def test_parse_key_empty_node_rejected():
    # '#1' rpartitions to ('', '#', '1') -> node is empty.
    with pytest.raises(dag.PinRejected) as ei:
        dag.parse_key("#1")
    assert "missing node" in str(ei.value)


def test_parse_key_non_integer_year_rejected():
    with pytest.raises(dag.PinRejected) as ei:
        dag.parse_key("Payroll#two")
    assert "not an int" in str(ei.value)


@pytest.mark.parametrize("year", ["0", "4", "-1", "10"])
def test_parse_key_year_out_of_range_rejected(year):
    with pytest.raises(dag.PinRejected):
        dag.parse_key(f"Payroll#{year}")


@pytest.mark.parametrize("year", [1, 2, 3])
def test_parse_key_accepts_legal_years(year):
    node, parsed_year = dag.parse_key(f"Rent#{year}")
    assert (node, parsed_year) == ("Rent", year)


def test_node_with_embedded_hash_uses_rpartition():
    # rpartition keeps everything left of the LAST '#': a node name that itself
    # contains '#' still parses the trailing year correctly.
    node, year = dag.parse_key("weird#name#2")
    assert node == "weird#name"
    assert year == 2


def test_unknown_pinnable_node_rejected_and_carries_node():
    with pytest.raises(dag.PinRejected) as ei:
        dag.validate_pin("not_a_real_line#1")
    assert ei.value.node == "not_a_real_line"
    assert "unknown pinnable node" in str(ei.value)


def test_non_pinnable_rejection_carries_node_for_api_body():
    with pytest.raises(dag.PinRejected) as ei:
        dag.validate_pin("net_margin#2")
    # The API echoes .node verbatim in its 422 node_not_pinnable body.
    assert ei.value.node == "net_margin"


def test_validate_all_raises_on_first_illegal_pin():
    overrides = {
        "Payroll#1": {"value": "1"},        # legal
        "total_revenue#1": {"value": "2"},  # illegal -> must raise
    }
    with pytest.raises(dag.PinRejected) as ei:
        dag.validate_all(overrides)
    assert ei.value.node == "total_revenue"


def test_validate_all_passes_for_all_legal_pins():
    overrides = {"Payroll#1": {}, "Rent#2": {}, "Marketing & outreach#3": {}}
    assert dag.validate_all(overrides) is True


def test_affected_rows_default_is_totals_only():
    # A generic expense component foots only through to the totals block.
    assert dag.affected_rows("Insurance liability") == [
        "Total Expenses", "Net profit", "Net margin"]


def test_affected_rows_payroll_includes_payroll_taxes():
    rows = dag.affected_rows("Payroll")
    assert rows[0] == "Payroll taxes"
    assert rows[-3:] == ["Total Expenses", "Net profit", "Net margin"]


def test_affected_rows_share_fans_out_through_revenue_chain():
    rows = dag.affected_rows("share")
    assert "Donating households" in rows
    assert "Total Revenue" in rows
    assert rows[-1] == "Net margin"


def test_affected_rows_returns_fresh_list_not_shared_mutable():
    a = dag.affected_rows("Payroll")
    a.append("MUTATED")
    b = dag.affected_rows("Payroll")
    assert "MUTATED" not in b


def test_stale_upstream_node_with_no_upstream_map_contributes_nothing():
    # 'Insurance liability' has no entry in _UPSTREAM_OF -> the inner loop body
    # never runs; it must not add any stale keys.
    stale = dag.stale_upstream({"Insurance liability#1": {"value": "1"}})
    assert stale == set()


def test_stale_upstream_skips_inputs_that_are_themselves_pinned():
    # If share#1 is ALSO pinned, it is not stale for the pinned Payroll#1.
    stale = dag.stale_upstream({
        "Payroll#1": {"value": "1"},
        "share#1": {"value": "0.07"},
    })
    assert "share#1" not in stale
    assert "labor_pct#1" in stale  # still stale: not pinned


def test_stale_upstream_is_year_scoped():
    stale = dag.stale_upstream({"Payroll#2": {"value": "1"}})
    assert "share#2" in stale
    assert "share#1" not in stale

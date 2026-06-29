"""RED first: the two locked fixtures are byte-stable (pinned to model_version).

The 60% canonical golden is the correctness target (labor-independent Y1 revenue
holds; margin/decision pinned at 60% — a loss / do_not_proceed case). The 40%
design-parity twin reproduces the Appendix-D headline (margin ~11%, break-even
~month 5) for design-QA only.

A change to the engine math that moves these outputs must regenerate the frozen
JSON in the same commit (a NEW model_version), never a silent flip.
"""
import json
import pathlib

from engine.viewmodel import to_view_model

GOLDEN = pathlib.Path(__file__).parent / "golden"


def _load(name):
    return json.loads((GOLDEN / name).read_text())


def test_canonical_60_fixture_is_byte_stable(canonical_result):
    expected = _load("house_of_hope_canonical_60.json")
    actual = json.loads(json.dumps(to_view_model(canonical_result), sort_keys=True))
    assert actual == expected


def test_design_parity_40_fixture_is_byte_stable(design_parity_result):
    expected = _load("house_of_hope_design_parity_40.json")
    actual = json.loads(json.dumps(to_view_model(design_parity_result), sort_keys=True))
    assert actual == expected


def test_canonical_is_a_loss_case():
    vm = _load("house_of_hope_canonical_60.json")
    # Cash-based Net margin display negative (parentheses) and reco is not proceed.
    assert vm["rows"][-1]["y1"]["display"].startswith("(")
    assert vm["reco"]["tag"] != "proceed"
    assert vm["model_version"] == "2.7.0"
    # CASH basis (epic #321): the displayed Year-1 Net income includes the one-time
    # startup hit (operating −$44,433 − $238,500 startup = −$282,933).
    net = next(r for r in vm["rows"] if r["label"] == "Net income")
    assert round(net["y1"]["raw"]) == -282933


def test_canonical_reco_text_consistent_with_breakeven_metric():
    # #142 regression guard at the FROZEN-FIXTURE layer: the shipped default output
    # can never again encode a "break-even not reached" reco next to a real Month-N
    # break-even metric. The base case reaches break-even (do_not_proceed is driven
    # by the DOWNSIDE), so the reco/reason text must name both — never contradict it.
    from engine.tests.test_decision import assert_breakeven_text_consistent
    vm = _load("house_of_hope_canonical_60.json")
    assert vm["metrics"]["breakeven"]["raw"] is not None
    assert vm["reco"]["tag"] == "do_not_proceed"
    assert_breakeven_text_consistent(vm)
    # Both the verdict sub and the metric reason must surface the downside driver.
    for text in (vm["reco"]["sub"].lower(), vm["metrics"]["reasonBreakeven"].lower()):
        assert "base case" in text and "downside" in text


def test_design_parity_reproduces_headline(design_parity_result):
    vm = _load("house_of_hope_design_parity_40.json")
    # The labor-driven prototype headline: break-even ~month 5 (operating).
    assert vm["breakevenMonth"] == 5
    # CASH basis (epic #321): the DISPLAYED Year-1 Net margin is dragged negative by the
    # one-time startup hit (operating +$47,359 − $238,500 = −$191,141 over revenue), even
    # though the OPERATING margin is the ~11% prototype headline. The displayed net + margin
    # are congruent (both cash), and the payback now resolves to a real Month N (Month 30).
    assert vm["rows"][-1]["y1"]["raw"] < 0                       # displayed (cash) margin
    assert round(next(r for r in vm["rows"] if r["label"] == "Net income")["y1"]["raw"]) == -191141
    assert vm["milestones"]["payback"]["raw"] == 30
    op_margin = float(design_parity_result.annual[1].margin)
    assert 0.10 < op_margin < 0.12                              # the ~11% operating headline


def test_y1_revenue_identical_across_both_fixtures():
    a = _load("house_of_hope_canonical_60.json")
    b = _load("house_of_hope_design_parity_40.json")
    # Revenue is labor-independent.
    assert a["kpis"][0]["value"]["raw"] == b["kpis"][0]["value"]["raw"]

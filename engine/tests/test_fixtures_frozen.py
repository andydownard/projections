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
    # margin display negative (parentheses) and reco is not proceed.
    assert vm["rows"][-1]["y1"]["display"].startswith("(")
    assert vm["reco"]["tag"] != "proceed"
    assert vm["model_version"] == "2.6.0"


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


def test_design_parity_reproduces_headline():
    vm = _load("house_of_hope_design_parity_40.json")
    # margin ~11% and break-even ~month 5 (the labor-driven prototype headline).
    assert vm["rows"][-1]["y1"]["raw"] > 0.10 and vm["rows"][-1]["y1"]["raw"] < 0.12
    assert vm["breakevenMonth"] == 5


def test_y1_revenue_identical_across_both_fixtures():
    a = _load("house_of_hope_canonical_60.json")
    b = _load("house_of_hope_design_parity_40.json")
    # Revenue is labor-independent.
    assert a["kpis"][0]["value"]["raw"] == b["kpis"][0]["value"]["raw"]


# --------------------------------------------------------------- Aggressive
def test_aggressive_fixture_is_byte_stable(aggressive_result):
    expected = _load("aggressive_flagged.json")
    actual = json.loads(json.dumps(to_view_model(aggressive_result), sort_keys=True))
    assert actual == expected


def test_aggressive_triggers_the_two_named_guardrail_flags():
    # AGENTS.md fixture 2: the aggressive shares MUST fire both §12.2 advisory
    # guardrails, each demanding a justification note that travels into the packet.
    vm = _load("aggressive_flagged.json")
    flags = vm["flags"]
    assert flags["net_margin_out_of_band"]["requires_note"] is True
    assert flags["share_y1_out_of_band"]["requires_note"] is True
    # Year-1 margin is above the ~30% band (a flag, not a math error) and the
    # verdict is "revise", never "proceed".
    assert vm["rows"][-1]["y1"]["raw"] > 0.30
    assert vm["reco"]["tag"] == "revise"
    assert vm["model_version"] == "2.6.0"


# ------------------------------------------------------------- Grace Mission
def test_grace_fixture_is_byte_stable(grace_result):
    expected = _load("grace_mission_loss.json")
    actual = json.loads(json.dumps(to_view_model(grace_result), sort_keys=True))
    assert actual == expected


def test_grace_is_a_loss_case_with_payback_na_and_one_pinned_payroll():
    # AGENTS.md fixture 3: negative Year-1 net rendered in parentheses, payback
    # N/A-with-reason (never a 0), and exactly one overridden Payroll cell whose
    # pinned value differs from the calculated value the Inspector shows.
    vm = _load("grace_mission_loss.json")
    net_row = next(r for r in vm["rows"] if r["label"] == "Net income")
    assert net_row["y1"]["raw"] < 0
    assert net_row["y1"]["display"].startswith("(")   # parentheses for negatives
    assert vm["flags"]["payback"] == "N/A — no Year 1 profit"
    assert vm["milestones"]["payback"]["raw"] is None  # explicit null, never a 0
    assert vm["milestones"]["payback"]["display"] == "N/A"
    assert len(vm["overrides"]) == 1
    ov = vm["overrides"][0]
    assert ov["node"] == "Payroll" and ov["year"] == 1
    assert ov["value"]["raw"] == 110000.0
    assert ov["calculated"]["raw"] != ov["value"]["raw"]  # calc-vs-override, no back-solve
    assert vm["model_version"] == "2.6.0"

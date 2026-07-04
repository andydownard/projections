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
    assert vm["model_version"] == "2.7.0"


def test_canonical_reco_text_consistent_with_breakeven_metric():
    # #142 regression guard at the FROZEN-FIXTURE layer: the shipped default output can
    # never encode a "break-even not reached" reco next to a real Month-N break-even
    # metric. At 2.7.0 the canonical verdict is raise_cash — the base case reaches
    # break-even (Month 8) and the binding constraint is capital > the $300k funds — so
    # the break-even reason stays the plain positive statement and the verdict sub names
    # the CAPITAL constraint; no field may contradict the Month-8 metric.
    from engine.tests.test_decision import assert_breakeven_text_consistent
    vm = _load("house_of_hope_canonical_60.json")
    assert vm["metrics"]["breakeven"]["raw"] is not None
    assert vm["reco"]["tag"] == "raise_cash"
    assert_breakeven_text_consistent(vm)  # break-even IS reached -> no "unreached" claim
    # The verdict is capital-driven; the break-even reason never claims "not reached".
    assert "capital" in vm["reco"]["sub"].lower()
    assert "not reached" not in vm["metrics"]["reasonBreakeven"].lower()


def test_design_parity_reproduces_headline():
    vm = _load("house_of_hope_design_parity_40.json")
    # The labor-driven prototype SHAPE (40% labor, positive Y1, early break-even). At
    # 2.7.0 the 990-grounded constants (payroll tax 8%, Insurance $10k) lower the margin
    # to ~9.0% (was ~11%) and push break-even to month 6 (was 5). *** The reco also
    # flips proceed -> raise_cash (capital $302,238 > the $300k design-parity funds by
    # $2,238) — an OWNER-VISIBLE change flagged for the whole-branch reviewer. *** The
    # prototype "Proceed / ~11% / month 5" numbers were calibrated to the pre-990 basis.
    assert 0.085 < vm["rows"][-1]["y1"]["raw"] < 0.095
    assert vm["breakevenMonth"] == 6
    assert vm["reco"]["tag"] == "raise_cash"


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
    assert vm["model_version"] == "2.7.0"


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
    assert vm["model_version"] == "2.7.0"


# --------------------------------------------------------- NNN gross-check
def test_nnn_gross_check_fixture_is_byte_stable(nnn_gross_check_result):
    expected = _load("nnn_gross_check.json")
    actual = json.loads(json.dumps(to_view_model(nnn_gross_check_result), sort_keys=True))
    assert actual == expected


def test_nnn_resolution_escalates_and_deposits_on_resolved_occupancy():
    # Task 6.4 (DECISIONS.md): "code behavior governs" — the escalator and the lease
    # deposit BOTH apply to the resolved occupancy INCLUDING the $30k NNN opex, never
    # the base rent alone. Rent Y1 = $150,000 (120k + 30k), Y2 = $154,500 (×1.03), and
    # the deposit is 3 months of the resolved occupancy = $37,500.
    vm = _load("nnn_gross_check.json")
    rent_row = next(r for r in vm["rows"] if r["label"] == "Rent")
    assert rent_row["y1"]["raw"] == 150000.0
    assert rent_row["y2"]["raw"] == 154500.0
    deposit = next(c for c in vm["startupCosts"]
                   if c["category"].startswith("Lease Deposit"))
    assert deposit["amount"]["raw"] == 37500.0
    assert deposit["amount"]["display"] == "$37,500"
    assert vm["model_version"] == "2.7.0"

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
    assert vm["model_version"] == "3.1.0"
    # Model v3 (3.0.0): the displayed Year-1 Net income subtracts the one-time
    # startup. Card fees' two-term formula + Workers' comp + POS platform/Production
    # software push the operating loss deeper, so the cash Y1 net moves from
    # −$292,214 (2.9.0) to −$303,568.
    net = next(r for r in vm["rows"] if r["label"] == "Net income")
    assert round(net["y1"]["raw"]) == -303568


def test_canonical_reco_text_consistent_with_breakeven_metric():
    # #142 regression guard at the FROZEN-FIXTURE layer: the reco text and the
    # break-even metric can never disagree. From 3.1.0 (owner 2026-10-08: monthly net
    # never drops) plus the owner's "Full 60 months" call, the canonical base case
    # breaks even at Month 37 but the downside never does: do_not_proceed, and the
    # text must scope the failure to the downside, never claim the base is unreached.
    # (2.7.0-2.9.0: raise_cash with a Month-8 break-even.)
    from engine.tests.test_decision import assert_breakeven_text_consistent
    vm = _load("house_of_hope_canonical_60.json")
    assert vm["metrics"]["breakeven"]["raw"] == 37
    assert vm["reco"]["tag"] == "do_not_proceed"
    assert_breakeven_text_consistent(vm)
    assert "downside" in vm["metrics"]["reasonBreakeven"].lower()


def test_design_parity_reproduces_headline(design_parity_result):
    vm = _load("house_of_hope_design_parity_40.json")
    # FUSION: DISPLAY layer is cash (2.7.0-A) — the Year-1 Net margin ROW is dragged negative
    # by the one-time startup hit even though the OPERATING margin is positive. OPERATING layer
    # is the branch's 6.2/990 distribution (2.7.0-B): break-even month 6 (was 5 pre-990), reco
    # raise_cash (capital $302,238 > the $300k design-parity funds by $2,238 — an OWNER-VISIBLE
    # flip from the prototype "proceed", flagged for the reviewer), operating margin ~9.0% (990
    # constants lowered it from the pre-990 ~11% prototype headline). The DISPLAYED cash net and
    # the Month-N payback are re-pinned to fused values in step 3.
    assert vm["rows"][-1]["y1"]["raw"] < 0                       # displayed (cash) Net margin
    # Model v3 (3.0.0): cash Y1 net moves from −$199,995 (2.9.0) to −$209,642 — the
    # card-fee two-term formula + Workers' comp + POS platform/Production software
    # deepen the operating loss before the startup subtraction.
    assert round(next(r for r in vm["rows"] if r["label"] == "Net income")["y1"]["raw"]) == -209642
    # 3.1.0 (owner 2026-10-08: monthly net never drops): the eased Year 1 breaks even
    # at month 4 (was 6) and its capital drops under the $300k funds.
    assert vm["breakevenMonth"] == 4                            # OPERATING (eased Y1)
    # "Full 60 months" (owner 2026-10-08): the downside breaks even at month 25, so
    # the verdict is proceed.
    assert vm["reco"]["tag"] == "proceed"
    # Month-N payback recomputes over the 60-month series. Model v3's extra cost lines
    # push the crossing from Month 32 (2.9.0) to Month 34; the 3.1.0 ease moves cash
    # within years, not across them, so it stays Month 34.
    assert vm["milestones"]["payback"]["raw"] == 34
    op_margin = float(design_parity_result.annual[1].margin)
    assert 0.06 < op_margin < 0.08                              # ~6.8% operating (Model v3)


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
    # FUSION: the §12.2 net-margin guardrail runs on the DISPLAYED (cash) margin (2.7.0-A).
    # The Year-1 cash margin is dragged down to ~8.9% by the one-time startup, so the >30%
    # flag no longer fires on Y1 — it fires on the steady-state LATE years (Y4/Y5, where
    # cash == operating and the aggressive margin is ~37%). The guardrail still fires (spec
    # §6); the share (>8%) guardrail fires on Y1 as before.
    assert flags["net_margin_y4_out_of_band"]["requires_note"] is True
    assert flags["net_margin_y5_out_of_band"]["requires_note"] is True
    assert flags["share_y1_out_of_band"]["requires_note"] is True
    # The late-year (steady-state) margin is above the ~30% band; verdict is "revise".
    assert vm["rows"][-1]["y4"]["raw"] > 0.30
    assert vm["reco"]["tag"] == "revise"
    assert vm["model_version"] == "3.1.0"


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
    assert vm["model_version"] == "3.1.0"


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
    assert vm["model_version"] == "3.1.0"

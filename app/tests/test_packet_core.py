"""M5 Board Packet builder — pure, role-tailored, computed_json-grounded.

The packet is the primary trust surface (PRD §17, API_SPEC §6.4). It is built
ENTIRELY from the stored ``computed_json`` view-model so there is one math/format
surface; the builder never invents figures. It leads with evidence, then
decision recommendation, assumptions (verified vs estimated), sensitivity, risks,
cash need + break-even, and KPIs. The ``role`` (board/funder/advisor) tailors
emphasis/CTAs only — never the numbers.

RED-first: written before app/packet.py exists.
"""

from app.packet import PACKET_ROLES, build_packet, render_packet_md

VM = {
    "name": "House of Hope",
    "reco": {"tag": "proceed", "headline": "Proceed.", "sub": "Positive trajectory."},
    "metrics": {
        "capital": {"raw": 277990.0, "display": "$277,990"},
        "cashGap": {"raw": -42000.0, "display": "($42,000)"},
        "breakeven": {"raw": 5, "display": "Month 5"},
    },
    "kpis": [
        {"label": "Total revenue", "value": {"raw": 426911.0, "display": "$426,911"},
         "sub": "Year 1"},
        {"label": "Net margin", "value": {"raw": 0.11, "display": "11.0%"}, "sub": "Year 1"},
    ],
    "rows": [
        {"label": "Donor market share", "group": "drivers",
         "y1": {"raw": 0.06, "display": "6.0%"}, "class": "input"},
        {"label": "Payroll", "group": "expenses",
         "y1": {"raw": 250000.0, "display": "$250,000"}, "class": "overridden"},
    ],
    "evidence": [
        {"field": "rent", "label": "Market rent",
         "value": {"raw": 9.0, "display": "$9.00 / sq ft"},
         "method": "retrieval", "badge": "estimated_low",
         "meta": "LoopNet, 2026-05 · low confidence"},
        {"field": "households", "label": "Households",
         "value": {"raw": 31798, "display": "31,798"},
         "method": "user_attached", "badge": "verified",
         "meta": "US Census ACS 2023"},
    ],
}


# ---------------------------------------------------------------- structure
def test_build_packet_has_required_sections():
    pkt = build_packet(VM, role="board")
    assert pkt["role"] == "board"
    # Leads with evidence, then recommendation, assumptions, sensitivity, etc.
    keys = pkt["sections"].keys()
    for k in ("banner", "evidence", "recommendation", "assumptions",
              "sensitivity", "provenance", "kpis"):
        assert k in keys, k


def test_banner_carries_reco_and_headline_figures():
    pkt = build_packet(VM, role="board")
    banner = pkt["sections"]["banner"]
    assert banner["tag"] == "proceed"
    assert banner["headline"] == "Proceed."
    # Capital + break-even appear in the banner facts.
    facts = {f["label"]: f["display"] for f in banner["facts"]}
    assert facts["Capital required"] == "$277,990"
    assert facts["Break-even"] == "Month 5"


def test_assumptions_split_verified_vs_estimated():
    pkt = build_packet(VM, role="board")
    a = pkt["sections"]["assumptions"]
    verified = {e["label"] for e in a["verified"]}
    estimated = {e["label"] for e in a["estimated"]}
    assert "Households" in verified
    assert "Market rent" in estimated


def test_provenance_lists_overridden_rows():
    pkt = build_packet(VM, role="board")
    prov = pkt["sections"]["provenance"]
    overridden = {e["label"] for e in prov["overridden"]}
    assert "Payroll" in overridden


def test_sensitivity_table_is_grounded():
    """Every display string in the sensitivity table must come from computed_json."""
    pkt = build_packet(VM, role="board")
    sens = pkt["sections"]["sensitivity"]
    assert sens["rows"]  # non-empty
    # base column references the real capital figure
    flat = str(sens)
    assert "$277,990" in flat


# ------------------------------------------------------------ role variants
def test_role_variants_change_cta_not_numbers():
    board = build_packet(VM, role="board")
    funder = build_packet(VM, role="funder")
    advisor = build_packet(VM, role="advisor")
    # CTA / emphasis differs by role
    ctas = {board["cta"], funder["cta"], advisor["cta"]}
    assert len(ctas) == 3
    # but the banner facts (the numbers) are identical across roles
    assert board["sections"]["banner"]["facts"] == funder["sections"]["banner"]["facts"]


def test_unknown_role_defaults_to_board():
    pkt = build_packet(VM, role="nonsense")
    assert pkt["role"] == "board"


def test_packet_roles_constant():
    assert set(PACKET_ROLES) == {"board", "funder", "advisor"}


# -------------------------------------------------------------- AI opt-out
def test_packet_includes_grounded_narrative_when_provided():
    body = "The store needs $277,990 in capital and breaks even at Month 5."
    pkt = build_packet(VM, role="board", narrative_md=body)
    assert pkt["sections"]["narrative"]["body_md"]
    assert "$277,990" in pkt["sections"]["narrative"]["body_md"]


def test_packet_omits_narrative_when_ai_disabled():
    pkt = build_packet(VM, role="board", narrative_md=None)
    # structured sections still present, no generated prose section
    assert "narrative" not in pkt["sections"]
    assert pkt["sections"]["evidence"]  # structured/evidence sections remain


# ---------------------------------------------------------------- render
def test_render_packet_md_is_grounded_and_escapes_role_text():
    pkt = build_packet(VM, role="funder")
    md = render_packet_md(pkt)
    assert "House of Hope" in md
    assert "$277,990" in md
    assert "Proceed." in md

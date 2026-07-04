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

# schema >= 1.6.0 (task 3.3, audit P0): the §12.2 base/downside/upside stress
# scenarios decision.py already computed but the view-model previously dropped.
# A packet built from this VM must render all three columns, grounded verbatim.
VM_SENSITIVITY = {
    **VM,
    "sensitivity": {
        "base": {"net": {"raw": 46900.0, "display": "$46,900"}, "breakeven": 5,
                  "capital": {"raw": 277990.0, "display": "$277,990"}},
        "downside": {"net": {"raw": -12000.0, "display": "($12,000)"}, "breakeven": None,
                     "capital": {"raw": 312000.0, "display": "$312,000"}},
        "upside": {"net": {"raw": 98000.0, "display": "$98,000"}, "breakeven": 4,
                   "capital": {"raw": 250000.0, "display": "$250,000"}},
        "delta": 0.25,
    },
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


def test_sensitivity_table_has_base_downside_upside_columns_when_block_present():
    """task 3.3: schema >= 1.6.0 -- the packet must surface the FULL base/downside/
    upside comparison the engine already computed, not a base-case-only table."""
    pkt = build_packet(VM_SENSITIVITY, role="board")
    sens = pkt["sections"]["sensitivity"]
    assert sens["columns"] == ["Driver", "Base case", "Downside", "Upside"]
    flat = str(sens)
    assert "$46,900" in flat    # base net
    assert "($12,000)" in flat  # downside net
    assert "$98,000" in flat    # upside net
    assert "$312,000" in flat   # downside capital
    assert "$250,000" in flat   # upside capital
    assert "Not reached" in flat  # downside breakeven is null -- never a misleading 0/blank


def test_sensitivity_table_keeps_the_disclaimer_row():
    """The ± stress disclaimer row must survive the redesign and travel into the
    rendered markdown packet (a board reader must see what "downside" means)."""
    pkt = build_packet(VM_SENSITIVITY, role="board")
    sens = pkt["sections"]["sensitivity"]
    assert sens.get("disclaimer")
    assert "25%" in sens["disclaimer"]  # sourced from sensitivity.delta, not hard-coded prose
    md = render_packet_md(pkt)
    assert sens["disclaimer"] in md


def test_sensitivity_table_legacy_snapshot_falls_back_cleanly():
    """A pre-1.6.0 snapshot (no vm['sensitivity']) must still render the prior
    base-case-only table -- never crash, never fabricate downside/upside figures."""
    pkt = build_packet(VM, role="board")
    sens = pkt["sections"]["sensitivity"]
    assert sens["columns"] == ["Driver", "Base case", "Note"]
    assert "disclaimer" not in sens


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


# ------------------------------------------------ #192 export disclaimer + AI disclosure
from app.packet import render_packet_docx  # noqa: E402
from app.terms import TERMS_VERSION  # noqa: E402
from engine.model import AI_NARRATIVE_DISCLOSURE, EXPORT_DISCLAIMER  # noqa: E402


def _docx_text(data: bytes) -> str:
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read("word/document.xml").decode("utf-8")


def test_packet_has_disclaimer_section_with_terms_version():
    # #192: the "planning estimates, not advice" caveat the terms gate exists to
    # protect must be a structured, server-owned section of the packet.
    pkt = build_packet(VM, role="board", terms_accepted_at="2026-06-27T12:00:00Z")
    d = pkt["sections"]["disclaimer"]
    assert d["body"] == EXPORT_DISCLAIMER
    assert d["terms_version"] == TERMS_VERSION
    assert d["terms_accepted_at"] == "2026-06-27T12:00:00Z"


def test_render_md_always_carries_planning_estimates_disclaimer():
    # The footer is present whether or not AI is enabled / a date is known.
    md = render_packet_md(build_packet(VM, role="board"))
    assert EXPORT_DISCLAIMER in md
    assert f"Terms v{TERMS_VERSION}" in md


def test_render_md_stamps_terms_accepted_date_when_known():
    pkt = build_packet(VM, role="board", terms_accepted_at="2026-06-27T12:00:00Z")
    md = render_packet_md(pkt)
    assert "2026-06-27" in md


def test_render_md_discloses_ai_when_narrative_present():
    # #192: when AI prose is injected, the packet must disclose it was AI-drafted.
    body = "The store needs $277,990 in capital and breaks even at Month 5."
    md = render_packet_md(build_packet(VM, role="board", narrative_md=body))
    assert AI_NARRATIVE_DISCLOSURE in md
    assert body in md  # the prose itself still travels


def test_render_md_omits_ai_disclosure_when_no_narrative():
    # No AI prose -> no AI-disclosure line (it would be misleading), but the
    # planning-estimates disclaimer is still present.
    md = render_packet_md(build_packet(VM, role="board", narrative_md=None))
    assert AI_NARRATIVE_DISCLOSURE not in md
    assert EXPORT_DISCLAIMER in md


def test_render_docx_carries_disclaimer_and_ai_disclosure():
    # The .docx reuses the markdown line source, so the same caveats travel into the
    # document a board actually opens (#192).
    pkt = build_packet(VM, role="board", narrative_md="Capital is $277,990.",
                       terms_accepted_at="2026-06-27T12:00:00Z")
    text = _docx_text(render_packet_docx(pkt))
    assert EXPORT_DISCLAIMER in text
    assert f"Terms v{TERMS_VERSION}" in text
    assert AI_NARRATIVE_DISCLOSURE in text


def test_render_docx_flattens_sanitized_html_in_narrative():
    # narrative `body_md` is allowlist-sanitized HTML (the client renders it via
    # innerHTML), so it can carry <p>/<strong> tags. The .docx body is plain
    # OOXML runs — a board must never see a literal "<p>" in Word. The render
    # flattens those tags to text while keeping the grounded figure verbatim.
    body = "<p>The store needs <strong>$277,990</strong> in capital.</p>"
    pkt = build_packet(VM, role="board", narrative_md=body)
    text = _docx_text(render_packet_docx(pkt))
    # The tag markup is gone (no literal angle-bracket tags reach the reader)...
    assert "<p>" not in text
    assert "</p>" not in text
    assert "<strong>" not in text
    # ...but the prose and its grounded figure survive intact.
    assert "The store needs" in text
    assert "$277,990" in text


def test_render_docx_leaves_tag_free_markdown_lines_untouched():
    # The flatten guard only fires on lines that actually contain HTML tags;
    # ordinary markdown (no tags) passes through verbatim so the existing
    # disclaimer/figure content is unaffected by the narrative-HTML handling.
    pkt = build_packet(VM, role="board", narrative_md="Capital is $277,990.")
    text = _docx_text(render_packet_docx(pkt))
    assert "Capital is $277,990." in text
    assert EXPORT_DISCLAIMER in text

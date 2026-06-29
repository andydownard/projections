"""EPIC DOCX — the python-docx 2-page Board Packet (app/packet.py::render_packet_docx).

The .docx is the board's primary trust artifact, so these tests are adversarial,
not happy-path: every figure in the document must exist verbatim in computed_json
(LLM-GROUNDING / Regression #5), a RAW float must never leak into the prose or a
table cell, the income statement must be YEAR-COUNT-AGNOSTIC (a legacy 3-year
snapshot renders three columns, a 5-year snapshot five) and accept the current
"Net income" label OR the legacy "Net profit", and with all AI keys unset the
packet must STILL render fully via a deterministic, grounded fallback (PRD §16/§21).

The 5-year VM is the canonical golden fixture (real engine output) so the test can
never drift from the engine; the legacy 3-year VM is hand-built to exercise the
"Net profit" + no-startupCosts (pre-schema-1.5.0) paths.
"""
import io
import json
import pathlib

import docx

from app.narrative import (
    _norm,
    extract_figures,
    grounded_figures,
    validate_grounding,
)
from app.packet import build_packet, render_packet_docx
from app.terms import TERMS_VERSION
from engine.model import AI_NARRATIVE_DISCLOSURE, EXPORT_DISCLAIMER

_GOLDEN = pathlib.Path(__file__).resolve().parents[2] / "engine/tests/golden"


def _vm5() -> dict:
    """The canonical 5-year view-model (real engine output) + a name."""
    vm = json.loads((_GOLDEN / "house_of_hope_canonical_60.json").read_text())
    vm["name"] = "House of Hope"
    return vm


# A legacy 3-year snapshot: only y1..y3, the OLD "Net profit" bottom line, and NO
# startupCosts/startupTotal (predates schema 1.5.0). Self-consistent figures.
VM3_LEGACY = {
    "name": "Legacy Thrift",
    "reco": {"tag": "proceed", "headline": "Proceed.", "sub": "Positive trajectory."},
    "metrics": {
        "capital": {"raw": 200000.0, "display": "$200,000"},
        "cashGap": {"raw": -30000.0, "display": "($30,000)"},
        "breakeven": {"raw": 6, "display": "Month 6"},
        "reasonBreakeven": "First month operating net turns and stays non-negative.",
    },
    "kpis": [
        {"label": "Total revenue", "value": {"raw": 400000.0, "display": "$400,000"},
         "sub": "Year 1"},
        {"label": "Net income", "value": {"raw": 50000.0, "display": "$50,000"},
         "sub": "Year 1"},
        {"label": "Net margin", "value": {"raw": 0.125, "display": "12.5%"},
         "sub": "Year 1"},
        {"label": "Payback period", "value": {"raw": 30, "display": "Month 30"},
         "sub": "to recover startup"},
    ],
    "rows": [
        {"label": "Retail Sales", "group": "revenue",
         "y1": {"raw": 396000.0, "display": "$396,000"},
         "y2": {"raw": 410000.0, "display": "$410,000"},
         "y3": {"raw": 420000.0, "display": "$420,000"}},
        {"label": "Salvage Sales", "group": "revenue",
         "y1": {"raw": 4000.0, "display": "$4,000"},
         "y2": {"raw": 4100.0, "display": "$4,100"},
         "y3": {"raw": 4200.0, "display": "$4,200"}},
        {"label": "Total Revenue", "group": "revenue",
         "y1": {"raw": 400000.0, "display": "$400,000"},
         "y2": {"raw": 414100.0, "display": "$414,100"},
         "y3": {"raw": 424200.0, "display": "$424,200"}},
        {"label": "Payroll", "group": "expenses",
         "y1": {"raw": 200000.0, "display": "$200,000"},
         "y2": {"raw": 206000.0, "display": "$206,000"},
         "y3": {"raw": 212000.0, "display": "$212,000"}},
        {"label": "Rent", "group": "expenses",
         "y1": {"raw": 120000.0, "display": "$120,000"},
         "y2": {"raw": 123600.0, "display": "$123,600"},
         "y3": {"raw": 127308.0, "display": "$127,308"}},
        {"label": "Total Expenses", "group": "expenses",
         "y1": {"raw": 350000.0, "display": "$350,000"},
         "y2": {"raw": 360000.0, "display": "$360,000"},
         "y3": {"raw": 370000.0, "display": "$370,000"}},
        {"label": "Net profit", "group": "expenses",   # LEGACY label
         "y1": {"raw": 50000.0, "display": "$50,000"},
         "y2": {"raw": 54100.0, "display": "$54,100"},
         "y3": {"raw": 54200.0, "display": "$54,200"}},
    ],
    "evidence": [],
    # NOTE: no startupCosts / startupTotal (legacy < 1.5.0).
}


# ----------------------------------------------------------------- helpers
def _open(data: bytes) -> docx.document.Document:
    return docx.Document(io.BytesIO(data))


def _all_text(data: bytes) -> str:
    """Every paragraph + table cell string in the rendered .docx, joined."""
    doc = _open(data)
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


def _raw_floats(vm: dict) -> set[str]:
    """Every RAW numeric value in the view-model, as str() — none may appear."""
    out: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            if "raw" in node and isinstance(node["raw"], float):
                out.add(str(node["raw"]))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(vm)
    return out


# ----------------------------------------------------------- T1 valid docx
def test_render_produces_a_valid_openable_docx():
    data = render_packet_docx(build_packet(_vm5(), role="board"))
    assert isinstance(data, bytes) and len(data) > 0
    doc = _open(data)                       # raises if not a valid OOXML package
    assert doc.tables, "the packet must carry real tables"


# ----------------------------------------------------- T2 year-count-agnostic
def test_five_year_vm_renders_five_year_columns():
    text = _all_text(render_packet_docx(build_packet(_vm5())))
    for label in ("Year 1", "Year 2", "Year 3", "Year 4", "Year 5"):
        assert label in text, label


def test_legacy_three_year_vm_renders_three_columns_only():
    text = _all_text(render_packet_docx(build_packet(VM3_LEGACY)))
    for label in ("Year 1", "Year 2", "Year 3"):
        assert label in text, label
    assert "Year 4" not in text
    assert "Year 5" not in text


# ------------------------------------------------- T3 Net income / Net profit
def test_net_income_label_renders_in_five_year_statement():
    text = _all_text(render_packet_docx(build_packet(_vm5())))
    assert "Net income" in text
    assert "Net profit" not in text


def test_legacy_net_profit_label_still_renders():
    # A pre-rename snapshot stored "Net profit" as its bottom line — it must still
    # foot/print (year-count-agnostic + label-agnostic bottom line).
    text = _all_text(render_packet_docx(build_packet(VM3_LEGACY)))
    assert "Net profit" in text
    assert "$50,000" in text   # the legacy net-profit figure


def test_income_statement_section_flags_bottom_line():
    stmt5 = build_packet(_vm5())["sections"]["income_statement"]
    assert stmt5["years"] == ["y1", "y2", "y3", "y4", "y5"]
    nets = [r for r in stmt5["rows"] if r["is_net"]]
    assert [n["label"] for n in nets] == ["Net income"]
    # subtotals + the bottom line are bold; the Net-margin percent row is excluded.
    bold = {r["label"] for r in stmt5["rows"] if r["bold"]}
    assert {"Total Revenue", "Total Expenses", "Net income"} <= bold
    assert all(r["label"] != "Net margin" for r in stmt5["rows"])

    stmt3 = build_packet(VM3_LEGACY)["sections"]["income_statement"]
    assert stmt3["years"] == ["y1", "y2", "y3"]
    assert [r["label"] for r in stmt3["rows"] if r["is_net"]] == ["Net profit"]


# ------------------------------------------------------- T7 startup costs
def test_startup_costs_section_present_with_total():
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm)))
    assert "One-Time Startup Costs" in text
    assert "Lease Deposit + First Month Rent" in text
    assert vm["startupTotal"]["display"] in text          # "$238,500"
    # build_packet section carries the structured items + total.
    sc = build_packet(vm)["sections"]["startup_costs"]
    assert len(sc["items"]) == len(vm["startupCosts"])
    assert sc["total"] == vm["startupTotal"]["display"]


def test_startup_costs_gracefully_absent_on_legacy_vm():
    # A pre-1.5.0 snapshot has no startupCosts — render must not crash and must
    # still produce a valid, complete document.
    sc = build_packet(VM3_LEGACY)["sections"]["startup_costs"]
    assert sc == {"items": [], "total": ""}
    text = _all_text(render_packet_docx(build_packet(VM3_LEGACY)))
    assert "One-Time Startup Costs" in text       # heading still present
    assert "not available" in text.lower()        # graceful fallback line


# -------------------------------------------------- T4 disclaimer + terms + AI
def test_disclaimer_terms_and_ai_disclosure_are_stamped():
    body = "Capital is $321,940."   # grounded against VM5 (capital display)
    data = render_packet_docx(build_packet(
        _vm5(), role="board", narrative_md=body,
        terms_accepted_at="2026-06-27T12:00:00Z"))
    text = _all_text(data)
    assert EXPORT_DISCLAIMER in text
    assert f"Terms v{TERMS_VERSION}" in text
    assert "2026-06-27" in text
    assert AI_NARRATIVE_DISCLOSURE in text


# --------------------------------------------------- T5 strips narrative HTML
def test_narrative_html_is_flattened_not_shown_literally():
    body = "<p>The store needs <strong>$321,940</strong> in capital.</p>"
    text = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md=body)))
    assert "<p>" not in text and "</p>" not in text and "<strong>" not in text
    assert "The store needs" in text
    assert "$321,940" in text


# ----------------------------------------------- T6 AI-off fallback renders full
def test_ai_off_fallback_renders_a_full_packet():
    # narrative_md=None => the deterministic, grounded fallback. The document is
    # still complete: exec summary + both tables + disclaimer; and it discloses NO
    # AI authorship (the fallback is not AI-drafted).
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm, narrative_md=None)))
    assert "Executive summary" in text
    assert vm["kpis"][0]["value"]["display"] in text       # Total revenue -> exec summary
    assert "Projected Income Statement" in text
    assert "Total Revenue" in text and "Net income" in text
    assert "One-Time Startup Costs" in text
    assert vm["startupTotal"]["display"] in text
    assert EXPORT_DISCLAIMER in text
    assert AI_NARRATIVE_DISCLOSURE not in text              # no AI prose => no disclosure


# ------------------------------------------- T8 adversarial: no RAW float leaks
def test_no_raw_float_ever_appears_in_the_document():
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm, narrative_md=None)))
    leaks = [f for f in _raw_floats(vm) if f in text]
    assert not leaks, f"raw float(s) leaked into the .docx: {leaks}"
    # spot-check the headline raw values explicitly.
    assert "321939.7347072" not in text     # capital raw
    assert "426937.75488" not in text       # total revenue raw
    assert "238500.0" not in text           # startupTotal raw


# ------------------------------------------------- grounding (LLM-GROUNDING #5)
def test_every_figure_in_the_document_is_grounded_in_computed_json():
    # The strongest grounding guarantee: extract EVERY money/percent figure that
    # appears anywhere in the rendered fallback document and assert each one exists
    # in computed_json. The AI-off path is fully deterministic, so this proves the
    # packet cannot invent a figure (Regression #5).
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm, narrative_md=None)))
    # Does not raise GroundingError.
    validate_grounding(text, vm)
    approved = grounded_figures(vm)
    ungrounded = [f for f in extract_figures(text) if _norm(f) not in approved]
    assert not ungrounded, f"ungrounded figures in .docx: {ungrounded}"


def test_fallback_exec_summary_is_grounded_by_construction():
    # Even the deterministic fallback prose (no stored narrative) only concatenates
    # computed_json display strings, so validate_grounding must pass.
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm, narrative_md=None)))
    assert vm["metrics"]["capital"]["display"] in text     # "$321,940"
    validate_grounding(text, vm)

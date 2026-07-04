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
from app.packet import (
    _banner_fact,
    _exec_summary_fallback,
    _growth_sentence,
    _has_value,
    _income_statement,
    _interpretation_para,
    _kpi_disp,
    _performance_sentence,
    _present_year_keys,
    _startup_costs_section,
    build_packet,
    render_packet_docx,
)
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
    body = "Capital is $347,854."   # grounded against VM5 (capital display)
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
    body = "<p>The store needs <strong>$347,854</strong> in capital.</p>"
    text = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md=body)))
    assert "<p>" not in text and "</p>" not in text and "<strong>" not in text
    assert "The store needs" in text
    assert "$347,854" in text


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
    assert "347853.76208215486" not in text     # capital raw
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
    assert vm["metrics"]["capital"]["display"] in text     # "$347,854"
    validate_grounding(text, vm)


# ===================================================================
# Helper-level unit tests (the pure section/prose builders the renderer
# composes). These pin the grounded-by-construction guarantees BEFORE the
# document layer so a regression is caught at the smallest surface.
# ===================================================================
def _document_xml(data: bytes) -> str:
    """The raw word/document.xml of the rendered .docx (for low-level OOXML checks)."""
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read("word/document.xml").decode("utf-8")


# A minimal 1-year view-model: drives the growth-sentence qualitative fallback
# (no out-years, no CAGR, no net-income row) and the startup graceful-absence path.
VM_MINIMAL = {
    "name": "Tiny Store",
    "reco": {"tag": "revise", "headline": "Revise.", "sub": "Out-of-band."},
    "metrics": {"capital": {"raw": 0.0, "display": "$0"},
                "cashGap": {"raw": 0.0, "display": "$0"},
                "breakeven": {"raw": None, "display": "N/A"}},
    "kpis": [{"label": "Total revenue",
              "value": {"raw": 10000.0, "display": "$10,000"}, "sub": "Year 1"}],
    "rows": [{"label": "Payroll", "group": "expenses",
              "y1": {"raw": 6000.0, "display": "$6,000"}}],
    "evidence": [],
}


# ---- _present_year_keys
def test_present_year_keys_five_year_vm():
    assert _present_year_keys(_vm5()["rows"]) == ["y1", "y2", "y3", "y4", "y5"]


def test_present_year_keys_three_year_vm():
    assert _present_year_keys(VM3_LEGACY["rows"]) == ["y1", "y2", "y3"]


def test_present_year_keys_single_year_vm():
    assert _present_year_keys(VM_MINIMAL["rows"]) == ["y1"]


# ---- _income_statement
def test_income_statement_headers_are_year_labelled():
    stmt = _income_statement(_vm5())
    assert stmt["headers"] == [
        "Line item", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"]


def test_income_statement_three_year_headers():
    stmt = _income_statement(VM3_LEGACY)
    assert stmt["headers"] == ["Line item", "Year 1", "Year 2", "Year 3"]


def test_income_statement_excludes_percent_margin_row():
    # The income statement is a DOLLAR table — the percent "Net margin" line that
    # lives in the view-model rows must never appear as a money line item.
    labels = [r["label"] for r in _income_statement(_vm5())["rows"]]
    assert "Net margin" not in labels
    assert "Total Revenue" in labels and "Net income" in labels


def test_income_statement_only_revenue_and_expense_groups():
    # Driver rows (donor share, donating households, ...) are NOT income-statement
    # lines; only the revenue + expense groups make the financial statement.
    stmt = _income_statement(_vm5())
    drivers = {"Donor market share", "Donating households",
               "Annual donations", "Customers"}
    assert not (drivers & {r["label"] for r in stmt["rows"]})


def test_income_statement_cells_match_view_model_rows_exactly():
    # Every printed cell is the verbatim display string from computed_json (no
    # re-formatting / re-derivation in the packet layer).
    vm = _vm5()
    stmt = _income_statement(vm)
    by_label = {r["label"]: r for r in vm["rows"]}
    years = stmt["years"]
    for item in stmt["rows"]:
        src = by_label[item["label"]]
        assert item["cells"] == [src[k]["display"] for k in years]


def test_income_statement_marks_subtotals_and_bottom_line_bold():
    stmt = _income_statement(_vm5())
    bold = {r["label"] for r in stmt["rows"] if r["bold"]}
    assert {"Total Revenue", "Total Expenses", "Net income"} <= bold
    # an ordinary component line (Payroll) is NOT bold
    assert not next(r for r in stmt["rows"] if r["label"] == "Payroll")["bold"]


def test_income_statement_legacy_net_profit_is_the_bottom_line():
    stmt = _income_statement(VM3_LEGACY)
    nets = [r for r in stmt["rows"] if r["is_net"]]
    assert [n["label"] for n in nets] == ["Net profit"]
    assert nets[0]["bold"] is True


# ---- _startup_costs_section
def test_startup_costs_section_items_match_view_model():
    vm = _vm5()
    sc = _startup_costs_section(vm)
    assert [i["category"] for i in sc["items"]] == \
        [c["category"] for c in vm["startupCosts"]]
    assert [i["amount"] for i in sc["items"]] == \
        [c["amount"]["display"] for c in vm["startupCosts"]]
    assert sc["total"] == vm["startupTotal"]["display"]


def test_startup_costs_section_empty_on_pre_1_5_0_snapshot():
    assert _startup_costs_section(VM3_LEGACY) == {"items": [], "total": ""}
    assert _startup_costs_section(VM_MINIMAL) == {"items": [], "total": ""}


# ---- accessors + fallback prose (grounded by construction)
def test_kpi_disp_and_banner_fact_read_display_strings():
    pkt = build_packet(_vm5())
    assert _kpi_disp(pkt, "Total revenue") == "$426,938"
    assert _kpi_disp(pkt, "Missing KPI") == ""
    assert _banner_fact(pkt, "Capital required") == "$347,854"
    assert _banner_fact(pkt, "Missing fact") == ""


def test_has_value_treats_na_and_empty_as_absent():
    assert _has_value("$347,854") is True
    assert _has_value("N/A") is False
    assert _has_value("—") is False
    assert _has_value("") is False


def test_exec_summary_fallback_is_grounded_and_floatless():
    vm = _vm5()
    text = _exec_summary_fallback(build_packet(vm, narrative_md=None))
    # only display strings -> every figure traces to computed_json
    for f in extract_figures(text):
        assert _norm(f) in grounded_figures(vm), f
    assert "House of Hope" in text
    assert "347853.76208215486" not in text          # never the raw float


def test_exec_summary_fallback_omits_breakeven_when_na():
    # A do_not_proceed/N-A break-even must not be claimed as a reached milestone.
    pkt = build_packet(VM_MINIMAL, narrative_md=None)
    text = _exec_summary_fallback(pkt)
    assert "break-even" not in text.lower()      # breakeven display is "N/A" here
    assert "$10,000" in text                      # but the revenue figure is used


def test_performance_sentence_grounded_year_one():
    # CASH basis (epic #321): the grounded Year-1 net income includes the one-time
    # startup hit (operating −$44,433 − $238,500 startup = −$282,933), sourced from the
    # cash-based "Net income" surface — so the packet sentence reads the board's cash reality.
    vm = _vm5()
    text = _performance_sentence(build_packet(vm))
    assert "$426,938" in text and "($282,933)" in text  # FUSION: re-pin to fused cash Y1 net (step 3)
    for f in extract_figures(text):
        assert _norm(f) in grounded_figures(vm), f


def test_growth_sentence_uses_final_year_net_income():
    vm = _vm5()
    text = _growth_sentence(build_packet(vm))
    assert "Year 5" in text
    assert "$35,612" in text          # the Year-5 net income (bottom-line last cell)
    assert "18.9%" in text            # the Revenue CAGR (revenue-only -> unchanged)


def test_growth_sentence_qualitative_fallback_without_out_years():
    # A single-year VM with no out-year net income / CAGR falls back to a
    # NON-numeric market sentence (so it can never assert an ungrounded figure).
    text = _growth_sentence(build_packet(VM_MINIMAL))
    assert not extract_figures(text)
    assert "secondhand" in text.lower()


def test_interpretation_para_payback_not_reached_branch():
    # VM5's payback is N/A (loss case) -> the "not reached" wording, capital only.
    vm = _vm5()
    text = _interpretation_para(build_packet(vm))
    assert "$347,854" in text
    assert "not reached" in text.lower()
    for f in extract_figures(text):
        assert _norm(f) in grounded_figures(vm), f


def test_interpretation_para_payback_reached_branch():
    # VM3 has a reached payback ("Month 30") -> the "recovered by" wording.
    text = _interpretation_para(build_packet(VM3_LEGACY))
    assert "$200,000" in text
    assert "recovered by Month 30" in text


# ===================================================================
# Rendered-document structure (section presence, column counts, page break,
# AI-on vs AI-off branch selection, role-invariance of the numbers).
# ===================================================================
_SECTION_HEADINGS = (
    "Executive summary",
    "Projected Performance:",
    "Growth Potential:",
    "Projected Income Statement",
    "One-Time Startup Costs",
    "Interpretation",
)


def test_document_contains_every_named_section():
    text = _all_text(render_packet_docx(build_packet(
        _vm5(), terms_accepted_at="2026-06-27T12:00:00Z")))
    for heading in _SECTION_HEADINGS:
        assert heading in text, heading
    assert EXPORT_DISCLAIMER in text
    assert f"Terms v{TERMS_VERSION}" in text


def test_income_table_column_count_tracks_year_count():
    doc5 = _open(render_packet_docx(build_packet(_vm5())))
    # the income statement is the first table; 1 label col + 5 year cols
    assert len(doc5.tables[0].columns) == 6
    doc3 = _open(render_packet_docx(build_packet(VM3_LEGACY)))
    assert len(doc3.tables[0].columns) == 4


def test_income_table_bottom_line_prints_every_year_cell():
    vm = _vm5()
    text = _all_text(render_packet_docx(build_packet(vm)))
    net_row = next(r for r in vm["rows"] if r["label"] == "Net income")
    for k in ("y1", "y2", "y3", "y4", "y5"):
        assert net_row[k]["display"] in text


def test_startup_table_has_total_row_with_label():
    vm = _vm5()
    doc = _open(render_packet_docx(build_packet(vm)))
    startup = doc.tables[-1]
    last = [c.text for c in startup.rows[-1].cells]
    assert last[0] == "Total one-time startup"
    assert last[1] == vm["startupTotal"]["display"]


def test_document_has_a_page_break_between_the_two_pages():
    xml = _document_xml(render_packet_docx(build_packet(_vm5())))
    assert 'w:type="page"' in xml          # an explicit hard page break exists


def test_ai_on_renders_stored_narrative_not_the_fallback():
    body = "<p>House of Hope is on track for $426,938 in first-year revenue.</p>"
    text = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md=body)))
    assert "on track for" in text                       # the stored prose
    assert "is projected to generate" not in text       # the fallback phrase is gone
    assert AI_NARRATIVE_DISCLOSURE in text              # AI authorship disclosed


def test_ai_off_renders_the_fallback_not_a_stored_narrative():
    text = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md=None)))
    assert "is projected to generate" in text           # the deterministic fallback
    assert AI_NARRATIVE_DISCLOSURE not in text          # nothing AI-drafted to disclose


def test_ai_disclosure_strictly_tracks_narrative_presence():
    on = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md="Hi $347,854.")))
    off = _all_text(render_packet_docx(build_packet(_vm5(), narrative_md=None)))
    assert AI_NARRATIVE_DISCLOSURE in on
    assert AI_NARRATIVE_DISCLOSURE not in off


def test_terms_version_stamped_even_without_an_accepted_date():
    text = _all_text(render_packet_docx(build_packet(_vm5(), terms_accepted_at=None)))
    assert f"Terms v{TERMS_VERSION}" in text
    # no date was supplied, so no "accepted <ts>" clause is fabricated
    assert "accepted " not in text


def test_role_does_not_change_the_numbers_in_the_document():
    # role tailors emphasis/CTA only — the rendered .docx figures are identical
    # across board/funder/advisor (the numbers never move).
    figs = []
    for role in ("board", "funder", "advisor"):
        text = _all_text(render_packet_docx(build_packet(_vm5(), role=role)))
        figs.append(sorted(extract_figures(text)))
    assert figs[0] == figs[1] == figs[2]


def test_legacy_vm_also_never_leaks_a_raw_float():
    # the year-count-agnostic path must be float-safe on a 3-year snapshot too.
    text = _all_text(render_packet_docx(build_packet(VM3_LEGACY, narrative_md=None)))
    leaks = [f for f in _raw_floats(VM3_LEGACY) if f in text]
    assert not leaks, f"raw float(s) leaked into the legacy .docx: {leaks}"


def test_ai_on_path_is_fully_grounded_too():
    # When a grounded stored narrative is used, the WHOLE document (narrative +
    # deterministic sentences + tables) still validates against computed_json.
    vm = _vm5()
    body = "House of Hope needs $347,854 in capital and earns $426,938 in revenue."
    text = _all_text(render_packet_docx(build_packet(vm, narrative_md=body)))
    validate_grounding(text, vm)

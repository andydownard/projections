"""app/packet.py — Board / Funder / Advisor packet builder (M5, API_SPEC §6.4).

The packet is the primary trust surface (PRD §17). It is assembled ENTIRELY from
the stored ``computed_json`` view-model — there is ONE math/format surface shared
with the read response and the ``.xlsx`` builder, so the packet can never invent a
figure (every display string already passed the engine's formatting). The packet:

  - **leads with evidence** (§15): verified vs estimated assumptions with their
    citations/dates/confidence,
  - then the **decision recommendation** (the reco banner),
  - **assumptions** (verified vs estimated), **sensitivity**, **provenance**
    (which rows are inputs vs computed vs overridden vs estimated),
  - cash need + break-even and KPIs.

The ``role`` ∈ {board, funder, advisor} tailors emphasis + the call-to-action
ONLY — never the numbers (a regression test asserts the banner facts are byte
identical across roles). The grounded narrative (app/narrative.py) is injected
only when AI is enabled; with AI disabled the packet omits generated prose but
keeps every structured/evidence section (AI opt-out, §21).
"""
from __future__ import annotations

import io
import re
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from app.terms import TERMS_VERSION
from engine.model import AI_NARRATIVE_DISCLOSURE, EXPORT_DISCLAIMER

PACKET_ROLES = ("board", "funder", "advisor")

# Role-tailored call-to-action / emphasis (numbers never change — only framing).
_ROLE_CTA = {
    "board": "Approve the launch plan and the capital ask below.",
    "funder": "Fund the capital gap to reach a self-sustaining store.",
    "advisor": "Review the assumptions and pressure-test the downside.",
}
_ROLE_EMPHASIS = {
    "board": "decision",
    "funder": "capital",
    "advisor": "assumptions",
}

# Evidence badges that mean "verified" vs "estimated" (DATA_MODEL §3.3 / §15).
_VERIFIED_BADGES = {"verified", "verified_user", "user_attached"}
_VERIFIED_METHODS = {"user_attached", "user_provided"}


def _norm_role(role: str | None) -> str:
    return role if role in PACKET_ROLES else "board"


def _disp(node: Any) -> str:
    """Best-effort display string for a ``{raw, display}`` view-model value."""
    if isinstance(node, dict):
        return str(node.get("display", ""))
    return str(node) if node is not None else ""


def _is_verified(ev: dict[str, Any]) -> bool:
    badge = str(ev.get("badge") or "").lower()
    method = str(ev.get("method") or "").lower()
    if badge in _VERIFIED_BADGES:
        return True
    if method in _VERIFIED_METHODS:
        return True
    # estimated_* / low-confidence retrieval -> NOT verified.
    return False


def _banner(vm: dict[str, Any]) -> dict[str, Any]:
    reco = vm.get("reco") or {}
    metrics = vm.get("metrics") or {}
    facts = [
        {"label": "Capital required", "display": _disp(metrics.get("capital"))},
        {"label": "First-year cash gap", "display": _disp(metrics.get("cashGap"))},
        {"label": "Break-even", "display": _disp(metrics.get("breakeven"))},
    ]
    return {
        "tag": reco.get("tag", ""),
        "headline": reco.get("headline", ""),
        "sub": reco.get("sub", ""),
        "facts": facts,
    }


def _assumptions(vm: dict[str, Any]) -> dict[str, Any]:
    """Split evidence-backed assumptions into verified vs estimated (lead w/ evidence)."""
    verified: list[dict[str, Any]] = []
    estimated: list[dict[str, Any]] = []
    for ev in vm.get("evidence") or []:
        entry = {
            "field": ev.get("field", ""),
            "label": ev.get("label", ev.get("field", "")),
            "display": _disp(ev.get("value")),
            "meta": ev.get("meta", ""),
            "method": ev.get("method", ""),
            "badge": ev.get("badge", ""),
        }
        (verified if _is_verified(ev) else estimated).append(entry)
    return {"verified": verified, "estimated": estimated}


def _provenance(vm: dict[str, Any]) -> dict[str, Any]:
    """Classify every 3-year row by source: input / computed / overridden / estimated."""
    buckets: dict[str, list[dict[str, str]]] = {
        "input": [], "computed": [], "overridden": [], "estimated": []}
    for row in vm.get("rows") or []:
        cls = str(row.get("class") or "computed")
        if cls not in buckets:
            cls = "computed"
        buckets[cls].append({"label": row.get("label", ""),
                             "display": _disp(row.get("y1"))})
    return buckets


def _sensitivity(vm: dict[str, Any]) -> dict[str, Any]:
    """A grounded sensitivity table.

    The packet must not fabricate downside math (that is the engine's job), so the
    table surfaces the engine's already-computed headline figures as the base
    column and labels each as a sensitivity driver. Every display string here is
    copied verbatim from ``computed_json`` (grounded by construction); no new
    arithmetic is performed in the packet layer.
    """
    metrics = vm.get("metrics") or {}
    rows = [
        {"driver": "Capital required", "base": _disp(metrics.get("capital")),
         # Source the rationale from the view-model so packet and UI never drift.
         "note": metrics.get("reasonCapital")
                 or ("Worst-case cumulative cash trough (already includes "
                     "one-time startup) plus reserve.")},
        {"driver": "First-year cash gap", "base": _disp(metrics.get("cashGap")),
         "note": "Most-negative cumulative cash across the first year."},
        {"driver": "Break-even", "base": _disp(metrics.get("breakeven")),
         "note": "First month operating net turns and stays non-negative."},
    ]
    return {"columns": ["Driver", "Base case", "Note"], "rows": rows}


def _kpis(vm: dict[str, Any]) -> list[dict[str, str]]:
    out = []
    for kpi in vm.get("kpis") or []:
        out.append({"label": kpi.get("label", ""),
                    "display": _disp(kpi.get("value")),
                    "sub": kpi.get("sub", "")})
    return out


def _disclaimer(narrative_md: str | None, terms_accepted_at: str | None) -> dict[str, Any]:
    """The server-owned export footer (#192) — a single source for the "planning
    estimates, not advice" caveat the terms gate exists to protect, plus the
    AI-narrative disclosure (only when generated prose is present). Reuses the
    engine constants + ``app.terms.TERMS_VERSION`` so app and export copy never drift.
    """
    return {
        "body": EXPORT_DISCLAIMER,
        "ai_disclosure": AI_NARRATIVE_DISCLOSURE if narrative_md else None,
        "terms_version": TERMS_VERSION,
        "terms_accepted_at": terms_accepted_at or "",
    }


# --------------------------------------------------------- income statement
# The .docx income-statement table is YEAR-COUNT-AGNOSTIC: it renders exactly the
# year columns the stored view-model carries (a legacy 3-year snapshot keeps three
# columns; a 5-year snapshot shows five). The bottom line is the net-income row,
# accepting the current "Net income" label OR the legacy "Net profit" so an old
# stored projection still foots. Every cell is a display string copied verbatim
# from computed_json — the packet performs no arithmetic of its own.
_YEAR_KEYS = ("y1", "y2", "y3", "y4", "y5")
_YEAR_LABELS = {"y1": "Year 1", "y2": "Year 2", "y3": "Year 3",
                "y4": "Year 4", "y5": "Year 5"}
# Rows the income statement prints in bold (subtotals + the bottom line). Both the
# current "Net income" label and the legacy "Net profit" are accepted.
_INCOME_BOLD = {"Total Revenue", "Total Expenses", "Net income", "Net profit"}
_NET_LABELS = {"Net income", "Net profit"}


def _present_year_keys(rows: list[dict[str, Any]]) -> list[str]:
    """The year columns actually present in the view-model (year-count-agnostic)."""
    return [k for k in _YEAR_KEYS
            if any(isinstance(r.get(k), dict) for r in rows)]


def _income_statement(vm: dict[str, Any]) -> dict[str, Any]:
    """The projected income statement as a structured, render-ready table.

    Includes the revenue + expense rows (a percent row like "Net margin" is
    excluded — the statement is a dollar table); each line carries one display
    string per present year. ``bold`` flags the subtotal/bottom-line rows.
    """
    rows = vm.get("rows") or []
    years = _present_year_keys(rows)
    headers = ["Line item"] + [_YEAR_LABELS[k] for k in years]
    line_items: list[dict[str, Any]] = []
    for row in rows:
        if row.get("group") not in ("revenue", "expenses"):
            continue
        label = row.get("label", "")
        if label == "Net margin":   # percent line — not part of the $ statement
            continue
        line_items.append({
            "label": label,
            "cells": [_disp(row.get(k)) for k in years],
            "bold": label in _INCOME_BOLD,
            "is_net": label in _NET_LABELS,
        })
    return {"years": years, "headers": headers, "rows": line_items}


def _startup_costs_section(vm: dict[str, Any]) -> dict[str, Any]:
    """The one-time startup-cost line items + total (schema 1.5.0).

    Each amount is a display string from ``vm['startupCosts']`` (grounded by
    construction). Absent on a legacy snapshot that predates 1.5.0 -> empty list,
    which the renderer handles gracefully.
    """
    items = [
        {"category": c.get("category", ""), "amount": _disp(c.get("amount"))}
        for c in (vm.get("startupCosts") or [])
    ]
    return {"items": items, "total": _disp(vm.get("startupTotal"))}


def build_packet(
    vm: dict[str, Any],
    role: str = "board",
    narrative_md: str | None = None,
    terms_accepted_at: str | None = None,
) -> dict[str, Any]:
    """Assemble the role-tailored packet from a computed_json view-model.

    ``narrative_md`` is the grounded, sanitized prose (app/narrative.py). Pass
    ``None`` when AI is disabled or no narrative exists: the packet then omits the
    prose section but keeps every structured/evidence section (§21 opt-out).
    ``terms_accepted_at`` (when known) stamps the export footer with the acceptance
    date alongside the terms version (#192).
    """
    role = _norm_role(role)
    sections: dict[str, Any] = {}
    # Order matters: lead with evidence, then the decision, then the detail.
    sections["banner"] = _banner(vm)
    sections["evidence"] = _assumptions(vm)  # alias: evidence-backed assumptions
    sections["recommendation"] = {
        "tag": (vm.get("reco") or {}).get("tag", ""),
        "headline": (vm.get("reco") or {}).get("headline", ""),
        "sub": (vm.get("reco") or {}).get("sub", ""),
    }
    sections["assumptions"] = _assumptions(vm)
    sections["sensitivity"] = _sensitivity(vm)
    sections["provenance"] = _provenance(vm)
    sections["kpis"] = _kpis(vm)
    # The .docx 2-pager's two tables (EPIC DOCX): the projected income statement
    # (year-count-agnostic) and the one-time startup costs. Both grounded by
    # construction (every cell copied from the view-model display strings).
    sections["income_statement"] = _income_statement(vm)
    sections["startup_costs"] = _startup_costs_section(vm)
    if narrative_md:
        sections["narrative"] = {"body_md": narrative_md}
    # Always present: the planning-estimates caveat + AI disclosure (the latter only
    # when prose is present) travels into every exported artifact (#192).
    sections["disclaimer"] = _disclaimer(narrative_md, terms_accepted_at)

    return {
        "role": role,
        "name": vm.get("name", ""),
        "emphasis": _ROLE_EMPHASIS[role],
        "cta": _ROLE_CTA[role],
        "sections": sections,
    }


# --------------------------------------------------------------------- render
def _md_escape(s: str) -> str:
    """Defang markdown control chars in untrusted free text (role labels, names)."""
    return (s or "").replace("\\", "\\\\").replace("`", "\\`").replace("<", "&lt;")


def render_packet_md(pkt: dict[str, Any]) -> str:
    """Render the structured packet to Markdown (grounded — figures come from vm)."""
    s = pkt["sections"]
    lines: list[str] = []
    lines.append(f"# {_md_escape(pkt.get('name', ''))} — Board Packet")
    lines.append("")
    lines.append(f"_Prepared for: {_md_escape(pkt['role'])}_  ")
    lines.append(f"**{_md_escape(pkt.get('cta', ''))}**")
    lines.append("")

    b = s["banner"]
    lines.append(f"## Recommendation: {_md_escape(b.get('headline', ''))}")
    if b.get("sub"):
        lines.append(_md_escape(b["sub"]))
    lines.append("")
    for f in b.get("facts", []):
        lines.append(f"- **{_md_escape(f['label'])}:** {_md_escape(f['display'])}")
    lines.append("")

    a = s["assumptions"]
    lines.append("## Assumptions")
    lines.append("### Verified")
    for e in a["verified"]:
        lines.append(f"- {_md_escape(e['label'])}: {_md_escape(e['display'])} "
                     f"({_md_escape(e['meta'])})")
    lines.append("### Estimated")
    for e in a["estimated"]:
        lines.append(f"- {_md_escape(e['label'])}: {_md_escape(e['display'])} "
                     f"({_md_escape(e['meta'])})")
    lines.append("")

    sens = s["sensitivity"]
    lines.append("## Sensitivity")
    lines.append("| " + " | ".join(sens["columns"]) + " |")
    lines.append("|" + "|".join(["---"] * len(sens["columns"])) + "|")
    for r in sens["rows"]:
        lines.append(f"| {_md_escape(r['driver'])} | {_md_escape(r['base'])} "
                     f"| {_md_escape(r['note'])} |")
    lines.append("")

    lines.append("## Key metrics")
    for k in s["kpis"]:
        lines.append(f"- **{_md_escape(k['label'])}:** {_md_escape(k['display'])} "
                     f"{_md_escape(k.get('sub', ''))}")
    lines.append("")

    if "narrative" in s:
        lines.append("## Narrative")
        # Disclose AI authorship BEFORE the prose so a reader sees it was AI-drafted
        # and that every figure is model-grounded (#192) — never an undisclosed claim.
        d = s.get("disclaimer") or {}
        if d.get("ai_disclosure"):
            lines.append(f"_{_md_escape(d['ai_disclosure'])}_")
            lines.append("")
        lines.append(s["narrative"]["body_md"])
        lines.append("")

    # Footer: the planning-estimates disclaimer + terms version/date (#192). Always
    # present so the caveat is never stripped from the artifact a board reads.
    disc = s.get("disclaimer")
    if disc:
        lines.append("---")
        lines.append("## Disclaimer")
        lines.append(_md_escape(disc["body"]))
        terms_line = f"Terms v{_md_escape(disc.get('terms_version', ''))}"
        if disc.get("terms_accepted_at"):
            terms_line += f" accepted {_md_escape(disc['terms_accepted_at'])}"
        lines.append(f"_{terms_line}._")
        lines.append("")

    return "\n".join(lines)


# ----------------------------------------------------------------- .docx render
# A professionally formatted, 2-page Board Packet built with python-docx (real
# tables, shaded header rows, right-aligned amounts) — the trust artifact a board
# actually opens (EPIC DOCX). It consumes ONLY the packet sections, which are in
# turn assembled from the stored computed_json display strings, so the document
# can never carry a figure the engine didn't produce (LLM-GROUNDING / Reg #5):
#   - the exec summary uses the stored, already-grounded+sanitized narrative when
#     AI is enabled (tags flattened), else a deterministic fallback built only by
#     concatenating computed_json display strings (grounded by construction);
#   - every Projected Performance / Growth Potential / Interpretation sentence and
#     every table cell is likewise a verbatim display string.
# With all AI keys unset the packet still renders fully (PRD §16/§21 opt-out).

_TAG_RE = re.compile(r"<[^>]+>")

# Header-row fills (page 1 income statement / page 2 startup costs) + small text.
_INCOME_HEADER_FILL = "2D3E50"
_STARTUP_HEADER_FILL = "3D5A80"
_WHITE = RGBColor(0xFF, 0xFF, 0xFF)
_GRAY = RGBColor(0x66, 0x66, 0x66)
_SMALL_PT = Pt(9)


def _strip_html(s: str) -> str:
    """Flatten sanitized narrative HTML to plain text for a Word run.

    The body_md is ALREADY allowlist-sanitized (no scripts/handlers); for the
    Word body we drop the remaining presentational tags and unescape the few
    entities the sanitizer emitted so a board never sees a literal "<p>".
    """
    text = _TAG_RE.sub(" ", s or "")
    text = (text.replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"\s+", " ", text).strip()


# ---- view-model accessors (read display strings from the assembled packet so the
# document is grounded by construction — it never touches a raw numeric value).
def _kpi_disp(pkt: dict[str, Any], label: str) -> str:
    for k in pkt["sections"].get("kpis", []):
        if k.get("label") == label:
            return k.get("display", "")
    return ""


def _banner_fact(pkt: dict[str, Any], label: str) -> str:
    for f in pkt["sections"].get("banner", {}).get("facts", []):
        if f.get("label") == label:
            return f.get("display", "")
    return ""


def _has_value(display: str) -> bool:
    return bool(display) and display.upper() not in {"N/A", "—", ""}


def _exec_summary_fallback(pkt: dict[str, Any]) -> str:
    """A deterministic executive summary built ONLY from computed_json display
    strings (grounded by construction) — the AI-off path (PRD §16/§21)."""
    name = pkt.get("name") or "This store"
    rev = _kpi_disp(pkt, "Total revenue")
    net = _kpi_disp(pkt, "Net income")
    margin = _kpi_disp(pkt, "Net margin")
    capital = _banner_fact(pkt, "Capital required")
    breakeven = _banner_fact(pkt, "Break-even")

    first = f"{name} is projected to generate {rev} in Year 1 revenue" if rev \
        else f"{name} has a Year 1 financial projection prepared"
    if _has_value(net):
        first += f" and {net} net income"
    if _has_value(margin):
        first += f" ({margin} net margin)"
    first += "."
    parts = [first]
    if _has_value(capital):
        second = f"The launch requires {capital} in one-time startup capital"
        if _has_value(breakeven):
            second += f", reaching operating break-even at {breakeven}"
        second += "."
        parts.append(second)
    return " ".join(parts)


def _performance_sentence(pkt: dict[str, Any]) -> str:
    """Year-1 headline performance (grounded display strings only)."""
    rev = _kpi_disp(pkt, "Total revenue")
    net = _kpi_disp(pkt, "Net income")
    if rev and _has_value(net):
        return f"Year 1 generates {rev} in revenue and {net} net income."
    if rev:
        return f"Year 1 generates {rev} in revenue."
    return "Year 1 performance is summarized in the income statement below."


def _growth_sentence(pkt: dict[str, Any]) -> str:
    """Out-year growth (grounded): the final-year net income + revenue CAGR."""
    istmt = pkt["sections"].get("income_statement") or {}
    years = istmt.get("years") or []
    cagr = _kpi_disp(pkt, "Revenue CAGR")
    net_last = ""
    for row in istmt.get("rows", []):
        if row.get("is_net") and row.get("cells"):
            net_last = row["cells"][-1]
    if len(years) >= 2 and _has_value(net_last):
        label = _YEAR_LABELS.get(years[-1], f"Year {len(years)}")
        out = f"By {label}, the store is projected to reach {net_last} in annual net income"
        if _has_value(cagr):
            out += f" on a {cagr} revenue growth rate"
        return out + "."
    if _has_value(cagr):
        return f"Revenue is projected to grow at a {cagr} compound rate across the projection."
    return ("The secondhand-retail market continues to grow, supporting sustained "
            "donor and customer demand.")


def _interpretation_para(pkt: dict[str, Any]) -> str:
    """The Interpretation/payback paragraph (grounded display strings only)."""
    capital = _banner_fact(pkt, "Capital required")
    payback = _kpi_disp(pkt, "Payback period")
    if _has_value(capital) and _has_value(payback):
        return (f"This plan requires {capital} in startup capital, projected to be "
                f"recovered by {payback}. Review the assumptions and the downside "
                f"sensitivity before committing funds.")
    if _has_value(capital):
        return (f"This plan requires {capital} in startup capital; payback is not "
                f"reached within the projection horizon, so review the assumptions "
                f"and the downside sensitivity carefully before committing funds.")
    return "Review the assumptions and the downside sensitivity before committing funds."


# ---- docx low-level helpers
def _shade_cell(cell: Any, hex_fill: str) -> None:
    """Set a table cell's background fill (OOXML w:shd) — header-row shading."""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def _set_cell_text(cell: Any, text: str, *, bold: bool = False,
                   white: bool = False, align_right: bool = False) -> None:
    """Write a single styled run into a table cell (replacing its empty default)."""
    para = cell.paragraphs[0]
    if align_right:
        para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = para.add_run(text or "")
    run.bold = bold
    if white:
        run.font.color.rgb = _WHITE


def _add_income_table(doc: Any, stmt: dict[str, Any]) -> None:
    headers = stmt.get("headers") or ["Line item"]
    rows = stmt.get("rows") or []
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    hdr = table.rows[0].cells
    for i, label in enumerate(headers):
        _shade_cell(hdr[i], _INCOME_HEADER_FILL)
        _set_cell_text(hdr[i], label, bold=True, white=True, align_right=(i > 0))
    for item in rows:
        cells = table.add_row().cells
        _set_cell_text(cells[0], item["label"], bold=item.get("bold", False))
        for i, value in enumerate(item.get("cells", []), start=1):
            if i < len(cells):
                _set_cell_text(cells[i], value, bold=item.get("bold", False),
                               align_right=True)


def _add_startup_table(doc: Any, startup: dict[str, Any]) -> None:
    items = startup.get("items") or []
    if not items:
        doc.add_paragraph("Startup-cost detail is not available for this projection.")
        return
    table = doc.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    hdr = table.rows[0].cells
    _shade_cell(hdr[0], _STARTUP_HEADER_FILL)
    _shade_cell(hdr[1], _STARTUP_HEADER_FILL)
    _set_cell_text(hdr[0], "Category", bold=True, white=True)
    _set_cell_text(hdr[1], "Estimated cost", bold=True, white=True, align_right=True)
    for item in items:
        cells = table.add_row().cells
        _set_cell_text(cells[0], item["category"])
        _set_cell_text(cells[1], item["amount"], align_right=True)
    total = startup.get("total") or ""
    if total:
        cells = table.add_row().cells
        _set_cell_text(cells[0], "Total one-time startup", bold=True)
        _set_cell_text(cells[1], total, bold=True, align_right=True)


def _add_small_para(doc: Any, text: str, *, italic: bool = False,
                    gray: bool = False) -> None:
    para = doc.add_paragraph()
    run = para.add_run(text or "")
    run.font.size = _SMALL_PT
    run.italic = italic
    if gray:
        run.font.color.rgb = _GRAY


def _exec_summary_text(pkt: dict[str, Any]) -> str:
    """The stored grounded narrative (HTML flattened) when AI is on, else the
    deterministic computed_json fallback (AI opt-out renders fully)."""
    nar = pkt["sections"].get("narrative") or {}
    body = nar.get("body_md")
    if body:
        return _strip_html(body)
    return _exec_summary_fallback(pkt)


def render_packet_docx(pkt: dict[str, Any]) -> bytes:
    """Render the packet to a professional, 2-page .docx (EPIC DOCX).

    Page 1: title, executive summary, Projected Performance + Growth Potential,
    and the (year-count-agnostic) Projected Income Statement table. Page 2:
    One-Time Startup Costs table, the Interpretation paragraph, the AI-narrative
    disclosure (only when AI prose is present), and the planning-estimates
    disclaimer + terms stamp (#192). Every figure is a grounded display string.
    """
    s = pkt["sections"]
    doc = Document()
    name = pkt.get("name") or "Board Packet"

    # ---- Page 1
    doc.add_heading(name, level=0)
    doc.add_heading("Executive summary", level=1)
    doc.add_paragraph(_exec_summary_text(pkt))

    perf = doc.add_paragraph()
    perf.add_run("Projected Performance: ").bold = True
    perf.add_run(_performance_sentence(pkt))

    growth = doc.add_paragraph()
    growth.add_run("Growth Potential: ").bold = True
    growth.add_run(_growth_sentence(pkt))

    doc.add_heading("Projected Income Statement", level=1)
    _add_income_table(doc, s.get("income_statement") or {})

    doc.add_page_break()

    # ---- Page 2
    doc.add_heading("One-Time Startup Costs", level=1)
    _add_small_para(
        doc,
        "Capital expenditures (Pre-Opening / Year 0) — not part of the annual "
        "operating expenses above.",
        italic=True)
    _add_startup_table(doc, s.get("startup_costs") or {})

    doc.add_heading("Interpretation", level=1)
    doc.add_paragraph(_interpretation_para(pkt))

    disc = s.get("disclaimer") or {}
    # AI authorship is disclosed only when generated prose is actually present —
    # the deterministic fallback is NOT AI-drafted, so claiming so would mislead.
    if disc.get("ai_disclosure"):
        _add_small_para(doc, disc["ai_disclosure"], italic=True, gray=True)
    if disc.get("body"):
        _add_small_para(doc, disc["body"], gray=True)
        terms_line = f"Terms v{disc.get('terms_version', '')}"
        if disc.get("terms_accepted_at"):
            terms_line += f" accepted {disc['terms_accepted_at']}"
        _add_small_para(doc, terms_line + ".", gray=True)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()

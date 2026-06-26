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

from typing import Any, Optional

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


def _norm_role(role: Optional[str]) -> str:
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
                 or "Worst-case cumulative cash trough (already includes one-time startup) plus reserve."},
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


def build_packet(
    vm: dict[str, Any],
    role: str = "board",
    narrative_md: Optional[str] = None,
) -> dict[str, Any]:
    """Assemble the role-tailored packet from a computed_json view-model.

    ``narrative_md`` is the grounded, sanitized prose (app/narrative.py). Pass
    ``None`` when AI is disabled or no narrative exists: the packet then omits the
    prose section but keeps every structured/evidence section (§21 opt-out).
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
    if narrative_md:
        sections["narrative"] = {"body_md": narrative_md}

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
        lines.append(s["narrative"]["body_md"])
        lines.append("")

    return "\n".join(lines)


# ----------------------------------------------------------------- .docx render
# A .docx is an OOXML zip. We build it stdlib-only (zipfile) so the export has no
# third-party dependency on the render path — same discipline as the sanitizer.
# Content is the SAME grounded packet text as the markdown render (one source of
# figures); paragraphs map 1:1 from the rendered lines so the export can never
# carry a figure the markdown packet doesn't.
import io
import re
import zipfile
from xml.sax.saxutils import escape as _xml_escape

_DOCX_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
    'package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.'
    'openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
_DOCX_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
    'relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.'
    'org/officeDocument/2006/relationships/officeDocument" Target="word/'
    'document.xml"/></Relationships>'
)

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    """Flatten sanitized narrative HTML to text for a .docx paragraph run.

    The body_md is ALREADY allowlist-sanitized (no scripts/handlers); for the
    Word body we drop the remaining presentational tags and unescape the few
    entities the sanitizer emitted, then re-escape for XML safety downstream.
    """
    text = _TAG_RE.sub(" ", s or "")
    text = (text.replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"\s+", " ", text).strip()


def _docx_paragraph(text: str) -> str:
    return (
        "<w:p><w:r><w:t xml:space=\"preserve\">"
        f"{_xml_escape(text)}"
        "</w:t></w:r></w:p>"
    )


def render_packet_docx(pkt: dict[str, Any]) -> bytes:
    """Render the packet to a minimal valid .docx (OOXML zip), stdlib-only (N11).

    The board's CURRENT stored (possibly edited) narrative prose travels into the
    document body verbatim (tags flattened). Figures are the same grounded
    display strings as the markdown packet — one source of truth.
    """
    # Reuse the markdown render as the canonical line source, then split into
    # Word paragraphs so the .docx and .md never diverge in content/figures.
    md = render_packet_md(pkt)
    paras = [_docx_paragraph(line) for line in md.split("\n")]
    body = "".join(paras)
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/'
        '2006/main"><w:body>'
        f"{body}"
        "</w:body></w:document>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES)
        zf.writestr("_rels/.rels", _DOCX_RELS)
        zf.writestr("word/document.xml", document_xml)
    return buf.getvalue()

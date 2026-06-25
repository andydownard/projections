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
         "note": "One-time startup + worst-case cash trough + reserve."},
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

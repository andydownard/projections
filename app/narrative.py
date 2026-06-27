"""app/narrative.py — grounded, sanitized Board-Packet prose (M5).

This is the app's primary trust surface (SECURITY.md §5, §6.3; API_SPEC §6.1;
DATA_MODEL §3.3). Three HARD server-side invariants, each enforced here and CI
tested with adversarial inputs (a happy-path-only test gives false safety):

1. **Allowlist sanitization** of `body_md` BEFORE storage AND before render
   (bearer tokens live in localStorage -> a single stored XSS = token theft =
   full projection takeover). We allow a minimal Markdown-rendered tag set and
   strip everything else: all `<script>`, every `on*` handler, `style`,
   `javascript:` URLs, `<iframe>/<object>/<embed>`, inline SVG. The script/style
   element *body* is dropped too, not just the tags.

2. **Numeric grounding** — every monetary/percent FIGURE appearing in the prose
   must exist verbatim in `computed_json`'s display strings, or generation is
   REJECTED server-side (`GroundingError`); the prior narrative is never
   overwritten. This protects the board packet from hallucinated figures
   (regression registry #5, PRD §17).

3. **Stale detection** — a stable hash of the `computed_json` facts is stored at
   generation; if the live hash differs, the narrative is stale. The diff is
   figure-level so the client can show "Out of date" + Regenerate and NEVER
   auto-overwrite user-edited prose (PRD §17).

The sanitizer delegates the allowlist enforcement to **`bleach`** — a vetted,
widely-audited HTML sanitizer built on html5lib — rather than a bespoke parser,
because allowlist sanitization is exactly the class of problem where hand-rolled
parsers leak on obfuscated payloads (e.g. `<scr<script>ipt>`). bleach is the
security boundary; we add only a tiny pre-pass that discards the *content* of a
few raw-text/dangerous elements (a `<script>` body is a token-stealing payload,
not prose). See SECURITY.md §5.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import bleach  # type: ignore[import-untyped]  # vetted sanitizer; ships no stubs

# --------------------------------------------------------------- sanitization
# Minimal Markdown-rendered allowlist (SECURITY.md §5). bleach enforces the
# tag/attr/URL-scheme allowlist; everything else (every on* handler, `style`,
# javascript:/data:/vbscript: URLs, <iframe>/<object>/<embed>/inline SVG) is
# dropped.
_ALLOWED_TAGS = {
    "p", "br", "ul", "ol", "li", "strong", "em", "b", "i", "a",
    "h1", "h2", "h3", "h4", "blockquote", "code", "pre", "hr",
}
# Per-tag attribute allowlist; bleach drops everything else (incl. on*/style).
_ALLOWED_ATTRS = {"a": ["href", "title"]}
# Only these URL schemes survive on a link href; a javascript:/data:/vbscript:
# href is stripped while the <a> text is kept (defang, not delete).
_ALLOWED_PROTOCOLS = ["http", "https", "mailto"]
# Elements whose entire subtree (content included) is discarded, not just the
# tag — bleach alone keeps their inner text as inert data, but a <script>/<style>
# body is a payload, not prose. Matched case-insensitively; the closing tag is
# optional so an unclosed <script> is dropped through to EOF. This pre-pass is a
# strictness nicety layered ON TOP of bleach (the real security boundary), so a
# missed match can never let executable markup through.
_DROP_CONTENT_RE = re.compile(
    r"<\s*(script|style|iframe|object|embed|svg|math)\b[^>]*>.*?(?:</\s*\1\s*>|\Z)",
    re.IGNORECASE | re.DOTALL,
)

_CLEANER = bleach.sanitizer.Cleaner(
    tags=_ALLOWED_TAGS,
    attributes=_ALLOWED_ATTRS,
    protocols=_ALLOWED_PROTOCOLS,
    strip=True,            # drop disallowed tags but keep their text (defang)
    strip_comments=True,
)


def sanitize_richtext(value: str) -> str:
    """Allowlist-sanitize untrusted rich text before storage AND on render.

    The single XSS-defense for every user/LLM rich-text surface that can reach
    the DOM or the board packet — ``narratives.body_md`` (user-edited AND
    LLM-generated), evidence labels/notes, justification notes, projection name
    (SECURITY.md §5). Bearer tokens live in ``localStorage``, so a single stored
    XSS = token theft = full projection takeover; this is the gate that makes
    ``el.innerHTML = body_md`` safe on the client.

    Keeps a minimal Markdown-rendered tag set and drops everything else: all
    ``<script>``/``<style>``/``<iframe>``/``<object>``/``<embed>``/inline SVG
    (tag *and* body), every ``on*`` handler, ``style`` attributes, and any
    non-http(s)/mailto URL scheme. Idempotent: re-running on already-sanitized
    markup is a no-op, so the store-time pass and the defense-in-depth render
    pass agree.
    """
    if not value:
        return ""
    pre = _DROP_CONTENT_RE.sub("", value)
    return _CLEANER.clean(pre)


def sanitize_body_md(body_md: str) -> str:
    """Allowlist-sanitize narrative markup before storage (SECURITY.md §5).

    Thin alias over :func:`sanitize_richtext` kept as the name the narrative
    store/render path calls; the allowlist behavior is identical.
    """
    return sanitize_richtext(body_md)


# ----------------------------------------------------------------- grounding
# Money: $1,234 / $1,234.56 / ($42,000) accounting-negative / $278k short form.
_MONEY_RE = re.compile(r"\(?-?\$\s?\d[\d,]*(?:\.\d+)?[kKmM]?\)?")
# Percent: 11.0% / 39% .
_PCT_RE = re.compile(r"\d[\d,]*(?:\.\d+)?\s?%")


class GroundingError(Exception):
    """Raised when prose contains a figure absent from computed_json (PRD §17)."""

    def __init__(self, ungrounded: list[str]) -> None:
        self.ungrounded = ungrounded
        super().__init__(f"ungrounded figures: {ungrounded}")


def _norm(fig: str) -> str:
    """Normalize a figure to compare prose vs display strings (drop spaces)."""
    return re.sub(r"\s+", "", fig)


def extract_figures(text: str) -> list[str]:
    """Every monetary/percent figure that appears in prose (order-preserved)."""
    found: list[str] = []
    for m in _MONEY_RE.finditer(text or ""):
        found.append(m.group(0).strip())
    for m in _PCT_RE.finditer(text or ""):
        found.append(m.group(0).strip())
    # De-dup, keep first occurrence order.
    seen: set[str] = set()
    out: list[str] = []
    for f in found:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def grounded_figures(vm: dict[str, Any]) -> set[str]:
    """The set of approved display strings the prose may reference.

    Walks computed_json collecting every ``{raw, display}`` display value plus
    any bare figure embedded in a display string (e.g. "Month 5" carries no
    figure; "$277,990" does). The grounding check is against these AND every
    server-built display VARIANT (e.g. the "$278k" short form for "$277,990",
    N3) so an editor may write a rounded form the server itself blessed — never
    a client regex inventing one.
    """
    approved: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            disp = node.get("display")
            if isinstance(disp, str):
                approved.add(_norm(disp))
                for f in extract_figures(disp):
                    approved.add(_norm(f))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, str):
            for f in extract_figures(node):
                approved.add(_norm(f))

    walk(vm)
    # N3: fold in every server-built display variant so they ground too.
    for fig in canonical_grounded_figures(vm):
        for variant in fig["variants"]:
            approved.add(_norm(variant))
    return approved


# ----------------------------------------------------- N3: canonical figures
# A canonical grounded figure is one engine-produced money/percent value plus
# the small set of DISPLAY VARIANTS the server itself blesses for it. The board
# packet narrative often abbreviates ("$278k", "~$278,000"); the validator and
# the client must agree on the variant set, and that agreement is SERVER-built
# from computed_json — never a client-side regex (API_SPEC §6.1, SECURITY §6.3).


def _thousands_variant(raw: float) -> str | None:
    """Short-form ``$278k`` for a round-ish thousands money figure (>= $10,000)."""
    n = abs(raw)
    if n < 10_000:
        return None
    sign = "-" if raw < 0 else ""
    k = round(n / 1000)
    return f"{sign}${k:,}k"


def _money_variants(raw: float, display: str) -> list[str]:
    variants = [display]
    n = abs(raw)
    whole = f"${n:,.0f}"
    if raw < 0:
        # accounting-negative + plain forms both blessed
        variants.append(f"(${n:,.0f})")
        variants.append(f"-${n:,.0f}")
    else:
        variants.append(whole)
    thou = _thousands_variant(raw)
    if thou:
        variants.append(thou)
    # de-dup, preserve order
    seen: set[str] = set()
    out: list[str] = []
    for v in variants:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def canonical_grounded_figures(vm: dict[str, Any]) -> list[dict[str, Any]]:
    """Server-built canonical figure list: ``[{raw, display, variants[]}]``.

    Walks computed_json collecting every ``{raw, display}`` money/percent figure
    and attaches the display variants the server blesses (canonical, plain, the
    accounting-negative, and a ``$278k`` thousands short form). De-duplicated by
    (raw, canonical display) so the client and grounding validator share ONE
    authoritative list (N3).
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[float, str]] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            raw = node.get("raw")
            disp = node.get("display")
            if isinstance(disp, str) and isinstance(raw, (int, float)):
                is_money = "$" in disp
                is_pct = "%" in disp
                if is_money or is_pct:
                    key = (float(raw), disp)
                    if key not in seen:
                        seen.add(key)
                        variants = (
                            _money_variants(float(raw), disp)
                            if is_money else [disp]
                        )
                        out.append({"raw": float(raw), "display": disp,
                                    "variants": variants})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(vm)
    return out


def validate_grounding(body_md: str, vm: dict[str, Any]) -> None:
    """Reject prose whose figures are not all in computed_json (hard validator).

    Raises GroundingError listing every ungrounded figure (in prose order). This
    is a server-side gate, not a prompt nicety (SECURITY.md §6.3).
    """
    approved = grounded_figures(vm)
    ungrounded = [f for f in extract_figures(body_md) if _norm(f) not in approved]
    if ungrounded:
        raise GroundingError(ungrounded)


# --------------------------------------------------------------- stale detect
def _facts(vm: dict[str, Any]) -> dict[str, str]:
    """Flatten computed_json to a {field: display} map of the figures that matter.

    Field names mirror the API's stale_diff shape (API_SPEC §6.1):
    capital / cashGap / breakeven / KPI labels.
    """
    facts: dict[str, str] = {}
    metrics = vm.get("metrics") or {}
    for key in ("capital", "cashGap", "breakeven"):
        node = metrics.get(key)
        if isinstance(node, dict) and "display" in node:
            facts[key] = str(node["display"])
    for kpi in vm.get("kpis") or []:
        label = kpi.get("label")
        val = kpi.get("value")
        if label and isinstance(val, dict) and "display" in val:
            facts[label] = str(val["display"])
    return facts


def compute_hash(vm: dict[str, Any]) -> str:
    """Stable hash of the grounding-relevant facts (DATA_MODEL §3.3).

    Hashes the flattened display facts (not the whole blob) so cosmetic, non-figure
    changes don't spuriously mark a narrative stale.
    """
    blob = json.dumps(_facts(vm), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


def format_was_now(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """The ONE was->now formatter (N11). Both the narrative ``stale_diff`` and the
    ``/preview`` ``changed[]`` list route through this so the two surfaces never
    drift in shape. Each row is normalized to ``{**row, was, now}`` with empty
    strings (never ``None``) for an added/removed field, preserving any extra keys
    (``field``, ``label``, ``sign``) the caller attached.
    """
    out: list[dict[str, str]] = []
    for row in rows:
        out.append({**row, "was": row.get("was") or "", "now": row.get("now") or ""})
    return out


def stale_diff(old_vm: dict[str, Any], new_vm: dict[str, Any]) -> list[dict[str, str]]:
    """Field-level diff of changed figures (API_SPEC §6.1 stale_diff shape)."""
    old, new = _facts(old_vm), _facts(new_vm)
    rows: list[dict[str, str]] = []
    for field in sorted(set(old) | set(new)):
        was, now = old.get(field), new.get(field)
        if was != now:
            rows.append({"field": field, "was": was or "", "now": now or ""})
    return format_was_now(rows)

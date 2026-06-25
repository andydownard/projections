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

The sanitizer is stdlib-only (`html.parser`) so the grounding/sanitization tests
run hermetically with no third-party dependency in the path.
"""
from __future__ import annotations

import hashlib
import json
import re
from html.parser import HTMLParser
from typing import Any

# --------------------------------------------------------------- sanitization
# Minimal Markdown-rendered allowlist (SECURITY.md §5).
_ALLOWED_TAGS = {
    "p", "br", "ul", "ol", "li", "strong", "em", "b", "i", "a",
    "h1", "h2", "h3", "h4", "blockquote", "code", "pre", "hr",
}
# Tags whose *content* must be discarded entirely, not just the tag.
_VOID_CONTENT_TAGS = {"script", "style", "iframe", "object", "embed", "svg", "math"}
# Per-tag attribute allowlist; everything else (incl. every on* handler) dropped.
_ALLOWED_ATTRS = {"a": {"href", "title"}}
_SAFE_URL_SCHEMES = ("http:", "https:", "mailto:")


class _Sanitizer(HTMLParser):
    """Allowlist HTML sanitizer: keep allowed tags/attrs, drop the rest.

    Disallowed tags are dropped but their text is kept (defanging, not deletion)
    EXCEPT for _VOID_CONTENT_TAGS whose entire subtree (e.g. a <script> body) is
    discarded.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._suppress_depth = 0  # >0 while inside a void-content tag

    def handle_starttag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if tag in _VOID_CONTENT_TAGS:
            self._suppress_depth += 1
            return
        if self._suppress_depth:
            return
        if tag not in _ALLOWED_TAGS:
            return  # drop the tag, keep following text
        self.out.append(self._render_open(tag, attrs))

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if tag in _VOID_CONTENT_TAGS or self._suppress_depth:
            return
        if tag not in _ALLOWED_TAGS:
            return
        self.out.append(self._render_open(tag, attrs, self_close=True))

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _VOID_CONTENT_TAGS:
            if self._suppress_depth:
                self._suppress_depth -= 1
            return
        if self._suppress_depth:
            return
        if tag not in _ALLOWED_TAGS:
            return
        self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self._suppress_depth:
            return
        self.out.append(_escape_text(data))

    def _render_open(self, tag: str, attrs: list, self_close: bool = False) -> str:
        allowed = _ALLOWED_ATTRS.get(tag, set())
        kept: list[str] = []
        for name, value in attrs:
            name = (name or "").lower()
            if name.startswith("on"):  # event handlers -> always drop
                continue
            if name not in allowed:
                continue
            if name == "href" and not _is_safe_url(value or ""):
                continue
            kept.append(f'{name}="{_escape_attr(value or "")}"')
        attr_str = (" " + " ".join(kept)) if kept else ""
        return f"<{tag}{attr_str}{' /' if self_close else ''}>"


def _is_safe_url(url: str) -> bool:
    u = url.strip().lower()
    if u.startswith(_SAFE_URL_SCHEMES):
        return True
    # Relative/anchor URLs and scheme-less paths are safe (no scheme to abuse).
    return ":" not in u.split("/", 1)[0]


def _escape_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(s: str) -> str:
    return _escape_text(s).replace('"', "&quot;")


def sanitize_body_md(body_md: str) -> str:
    """Allowlist-sanitize narrative markup before storage (SECURITY.md §5)."""
    if not body_md:
        return ""
    parser = _Sanitizer()
    parser.feed(body_md)
    parser.close()
    return "".join(parser.out)


# ----------------------------------------------------------------- grounding
# Money: $1,234 / $1,234.56 / ($42,000) accounting-negative.
_MONEY_RE = re.compile(r"\(?\$\s?\d[\d,]*(?:\.\d+)?\)?")
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
    figure; "$277,990" does). The grounding check is against these.
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
    return approved


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


def stale_diff(old_vm: dict[str, Any], new_vm: dict[str, Any]) -> list[dict[str, str]]:
    """Field-level diff of changed figures (API_SPEC §6.1 stale_diff shape)."""
    old, new = _facts(old_vm), _facts(new_vm)
    diff: list[dict[str, str]] = []
    for field in sorted(set(old) | set(new)):
        was, now = old.get(field), new.get(field)
        if was != now:
            diff.append({"field": field, "was": was or "", "now": now or ""})
    return diff

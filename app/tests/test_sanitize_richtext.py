"""Adversarial XSS corpus for the rich-text sanitizer (SECURITY.md §5, §15).

`narratives.body_md` (user-edited AND LLM-generated) and every other user rich
text that reaches an output — evidence labels/notes, justification notes,
projection name — are rendered into the DOM (the client does
``el.innerHTML = body_md``) and into the board packet. Bearer tokens live in
``localStorage``, so a single stored XSS = token theft = full projection
takeover (SECURITY §1 risk #2). The server-side allowlist sanitizer is the gate.

This is the **stored-XSS Regression Registry trap** (SECURITY §15: an adversarial
sanitizer corpus is a done-gate, not a happy-path nicety). It hammers the
sanitizer with a wide XSS cheat-sheet and asserts every dangerous construct is
neutralized while the allowed Markdown tag set survives intact — and that the
pass is idempotent so the store-time pass and the defense-in-depth render pass
agree.

RED-first: the ``<scr<script>ipt>`` obfuscation below is *leaked* by the prior
hand-rolled ``html.parser`` sanitizer (it emits ``ipt&gt;STEAL...()``); only the
vetted ``bleach`` allowlist neutralizes it.
"""
import pytest

from app.narrative import sanitize_body_md, sanitize_richtext

# A token that proves a payload survived into an executable/leakable context.
# It appears ONLY inside dangerous positions (script/style bodies, on* handler
# values, javascript:/data:/vbscript: URLs, css expression()) — never as visible
# prose — so "TOKEN not in output" is a sound universal neutralization assertion.
TOKEN = "STEALlocalStorageTOKEN"

# Wide XSS cheat-sheet: script injection, event handlers, dangerous URL schemes,
# embedded objects, inline SVG/MathML, css expression, and encoded/obfuscated
# variants (entity-encoded scheme, tab/newline/null splits, nested-tag smuggling).
XSS_PAYLOADS = {
    "script_tag": f"<script>{TOKEN}()</script>",
    "script_in_prose": f"<p>ok</p><script>{TOKEN}(document.cookie)</script>",
    "uppercase_script": f"<SCRIPT>{TOKEN}()</SCRIPT>",
    "mixedcase_script": f"<ScRiPt>{TOKEN}()</ScRiPt>",
    "unclosed_script_to_eof": f"<p>hi<script>{TOKEN}()",
    "nested_tag_obfuscation": f"<scr<script>ipt>{TOKEN}()</script>",
    "img_onerror": f'<img src=x onerror="{TOKEN}()">',
    "img_onerror_unquoted": f"<img src=x onerror={TOKEN}()>",
    "svg_onload": f"<svg/onload={TOKEN}()>",
    "svg_wrapped_script": f"<svg><script>{TOKEN}()</script></svg>",
    "body_onload": f'<body onload="{TOKEN}()">',
    "iframe_js_src": f'<iframe src="javascript:{TOKEN}()"></iframe>',
    "iframe_srcdoc": f'<iframe srcdoc="<script>{TOKEN}()</script>"></iframe>',
    "object_data_html": f'<object data="data:text/html,<script>{TOKEN}()</script>"></object>',
    "embed_data": f'<embed src="data:text/html,{TOKEN}()">',
    "a_javascript": f'<a href="javascript:{TOKEN}()">x</a>',
    "a_javascript_mixedcase": f'<a href="JaVaScRiPt:{TOKEN}()">x</a>',
    "a_javascript_leading_ws": f'<a href="  javascript:{TOKEN}()">x</a>',
    "a_javascript_entity": f'<a href="&#106;avascript:{TOKEN}()">x</a>',
    "a_javascript_tab_split": f'<a href="java\tscript:{TOKEN}()">x</a>',
    "a_javascript_newline_split": f'<a href="java\nscript:{TOKEN}()">x</a>',
    "a_javascript_null_split": f'<a href="java\x00script:{TOKEN}()">x</a>',
    "a_vbscript": f'<a href="vbscript:{TOKEN}()">x</a>',
    "a_data_html": f'<a href="data:text/html,<script>{TOKEN}()</script>">x</a>',
    "onmouseover": f'<p onmouseover="{TOKEN}()">hover</p>',
    "onclick_on_safe_link": f'<a href="https://ok.test" onclick="{TOKEN}()">x</a>',
    "style_attr_expression": f'<p style="width:expression({TOKEN}())">x</p>',
    "style_tag": f"<style>body{{background:url(javascript:{TOKEN}())}}</style>",
    "style_attr_url": f'<div style="background:url(javascript:{TOKEN}())">x</div>',
    "meta_refresh": f'<meta http-equiv="refresh" content="0;url=javascript:{TOKEN}()">',
    "base_href": f'<base href="javascript:{TOKEN}()">',
    "form_action": f'<form action="javascript:{TOKEN}()"><button>go</button></form>',
    "math_href": f'<math href="javascript:{TOKEN}()">x</math>',
    "details_ontoggle": f'<details ontoggle="{TOKEN}()" open>x</details>',
    "marquee_onstart": f'<marquee onstart="{TOKEN}()">x</marquee>',
    "input_onfocus": f'<input autofocus onfocus="{TOKEN}()">',
    "template_script": f"<template><script>{TOKEN}()</script></template>",
    "conditional_comment": f"<!--[if IE]><script>{TOKEN}()</script><![endif]-->",
}

# Markup that MUST survive a sanitize pass intact (the minimal Markdown set,
# SECURITY §5). Normalized so a void-tag self-close (``<hr />``) compares equal.
ALLOWED_MARKUP = [
    "<p>Para</p>",
    "<strong>bold</strong>",
    "<em>italic</em>",
    "<b>b</b>",
    "<i>i</i>",
    "<ul><li>a</li><li>b</li></ul>",
    "<ol><li>one</li></ol>",
    "<h1>H1</h1>",
    "<h2>H2</h2>",
    "<h3>H3</h3>",
    "<h4>H4</h4>",
    "<blockquote>quote</blockquote>",
    "<code>x = 1</code>",
    "<pre>block</pre>",
    "a<br>b",
    '<a href="https://example.org">https link</a>',
    '<a href="http://example.org">http link</a>',
    '<a href="mailto:dev@example.org">mail link</a>',
    '<a href="/relative/path">relative</a>',
    '<a href="#anchor">anchor</a>',
    '<a href="https://example.org" title="src">titled</a>',
]


def _norm(html: str) -> str:
    return html.replace(" />", ">")


# ----------------------------------------------------- adversarial neutralization
@pytest.mark.parametrize("name,payload", sorted(XSS_PAYLOADS.items()))
def test_xss_payload_is_neutralized(name, payload):
    """Every dangerous construct is stripped so the leak token cannot survive."""
    out = sanitize_body_md(payload)
    lowered = out.lower()
    assert TOKEN not in out, f"{name}: token survived sanitization -> {out!r}"
    # Structural guarantees: no executable markup of any kind remains.
    assert "<script" not in lowered, f"{name}: script tag survived -> {out!r}"
    assert "<iframe" not in lowered, f"{name}: iframe survived -> {out!r}"
    assert "<object" not in lowered, f"{name}: object survived -> {out!r}"
    assert "<embed" not in lowered, f"{name}: embed survived -> {out!r}"
    assert "<svg" not in lowered, f"{name}: svg survived -> {out!r}"
    assert "javascript:" not in lowered, f"{name}: js scheme survived -> {out!r}"
    assert "vbscript:" not in lowered, f"{name}: vbscript survived -> {out!r}"
    assert "onerror" not in lowered, f"{name}: on* handler survived -> {out!r}"
    assert "onload" not in lowered, f"{name}: on* handler survived -> {out!r}"
    assert "onclick" not in lowered, f"{name}: on* handler survived -> {out!r}"
    assert "onmouseover" not in lowered
    assert "style=" not in lowered, f"{name}: style attr survived -> {out!r}"
    assert "expression(" not in lowered, f"{name}: css expression survived -> {out!r}"


def test_nested_tag_obfuscation_regression():
    """`<scr<script>ipt>` is LEAKED by the prior hand-rolled parser; the bleach
    allowlist neutralizes it. This is the concrete red-green of the swap."""
    out = sanitize_body_md(f"<scr<script>ipt>{TOKEN}()</script>")
    assert TOKEN not in out
    assert "<script" not in out.lower()


@pytest.mark.parametrize("markup", ALLOWED_MARKUP)
def test_allowed_markdown_markup_survives(markup):
    """The minimal Markdown-rendered tag set is preserved intact."""
    assert _norm(sanitize_body_md(markup)) == _norm(markup)


def test_safe_link_href_and_title_preserved():
    out = sanitize_body_md('<a href="https://example.org" title="t">src</a>')
    assert 'href="https://example.org"' in out
    assert 'title="t"' in out


def test_unsafe_scheme_dropped_but_anchor_text_kept():
    """A javascript: link keeps the <a> text but loses the dangerous href."""
    out = sanitize_body_md('<a href="javascript:alert(1)">click</a>')
    assert "click" in out
    assert "javascript:" not in out.lower()
    assert "href=" not in out.lower()


# ----------------------------------------------- store-and-render double pass
@pytest.mark.parametrize("name,payload", sorted(XSS_PAYLOADS.items()))
def test_sanitize_is_idempotent_store_then_render(name, payload):
    """Defense-in-depth on render re-runs the sanitizer over already-stored
    markup; it must be a no-op (nothing new can slip through a second pass)."""
    stored = sanitize_body_md(payload)
    rendered = sanitize_body_md(stored)
    assert rendered == stored
    assert TOKEN not in rendered


def test_script_body_text_is_dropped_not_just_the_tag():
    out = sanitize_body_md("<p>Hello</p><script>steal(localStorage.token)</script>")
    assert "<script" not in out.lower()
    assert "steal" not in out  # the script BODY is discarded, not just defanged
    assert "<p>Hello</p>" in out


# ------------------------------------------------------- applies to all sources
# One pure primitive guards every rich-text surface that reaches an output
# (SECURITY §5): narrative body_md (user-edited + LLM-generated), evidence
# labels/notes, justification notes, projection name.
SOURCE_SURFACES = [
    "narrative_user_edited",
    "narrative_llm_generated",
    "evidence_label",
    "evidence_note",
    "justification_note",
    "projection_name",
]


@pytest.mark.parametrize("surface", SOURCE_SURFACES)
def test_sanitizer_neutralizes_payload_for_every_source(surface):
    payload = f'<b>{surface}</b><img src=x onerror="{TOKEN}()"><script>{TOKEN}()</script>'
    out = sanitize_richtext(payload)
    assert TOKEN not in out
    assert "<script" not in out.lower()
    assert "onerror" not in out.lower()
    assert surface in out  # benign content is preserved


def test_sanitize_richtext_is_the_shared_primitive():
    """``sanitize_richtext`` is the source-agnostic public name; the narrative
    path's ``sanitize_body_md`` is the same allowlist behavior."""
    for payload in XSS_PAYLOADS.values():
        assert sanitize_richtext(payload) == sanitize_body_md(payload)


def test_empty_and_none_inputs_are_safe():
    assert sanitize_richtext("") == ""
    assert sanitize_body_md("") == ""
    assert sanitize_richtext(None) == ""  # type: ignore[arg-type]


def test_plain_text_entities_are_escaped():
    out = sanitize_body_md('a & b < c > d "q"')
    assert "&amp;" in out
    assert "&lt;" in out
    assert "&gt;" in out
    assert "<c" not in out  # the literal < cannot open a tag

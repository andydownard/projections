"""M5 narrative core — sanitization, numeric grounding, stale detection (pure).

These are the hard server-side invariants (SECURITY.md §5, §6.3; API_SPEC §6.1):
  - body_md is allowlist-sanitized BEFORE storage (no script/on*/style/iframe/js:).
  - every numeric FIGURE in prose must exist in computed_json display strings, or
    generation is REJECTED (hallucinated-figure rejection).
  - stale = stored computed_hash != current computed_json hash; the diff is
    figure-level and never clobbers user edits.

RED-first: written before app/narrative.py exists.
"""
import pytest

from app.narrative import (
    GroundingError,
    compute_hash,
    extract_figures,
    grounded_figures,
    sanitize_body_md,
    stale_diff,
    validate_grounding,
)

# A minimal computed_json with the dual-value {raw, display} shape the engine emits.
VM = {
    "metrics": {
        "capital": {"raw": 277990.0, "display": "$277,990"},
        "cashGap": {"raw": -42000.0, "display": "($42,000)"},
        "breakeven": {"raw": 5, "display": "Month 5"},
    },
    "kpis": [
        {"label": "Total revenue", "value": {"raw": 426911.0, "display": "$426,911"}},
        {"label": "Net margin", "value": {"raw": 0.11, "display": "11.0%"}},
    ],
    "reco": {"tag": "proceed", "headline": "Proceed.", "sub": "..."},
}


# ----------------------------------------------------------------- sanitization
def test_sanitize_strips_script_tag():
    out = sanitize_body_md("<p>Hello</p><script>steal(localStorage.token)</script>")
    assert "<script" not in out.lower()
    assert "steal" not in out  # script BODY is dropped, not just the tag


def test_sanitize_strips_event_handlers_and_js_urls():
    out = sanitize_body_md('<a href="javascript:alert(1)" onclick="x()">x</a>')
    assert "javascript:" not in out.lower()
    assert "onclick" not in out.lower()


def test_sanitize_strips_iframe_and_style():
    out = sanitize_body_md('<iframe src="evil"></iframe><p style="x">ok</p>')
    assert "<iframe" not in out.lower()
    assert "style=" not in out.lower()


def test_sanitize_keeps_allowlisted_markup():
    out = sanitize_body_md("<p>The store reaches <strong>break-even</strong>.</p>")
    assert "<strong>" in out
    assert "<p>" in out


def test_sanitize_keeps_safe_links():
    out = sanitize_body_md('<a href="https://example.org">source</a>')
    assert 'href="https://example.org"' in out


# -------------------------------------------------------------------- grounding
def test_grounded_figures_collects_display_strings():
    figs = grounded_figures(VM)
    assert "$277,990" in figs
    assert "$426,911" in figs
    assert "11.0%" in figs


def test_extract_figures_finds_money_and_percent():
    figs = extract_figures("Capital is $277,990 and margin is 11.0%.")
    assert "$277,990" in figs
    assert "11.0%" in figs


def test_validate_grounding_passes_when_every_figure_is_real():
    body = "The store needs $277,990 in capital and reaches Month 5."
    # should not raise
    validate_grounding(body, VM)


def test_validate_grounding_rejects_hallucinated_figure():
    body = "The store needs $310,000 in capital."  # not in VM
    with pytest.raises(GroundingError) as exc:
        validate_grounding(body, VM)
    assert "$310,000" in exc.value.ungrounded


def test_validate_grounding_reports_all_ungrounded_figures():
    body = "Revenue is $999,000 with a $310,000 gap."
    with pytest.raises(GroundingError) as exc:
        validate_grounding(body, VM)
    assert set(exc.value.ungrounded) == {"$999,000", "$310,000"}


# ---------------------------------------------------------------- stale detect
def test_compute_hash_is_stable_and_sensitive():
    h1 = compute_hash(VM)
    h2 = compute_hash(dict(VM))
    assert h1 == h2
    changed = {**VM, "metrics": {**VM["metrics"],
               "capital": {"raw": 1.0, "display": "$1"}}}
    assert compute_hash(changed) != h1


def test_stale_diff_lists_changed_figures():
    old = VM
    new = {**VM, "metrics": {**VM["metrics"],
           "capital": {"raw": 277990.0, "display": "$277,990"}}}
    # identical -> empty diff
    assert stale_diff(old, new) == []
    new2 = {**VM, "metrics": {**VM["metrics"],
            "capital": {"raw": 300000.0, "display": "$300,000"}}}
    diff = stale_diff(old, new2)
    fields = {d["field"]: d for d in diff}
    assert "capital" in fields
    assert fields["capital"]["was"] == "$277,990"
    assert fields["capital"]["now"] == "$300,000"

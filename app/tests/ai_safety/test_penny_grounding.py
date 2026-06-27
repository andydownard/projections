"""PE11 §11 — Grounding (CI-blocking, stubbed providers; issue #130, extends N12).

Invariant: *any decision-metric/figure Penny states in prose must exist in the
post-edit ``computed_json`` (read back via ``read_projection``); a fabricated figure
fails closed.* N12 pins this on the narrative render path; here it is pinned on the
**Penny tool-use loop + tool surface** (PE3/PE4) — the figures Penny narrates come
only from the engine, and the same render-path backstop (``assert_no_ungrounded_money``,
which PE5's router runs over Penny's prose) rejects any ungrounded number.

No real provider call happens (the ``_no_real_network`` guard would raise); the model
is a scripted chain.
"""
from __future__ import annotations

import pytest

from app.aisafety import (
    assert_no_ungrounded_money,
    find_ungrounded_money,
    grounded_money_percent_tokens,
)
from app.penny.loop import run_turn
from app.penny.tools import build_registry

from .harness import (
    ScriptedChain,
    make_ctx,
    money_tokens,
    stored_view_model,
    text_resp,
    tool_resp,
)


def _mutate_then_read(store, projection):
    """Apply one real Penny edit through the loop; return the post-edit view-model."""
    chain = ScriptedChain(
        tool_resp("set_assumption", {"name": "labor_pct", "value": "0.50"}),
        text_resp("Updated labor."),
    )
    run_turn(
        user_message="lower labor to 0.50",
        chain=chain,
        registry=build_registry(store),
        context=make_ctx(projection),
    )
    return stored_view_model(store, projection["view_slug"])


# ------------------------------------------------------------------- grounded prose
def test_pennys_prose_figures_must_exist_in_post_edit_computed_json(store, projection):
    """A figure Penny states is grounded iff it is in the post-edit computed_json."""
    post_vm = _mutate_then_read(store, projection)
    grounded = money_tokens(post_vm)
    assert grounded, "engine must have emitted grounded $ figures to narrate"
    sample = sorted(grounded)[0]

    # Penny answers (no further tool) using ONLY a real engine figure.
    chain = ScriptedChain(text_resp(f"After that change, capital required is {sample}."))
    res = run_turn(
        user_message="what's the capital now?",
        chain=chain,
        registry=build_registry(store),
        context=make_ctx(projection, version=2),
    )
    # The render-path grounding gate (run by PE5 over Penny's prose) passes.
    assert_no_ungrounded_money(res.final_text, post_vm)  # does not raise


def test_fabricated_figure_in_penny_prose_fails_closed(store, projection):
    """A hallucinated figure NOT in computed_json is rejected — fail closed."""
    post_vm = _mutate_then_read(store, projection)
    fabricated = "$987,654,321"
    # guard: the bogus figure really is absent from the engine output
    assert fabricated.replace(",", "").replace("$", "") not in str(post_vm)
    assert fabricated not in grounded_money_percent_tokens(post_vm)

    chain = ScriptedChain(text_resp(f"Great news — capital required is only {fabricated}."))
    res = run_turn(
        user_message="how much capital?",
        chain=chain,
        registry=build_registry(store),
        context=make_ctx(projection, version=2),
    )
    # The backstop refuses to let Penny's invented figure reach a render path.
    assert find_ungrounded_money(res.final_text, post_vm) == [fabricated]
    with pytest.raises(ValueError):
        assert_no_ungrounded_money(res.final_text, post_vm)


# ----------------------------------------------- read_projection is the number source
def test_read_projection_is_grounded_and_invents_no_figure(store, projection):
    """``read_projection`` only surfaces figures the engine actually emitted."""
    registry = build_registry(store)
    ctx = make_ctx(projection, can_mutate=False)  # view-only may still read
    read = registry.get("read_projection").handler({}, ctx)

    stored = stored_view_model(store, projection["view_slug"])
    read_tokens = grounded_money_percent_tokens(read)
    stored_tokens = grounded_money_percent_tokens(stored)
    assert read_tokens, "read_projection must surface grounded figures"
    # every figure read_projection exposes traces to the stored computed_json
    assert read_tokens <= stored_tokens
    # and it equals the stored decision metrics exactly (the only source of numbers)
    assert read["metrics"]["capital"]["display"] == stored["metrics"]["capital"]["display"]
    assert read["metrics"]["breakeven"]["display"] == stored["metrics"]["breakeven"]["display"]


def test_penny_narration_diff_is_grounded_in_pre_and_post_view_models(store, projection):
    """The ``changed[]`` was->now diff Penny narrates is grounded both sides."""
    pre_vm = stored_view_model(store, projection["view_slug"])
    chain = ScriptedChain(
        tool_resp("set_assumption", {"name": "labor_pct", "value": "0.45"}),
        text_resp("Done."),
    )
    res = run_turn(
        user_message="set labor to 0.45",
        chain=chain,
        registry=build_registry(store),
        context=make_ctx(projection),
    )
    post_vm = stored_view_model(store, projection["view_slug"])
    pre_tok = grounded_money_percent_tokens(pre_vm)
    post_tok = grounded_money_percent_tokens(post_vm)
    changed = res.tool_invocations[0].result["changed"]
    assert changed, "a labor change must move grounded figures"
    for c in changed:
        # 'was' is a pre-edit grounded figure; 'now' is a post-edit grounded figure.
        if c.get("was") is not None and c["was"].startswith(("$", "(")):
            assert c["was"].replace(" ", "") in pre_tok
        if c.get("now") is not None and c["now"].startswith(("$", "(")):
            assert c["now"].replace(" ", "") in post_tok

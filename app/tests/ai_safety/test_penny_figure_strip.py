"""PE11 §11 — Figure-strip in mutate-tool args (CI-blocking; issue #130, extends N2).

Invariant: *a stubbed model that puts a computed money/percent into a mutate-tool
argument (vs. a raw user input value) is stripped/rejected server-side.* A mutate
argument is an **intent** (a bare number/fraction the user gave), never a computed
``$``/``%`` figure. ``app.aisafety.is_computed_figure_token`` is the wall; here it is
exercised **through the full PE3 loop** (the model decides to send the figure; the
server still refuses it) and on every mutate tool — so no LLM-computed figure ever
reaches the data. Stubbed providers only.
"""
from __future__ import annotations

import pytest

from app.aisafety import is_computed_figure_token
from app.penny.loop import run_turn
from app.penny.tools import build_registry

from .harness import ScriptedChain, make_ctx, text_resp, tool_resp

# Display-formatted figures only the engine's formatting layer produces (SECURITY §6.3.6).
COMPUTED_FIGURES = ["$277,990", "8%", "($41,200)", "11.0%", "50,000", "$1,234,567"]
# Bare numbers / fractions / dates — legitimate user inputs, never stripped.
RAW_INPUTS = ["0.08", "5000", "0.6", "2026-09-01"]


def _run_tool(store, projection, name, args, *, ctx=None):
    """Drive one mutate tool through the loop with a scripted model; return result."""
    chain = ScriptedChain(tool_resp(name, args), text_resp("ok"))
    res = run_turn(
        user_message="apply that",
        chain=chain,
        registry=build_registry(store),
        context=ctx or make_ctx(projection),
    )
    return res


# ----------------------------------------------- figure-strip through the loop
@pytest.mark.parametrize("bad", COMPUTED_FIGURES)
def test_computed_figure_in_override_arg_is_stripped_through_the_loop(store, projection, bad):
    res = _run_tool(store, projection, "set_override",
                    {"node": "Payroll", "year": 1, "value": bad})
    assert res.tool_invocations[0].result["error"] == "figure_stripped"
    # the loop still produced a plain final answer (a strip is data, never a 500)
    assert res.final_text == "ok"
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 1
    assert store.list_revisions(row["id"]) == []


def test_figure_strip_covers_every_mutate_tool(store, projection):
    cases = [
        ("set_input", {"field": "households", "value": "$40,000"}),
        ("set_assumption", {"name": "labor_pct", "value": "60%"}),
        ("set_override", {"node": "Payroll", "year": 2, "value": "$250,000"}),
        ("edit_cost_schedule",
         {"ops": [{"op": "add", "category": "Build-out", "month": 2, "amount": "$50,000"}]}),
    ]
    for name, args in cases:
        res = _run_tool(store, projection, name, args)
        assert res.tool_invocations[0].result["error"] == "figure_stripped", (name, args)
    # not one of those tool calls mutated the projection
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 1
    assert store.list_revisions(row["id"]) == []


def test_raw_input_value_is_not_stripped_and_applies(store, projection):
    """Negative control: a bare fraction is a legitimate intent and is applied."""
    res = _run_tool(store, projection, "set_assumption", {"name": "labor_pct", "value": "0.55"})
    assert res.tool_invocations[0].result["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 2
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"


# -------------------------------------------- the wall itself (SECURITY §6.3.6 register)
@pytest.mark.parametrize("value", COMPUTED_FIGURES + ["$5,000", "($1,000.50)", "3.5%"])
def test_is_computed_figure_token_flags_display_figures(value):
    assert is_computed_figure_token(value) is True


@pytest.mark.parametrize("value", RAW_INPUTS + ["8", "100"])
def test_is_computed_figure_token_passes_raw_inputs(value):
    assert is_computed_figure_token(value) is False


@pytest.mark.parametrize("value", [5000, 0.08, 0, True, False, None, 1234567])
def test_is_computed_figure_token_passes_non_strings(value):
    # ints/floats/bools/None are never display-formatted figures
    assert is_computed_figure_token(value) is False

"""PE11 §11 — Capability-gating + DAG/domain guards (CI-blocking; issue #130).

Invariants:
- *A view-only caller's Penny cannot mutate* (the mutate tools refuse without an edit
  capability), and the real ``apply_projection_patch`` 403 wall **backstops** the
  capability flag — Penny is never a privileged writer.
- *A non-pinnable target → 422 relayed in plain language, no mutation*, and an illegal
  override / out-of-domain input is rejected by the **same server validation the manual
  PATCH uses** (single rejection authority — Penny carries intents through the same wall).

Driven through the PE3 loop + PE4 tools with stubbed providers; the manual path uses
the real ``PATCH`` endpoint via ``TestClient``.
"""
from __future__ import annotations

from app.penny.loop import run_turn
from app.penny.tools import build_registry

from .harness import ScriptedChain, make_ctx, text_resp, tool_resp

_MUTATE_CALLS = [
    ("set_input", {"field": "households", "value": "40000"}),
    ("set_assumption", {"name": "labor_pct", "value": "0.5"}),
    ("set_override", {"node": "Payroll", "year": 1, "value": "1"}),
    ("clear_override", {"node": "Payroll", "year": 1}),
    ("edit_cost_schedule", {"ops": [{"op": "add", "category": "X", "month": 1, "amount": 1}]}),
]


def _loop_tool(store, ctx, name, args):
    chain = ScriptedChain(tool_resp(name, args), text_resp("ok"))
    return run_turn(
        user_message="please do it",
        chain=chain,
        registry=build_registry(store),
        context=ctx,
    )


# --------------------------------------------------------------- capability gating
def test_view_only_penny_cannot_mutate_through_the_loop(store, projection):
    ctx = make_ctx(projection, can_mutate=False)
    for name, args in _MUTATE_CALLS:
        res = _loop_tool(store, ctx, name, args)
        assert res.tool_invocations[0].result["error"] == "view_only", (name, res)
        # answer-only: the loop still returns a plain message (never a 500)
        assert res.final_text == "ok"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_capability_flag_is_backstopped_by_the_403_wall(store, projection):
    """Even if ``can_mutate`` were wrongly True, a non-edit token hits the 403 wall."""
    ctx = make_ctx(projection, can_mutate=True, bearer=None)  # no edit capability
    res = _loop_tool(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.5"})
    relayed = res.tool_invocations[0].result
    assert relayed["status"] == 403
    assert relayed["error"] == "forbidden"
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 1
    assert store.list_revisions(row["id"]) == []


def test_wrong_owner_token_cannot_mutate_via_penny(store, projection):
    ctx = make_ctx(projection, can_mutate=True, bearer="not-a-real-token")
    res = _loop_tool(store, ctx, "set_input", {"field": "households", "value": "40000"})
    assert res.tool_invocations[0].result["status"] == 403
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_edit_token_caller_can_mutate(store, projection):
    """Positive control: the edit capability DOES let Penny mutate (gate not over-broad)."""
    ctx = make_ctx(projection, can_mutate=True, token_key="edit_token")
    res = _loop_tool(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.5"})
    assert res.tool_invocations[0].result["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 2
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"


# --------------------------------------------------------------- DAG / domain guards
def test_non_pinnable_target_relayed_as_422_through_the_loop(store, projection):
    ctx = make_ctx(projection)
    res = _loop_tool(store, ctx, "set_override", {"node": "Net profit", "year": 1, "value": "100"})
    relayed = res.tool_invocations[0].result
    assert relayed["error"] == "node_not_pinnable"
    assert relayed["status"] == 422
    assert relayed["node"] == "Net profit"
    # plain-language relay reached the model and the loop finished (no 500)
    assert res.final_text == "ok"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_penny_and_manual_share_one_rejection_authority_for_non_pinnable(client, store, projection):
    slug, owner = projection["view_slug"], projection["owner_token"]
    bad = {"node": "Net profit", "year": 1, "value": "100"}

    # Penny path (loop + tools)
    penny = _loop_tool(store, make_ctx(projection), "set_override", bad).tool_invocations[0].result

    # Manual path (the real PATCH endpoint)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"overrides": {"set": [bad]}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    manual = r.json().get("detail", r.json())

    # SAME rejection authority — identical error + node, both 422, neither mutates.
    assert r.status_code == 422
    assert penny["error"] == manual["error"] == "node_not_pinnable"
    assert penny["node"] == manual["node"] == "Net profit"
    assert client.get(f"/api/projections/{slug}").json()["version"] == 1


def test_out_of_domain_cost_input_rejected_by_same_authority(client, store, projection):
    slug, owner = projection["view_slug"], projection["owner_token"]

    # Penny: an opening anchor below 1 is out of domain.
    penny = _loop_tool(
        store, make_ctx(projection), "edit_cost_schedule",
        {"ops": [], "opening_month_number": 0},
    ).tool_invocations[0].result

    # Manual: the same invalid input through the real PATCH.
    r = client.patch(
        f"/api/projections/{slug}",
        json={"inputs": {"opening_month_number": 0}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    manual = r.json().get("detail", r.json())

    assert r.status_code == 422
    assert penny["error"] == manual["error"] == "invalid_inputs"
    assert client.get(f"/api/projections/{slug}").json()["version"] == 1


def test_unknown_assumption_field_is_rejected(store, projection):
    res = _loop_tool(store, make_ctx(projection), "set_assumption",
                     {"name": "totally_made_up", "value": "1"})
    assert res.tool_invocations[0].result["error"] == "unknown_field"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


# --------------------------------------------------------------- stale version (409)
def test_stale_version_surfaces_409_for_retry_through_the_loop(store, projection):
    ctx = make_ctx(projection, version=99)  # someone else already moved the version
    res = _loop_tool(store, ctx, "set_input", {"field": "households", "value": "40000"})
    relayed = res.tool_invocations[0].result
    assert relayed["error"] == "version_conflict"
    assert relayed["status"] == 409
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1

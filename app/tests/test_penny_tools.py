"""RED-first tests for app/penny/tools.py (Penny PE4 — issue #123, spec §4/§6.2).

The seven Penny tools, each routing every mutation through the EXISTING server
PATCH/If-Match mutation/recompute service (no parallel writer). STUBBED providers
only — these tests call the tool handlers directly and via the PE3 loop with a
scripted chain; no real provider call ever happens.

Invariants pinned (spec §4/§6.2, §11; SECURITY §6.3):
- every mutate tool -> the existing PATCH path -> version++ -> ONE revision tagged
  ``actor:penny`` -> returns the recomputed view-model diff (changed[] was->now);
- a view-only caller (``can_mutate=False``) cannot mutate (answer-only refusal);
- a non-pinnable override target -> 422 ``node_not_pinnable`` relayed in plain data;
- a computed money/percent figure in a mutate-tool arg is stripped/rejected
  server-side (no LLM figure is ever applied);
- ``edit_cost_schedule`` is server-validated (month>=1, amount>=0, opening>=1) and
  AI-created rows carry provenance;
- ``read_projection`` is grounded (figures come from the stored computed_json);
- a stale version (409) is surfaced to the loop for re-read/retry.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.penny import tools as T
from app.penny.loop import ToolContext, run_turn
from app.penny.providers import ProviderResponse, ToolCall, Usage
from app.store import get_store
from app.store.sqlite import SqliteStore

SEVEN_TOOLS = {
    "read_projection",
    "parse_proposal",
    "set_input",
    "set_assumption",
    "set_override",
    "clear_override",
    "edit_cost_schedule",
}

VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope",
        "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def projection(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def _ctx(projection, *, can_mutate=True, version=1, token_key="owner_token", **extra):
    return ToolContext(
        view_slug=projection["view_slug"],
        bearer_token=projection[token_key],
        can_mutate=can_mutate,
        version=version,
        extra=extra,
    )


def _reg(store):
    return T.build_registry(store)


def _run(store, ctx, name, args):
    return _reg(store).get(name).handler(args, ctx)


def _revisions(store, slug):
    row = store.get_projection_by_slug(slug)
    return row, store.list_revisions(row["id"])


# ----------------------------------------------------------------- registration
def test_build_registry_registers_exactly_the_seven_tools(store):
    reg = _reg(store)
    assert set(reg.names()) == SEVEN_TOOLS


def test_each_tool_has_a_schema_and_kind(store):
    reg = _reg(store)
    for name in SEVEN_TOOLS:
        tool = reg.get(name)
        assert tool is not None
        assert tool.input_schema.get("type") == "object"
        assert tool.kind in {"read", "extract", "mutate"}


def test_read_and_parse_are_not_mutate(store):
    reg = _reg(store)
    assert reg.get("read_projection").kind == "read"
    assert reg.get("parse_proposal").kind in {"read", "extract"}
    for name in ("set_input", "set_assumption", "set_override",
                 "clear_override", "edit_cost_schedule"):
        assert reg.get(name).kind == "mutate"


# ------------------------------------------------------------- read_projection
def test_read_projection_is_grounded_in_stored_computed_json(store, projection):
    ctx = _ctx(projection, can_mutate=False)  # view-only can still read
    res = _run(store, ctx, "read_projection", {})
    stored = projection  # the create response is the stored view-model
    assert res["version"] == 1
    assert res["metrics"]["capital"]["display"] == stored["metrics"]["capital"]["display"]
    assert res["metrics"]["breakeven"]["display"] == stored["metrics"]["breakeven"]["display"]
    # rows + overrides + cost schedule + editable surface all present
    assert any(r["label"] == "Payroll" for r in res["rows"])
    assert "cost_schedule" in res and isinstance(res["cost_schedule"], list)
    assert res["editable_surface"]["inputs"]["share_y1"] == "0.06"
    assert res["editable_surface"]["assumptions"]["labor_pct"] == "0.60"


# ------------------------------------------------------------------- set_input
def test_set_input_routes_through_patch_and_tags_actor_penny(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_input", {"field": "households", "value": "40000"})
    assert res["applied"] is True
    assert res["version"] == 2
    assert res["actor"] == "penny"
    assert res["changed"]  # was->now diff is non-empty (revenue moved)
    assert all("was" in c and "now" in c and "label" in c for c in res["changed"])

    row, revs = _revisions(store, projection["view_slug"])
    assert row["version"] == 2
    assert len(revs) == 1
    assert revs[0]["actor"] == "penny"
    assert revs[0]["seq"] == 2
    # the context version advanced for the next mutation in the same turn
    assert ctx.version == 2


def test_set_input_name_only_change(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_input", {"field": "name", "value": "New Name"})
    assert res["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["name"] == "New Name"


def test_set_input_unknown_field_is_rejected_not_applied(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_input", {"field": "bogus", "value": "1"})
    assert res.get("error") == "unknown_field"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


# -------------------------------------------------------------- set_assumption
def test_set_assumption_labor_pct_via_patch(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.50"})
    assert res["applied"] is True and res["version"] == 2
    row = store.get_projection_by_slug(projection["view_slug"])
    assert json.loads(row["assumptions_json"])["labor_pct"] == "0.50"
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"


def test_set_assumption_share_routes_to_inputs(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_assumption", {"name": "share_y1", "value": "0.08"})
    assert res["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert json.loads(row["inputs_json"])["share_y1"] == "0.08"


# ----------------------------------------------------- set/clear override + DAG
def test_set_override_pins_component_and_clears_it(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_override",
               {"node": "Payroll", "year": 2, "value": "250000", "note": "2 hires"})
    assert res["applied"] is True and res["version"] == 2
    row = store.get_projection_by_slug(projection["view_slug"])
    assert "Payroll#2" in json.loads(row["overrides_json"])
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"

    # clear it (same context — version tracked to 2)
    res2 = _run(store, ctx, "clear_override", {"node": "Payroll", "year": 2})
    assert res2["applied"] is True and res2["version"] == 3
    row = store.get_projection_by_slug(projection["view_slug"])
    assert json.loads(row["overrides_json"]) == {}


def test_set_override_non_pinnable_relays_422(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_override",
               {"node": "net_profit", "year": 1, "value": "100"})
    assert res.get("error") == "node_not_pinnable"
    assert res.get("status") == 422
    assert res.get("node") == "net_profit"
    # nothing applied
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


# -------------------------------------------------------- capability gating
def test_view_only_caller_cannot_mutate(store, projection):
    ctx = _ctx(projection, can_mutate=False)
    for name, args in (
        ("set_input", {"field": "households", "value": "40000"}),
        ("set_assumption", {"name": "labor_pct", "value": "0.5"}),
        ("set_override", {"node": "Payroll", "year": 1, "value": "1"}),
        ("clear_override", {"node": "Payroll", "year": 1}),
        ("edit_cost_schedule", {"ops": [{"op": "add", "category": "X",
                                         "month": 1, "amount": 1}]}),
    ):
        res = _run(store, ctx, name, args)
        assert res.get("error") == "view_only", (name, res)
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


# ----------------------------------------------------------------- figure-strip
@pytest.mark.parametrize("bad", ["$277,990", "8%", "($41,200)", "11.0%", "50,000"])
def test_computed_figure_in_mutate_arg_is_stripped(store, projection, bad):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_override",
               {"node": "Payroll", "year": 1, "value": bad})
    assert res.get("error") == "figure_stripped"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_figure_strip_applies_to_set_input_and_assumption(store, projection):
    ctx = _ctx(projection)
    assert _run(store, ctx, "set_input",
                {"field": "households", "value": "$40,000"})["error"] == "figure_stripped"
    assert _run(store, ctx, "set_assumption",
                {"name": "labor_pct", "value": "60%"})["error"] == "figure_stripped"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_raw_user_value_is_not_stripped(store, projection):
    ctx = _ctx(projection)
    # a bare fraction / number is a legitimate user input, never stripped
    res = _run(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.55"})
    assert res["applied"] is True


# ------------------------------------------------------------ edit_cost_schedule
def test_edit_cost_schedule_add_with_provenance(store, projection):
    ctx = _ctx(projection, turn_id="turn-7")
    res = _run(store, ctx, "edit_cost_schedule",
               {"ops": [{"op": "add", "category": "Build-out",
                         "month": 2, "amount": 50000}]})
    assert res["applied"] is True and res["version"] == 2
    row = store.get_projection_by_slug(projection["view_slug"])
    sched = json.loads(row["inputs_json"])["cost_schedule"]
    added = [r for r in sched if r["category"] == "Build-out" and r["month"] == 2]
    assert len(added) == 1
    assert added[0]["amount"] == 50000
    assert added[0]["provenance"]["source"] == "ai"
    assert added[0]["provenance"]["turn_id"] == "turn-7"
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"


def test_edit_cost_schedule_edit_and_remove(store, projection):
    ctx = _ctx(projection)
    _run(store, ctx, "edit_cost_schedule",
         {"ops": [{"op": "add", "category": "Signage", "month": 3, "amount": 8000}]})
    # edit the amount
    _run(store, ctx, "edit_cost_schedule",
         {"ops": [{"op": "edit", "category": "Signage", "month": 3, "amount": 9000}]})
    sched = json.loads(
        store.get_projection_by_slug(projection["view_slug"])["inputs_json"]
    )["cost_schedule"]
    assert [r for r in sched if r["category"] == "Signage"][0]["amount"] == 9000
    # remove it
    _run(store, ctx, "edit_cost_schedule",
         {"ops": [{"op": "remove", "category": "Signage", "month": 3}]})
    sched = json.loads(
        store.get_projection_by_slug(projection["view_slug"])["inputs_json"]
    )["cost_schedule"]
    assert not [r for r in sched if r["category"] == "Signage"]


def test_edit_cost_schedule_sets_opening_anchor(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "edit_cost_schedule", {"ops": [], "opening_month_number": 5})
    assert res["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert json.loads(row["inputs_json"])["opening_month_number"] == 5
    assert row["opening_month_number"] == 5


@pytest.mark.parametrize("op,expect", [
    ({"op": "add", "category": "X", "month": 0, "amount": 10}, "invalid_inputs"),
    ({"op": "add", "category": "X", "month": 1, "amount": -5}, "invalid_inputs"),
])
def test_edit_cost_schedule_server_validates(store, projection, op, expect):
    ctx = _ctx(projection)
    res = _run(store, ctx, "edit_cost_schedule", {"ops": [op]})
    assert res.get("error") == expect
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_edit_cost_schedule_opening_below_one_rejected(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "edit_cost_schedule",
               {"ops": [], "opening_month_number": 0})
    assert res.get("error") == "invalid_inputs"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_edit_cost_schedule_amount_figure_stripped(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "edit_cost_schedule",
               {"ops": [{"op": "add", "category": "X", "month": 1, "amount": "$50,000"}]})
    assert res.get("error") == "figure_stripped"
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_provenance_row_survives_a_later_manual_patch(client, store, projection):
    """A Penny-created provenance row must not break the manual autosave path: the
    SAME server validator (`_validate_schedule_inputs`) runs on the next manual
    PATCH, so it must tolerate the provenance key (else manual edits 422 forever)."""
    ctx = _ctx(projection)
    _run(store, ctx, "edit_cost_schedule",
         {"ops": [{"op": "add", "category": "Build-out", "month": 2, "amount": 50000}]})
    slug, owner = projection["view_slug"], projection["owner_token"]
    # a manual PATCH of an unrelated field must still succeed (no 422 on provenance)
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.55"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "2"},
    )
    assert r.status_code == 200, r.text
    sched = json.loads(store.get_projection_by_slug(slug)["inputs_json"])["cost_schedule"]
    kept = [row for row in sched if row["category"] == "Build-out"][0]
    assert kept["provenance"]["source"] == "ai"  # provenance preserved across the patch


def test_read_projection_reflects_a_penny_edit(store, projection):
    ctx = _ctx(projection)
    _run(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.50"})
    res = _run(store, ctx, "read_projection", {})
    assert res["version"] == 2
    assert res["editable_surface"]["assumptions"]["labor_pct"] == "0.50"
    # grounded: the read-back metrics equal the freshly stored computed_json
    stored = json.loads(store.get_projection_by_slug(projection["view_slug"])["computed_json"])
    assert res["metrics"]["capital"]["display"] == stored["metrics"]["capital"]["display"]


@pytest.mark.parametrize("name,bucket", [
    ("labor_pct", "assumptions"), ("marketing_pct", "assumptions"),
    ("supplies_pct", "assumptions"), ("escalator", "assumptions"),
    ("share_y2", "inputs"), ("rent_per_sqft", "inputs"),
])
def test_assumption_fields_route_to_correct_bucket(store, projection, name, bucket):
    ctx = _ctx(projection)
    res = _run(store, ctx, "set_assumption", {"name": name, "value": "0.07"})
    assert res["applied"] is True
    row = store.get_projection_by_slug(projection["view_slug"])
    assert json.loads(row[f"{bucket}_json"])[name] == "0.07"


def test_clear_override_on_absent_pin_is_idempotent(store, projection):
    ctx = _ctx(projection)
    # clearing a pin that was never set still routes through PATCH (a no-op edit)
    res = _run(store, ctx, "clear_override", {"node": "Payroll", "year": 1})
    assert res["applied"] is True
    assert json.loads(store.get_projection_by_slug(projection["view_slug"])["overrides_json"]) == {}


# ----------------------------------------------------------- concurrency (409)
def test_stale_version_surfaces_409_for_retry(store, projection):
    ctx = _ctx(projection, version=99)  # someone else already moved the version
    res = _run(store, ctx, "set_input", {"field": "households", "value": "40000"})
    assert res.get("error") == "version_conflict"
    assert res.get("status") == 409
    assert store.get_projection_by_slug(projection["view_slug"])["version"] == 1


def test_mutate_with_unset_version_fails_closed_no_self_match(client, store, projection):
    """RED #165: an unset ``ctx.version`` (the merged PE5 default) must NOT be back-
    filled from a fresh read (the old ``else int(row['version'])`` self-match), which
    would let Penny blind-overwrite a concurrent edit. With no grounded version the
    write is refused with the SAME 428 the manual PATCH raises (deps.parse_if_match):
    Penny hits the identical optimistic-concurrency wall as the UI, no privileged path.
    """
    slug, owner = projection["view_slug"], projection["owner_token"]
    # a concurrent human edit moves the version behind Penny's back (1 -> 2).
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.42"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert store.get_projection_by_slug(slug)["version"] == 2

    ctx = _ctx(projection, version=None)  # PE5 didn't thread a request If-Match
    res = _run(store, ctx, "set_assumption", {"name": "labor_pct", "value": "0.50"})
    # fail closed — never a silent self-matched apply.
    assert res.get("applied") is not True
    assert res.get("status") == 428
    assert res.get("error") == "if_match_required"
    # the concurrent human edit survives untouched.
    row = store.get_projection_by_slug(slug)
    assert row["version"] == 2
    assert json.loads(row["assumptions_json"])["labor_pct"] == "0.42"


def test_penny_loop_threads_grounded_version_no_lost_update(client, store, projection):
    """RED #165: Penny grounds on the version it read at the start of the turn; the
    loop threads that version into ``ToolContext.version`` so every mutate carries it
    as ``If-Match``. A concurrent external edit that moves the version makes Penny's
    stale write a real 409 (surfaced for re-read/retry) instead of silently clobbering
    the human's edit — the lost-update Regression #9 / Mutation-Safety item 3 for AI.
    """
    slug, owner = projection["view_slug"], projection["owner_token"]

    # Penny grounds on what it read at the start of the turn: version 1, labor 0.60.
    grounding = _run(store, _ctx(projection, version=1), "read_projection", {})
    assert grounding["version"] == 1

    # A concurrent human edit lands BEFORE Penny's tool fires (1 -> 2, labor 0.42).
    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.42"}},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert store.get_projection_by_slug(slug)["version"] == 2

    # Penny (grounded on v1) tries to set labor to 0.50. ctx.version is the merged
    # default (None); the loop must thread the grounded v1 so this stale write 409s.
    tool_call = ProviderResponse(
        provider="anthropic",
        tool_calls=[ToolCall(id="tu_1", name="set_assumption",
                             arguments={"name": "labor_pct", "value": "0.50"})],
        stop_reason="tool_use",
        usage=Usage(1, 1),
    )
    done = ProviderResponse(provider="anthropic",
                            text="I hit a conflict — let me re-read the latest numbers.",
                            usage=Usage(1, 1))
    chain = _ScriptedChain(tool_call, done)
    ctx = ToolContext(view_slug=slug, bearer_token=owner, can_mutate=True, version=None)
    res = run_turn(
        user_message="set labor to 0.50",
        chain=chain,
        registry=_reg(store),
        context=ctx,
        grounding_context=grounding,
    )

    inv = res.tool_invocations[0]
    assert inv.name == "set_assumption"
    assert inv.result.get("error") == "version_conflict"  # surfaced, not applied
    assert inv.result.get("status") == 409
    assert inv.result.get("applied") is not True
    # the loop grounded the context to the version it actually read.
    assert ctx.version == 1
    # the concurrent human edit SURVIVES — Penny did not clobber labor 0.42.
    row = store.get_projection_by_slug(slug)
    assert row["version"] == 2
    assert json.loads(row["assumptions_json"])["labor_pct"] == "0.42"


# ----------------------------------------------------------------- parse_proposal
def test_parse_proposal_is_extract_only_and_untrusted(store, projection):
    ctx = _ctx(projection)
    text = "Phase 1 build-out $50,000. Phase 2 equipment $12,000."
    res = _run(store, ctx, "parse_proposal", {"proposal_text": text})
    assert res["extract_only"] is True
    assert res["untrusted"] is True
    figures = {c["amount_text"] for c in res["candidates"]}
    # every figure traces to the document; nothing invented
    assert "$50,000" in figures
    assert "$12,000" in figures
    assert all(f in text for f in figures)


def test_parse_proposal_invents_no_numbers_when_absent(store, projection):
    ctx = _ctx(projection)
    res = _run(store, ctx, "parse_proposal",
               {"proposal_text": "Phase 1: design & permitting. Phase 2: build-out."})
    assert res["candidates"] == []


# ----------------------------------------------- end-to-end via the PE3 loop
class _ScriptedChain:
    def __init__(self, *responses, providers=("anthropic",)):
        self._responses = list(responses)
        self.calls = []
        self.providers = list(providers)

    def complete(self, request):
        self.calls.append(request)
        return self._responses.pop(0) if self._responses else ProviderResponse(
            provider="anthropic", text="done", usage=Usage(1, 1))


def test_tool_runs_through_the_pe3_loop_and_mutates(store, projection):
    tool_call = ProviderResponse(
        provider="anthropic",
        tool_calls=[ToolCall(id="tu_1", name="set_assumption",
                             arguments={"name": "labor_pct", "value": "0.50"})],
        stop_reason="tool_use",
        usage=Usage(1, 1),
    )
    done = ProviderResponse(provider="anthropic", text="Done — labor is now 50%.",
                            usage=Usage(1, 1))
    chain = _ScriptedChain(tool_call, done)
    ctx = _ctx(projection)
    res = run_turn(
        user_message="Set labor to 0.50",
        chain=chain,
        registry=_reg(store),
        context=ctx,
        grounding_context={"metrics": {"breakeven": {"display": "month 6"}}},
    )
    assert res.final_text == "Done — labor is now 50%."
    assert res.tool_invocations[0].name == "set_assumption"
    assert res.tool_invocations[0].is_error is False
    row = store.get_projection_by_slug(projection["view_slug"])
    assert row["version"] == 2
    assert store.list_revisions(row["id"])[0]["actor"] == "penny"

"""PE5 — POST /penny + /penny/draft + /penny/proposal (Spec B §6.1/§12; issue #124).

RED-first. These exercise the three Penny write/loop endpoints with **stubbed
providers only** (a scripted fake chain — never a real api.anthropic.com /
api.openai.com call). The behaviours pinned:

- detail `POST …/penny` runs the bounded loop; a mutate tool applies via the
  EXISTING server PATCH path (version++ + one ``actor:penny`` revision) and the
  recomputed view-model diff is relayed in ``applied_revisions``; turns persist;
- capability-gating: a view-only caller's Penny is answer-only (no mutation, no
  ``actor:penny`` revision, nothing persisted to the owner's transcript);
- error contract: ``409 ai_disabled`` makes ZERO provider calls; both providers
  down -> ``503 ai_unavailable``; a rate-limit breach -> ``429`` with
  ``retry_after_seconds`` BEFORE any provider call;
- `POST /api/penny/draft` mutates only the supplied draft and persists NOTHING;
- `POST /api/penny/proposal` guards type/size/SSRF and returns a ``proposal_ref``
  for an accepted upload (never executed/rendered).
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.penny import proposal as proposal_intake
from app.penny.providers import AIUnavailableError, ProviderResponse, ToolCall, Usage
from app.ratelimit import reset_rate_limits
from app.routers import penny as penny_router
from app.store import get_store
from app.store.sqlite import SqliteStore

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


# --------------------------------------------------------------------- doubles
class ScriptedChain:
    """A fake provider chain: returns queued ProviderResponses (or raises)."""

    def __init__(self, *responses, providers=("anthropic",)):
        self._responses = list(responses)
        self.calls = []
        self.providers = list(providers)

    def complete(self, request):
        self.calls.append(request)
        item = self._responses.pop(0) if self._responses else _text("done")
        if isinstance(item, Exception):
            raise item
        return item


def _text(text, in_tok=4, out_tok=4):
    return ProviderResponse(
        provider="anthropic", text=text, stop_reason="end_turn",
        usage=Usage(input_tokens=in_tok, output_tokens=out_tok))


def _tool(name, args, *, call_id="tu_1", text=""):
    return ProviderResponse(
        provider="anthropic", text=text,
        tool_calls=[ToolCall(id=call_id, name=name, arguments=args)],
        stop_reason="tool_use", usage=Usage(input_tokens=4, output_tokens=4))


# --------------------------------------------------------------------- fixtures
@pytest.fixture(autouse=True)
def _clear_limits():
    reset_rate_limits()
    proposal_intake.reset_proposals()
    yield
    reset_rate_limits()
    proposal_intake.reset_proposals()


def _tools(*calls, text=""):
    """A single provider response that requests MULTIPLE tool calls in one turn."""
    return ProviderResponse(
        provider="anthropic", text=text,
        tool_calls=[ToolCall(id=cid, name=name, arguments=args) for name, args, cid in calls],
        stop_reason="tool_use", usage=Usage(input_tokens=4, output_tokens=4))


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


def _use_chain(client, chain):
    client.app.dependency_overrides[penny_router.get_penny_chain] = lambda: chain
    return chain


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _set_ai_opt_out(store, slug):
    row = store.get_projection_by_slug(slug)
    store._conn.execute(
        "UPDATE projections SET ai_opt_out = 1 WHERE id = ?", (row["id"],))
    store._conn.commit()


def _penny_url(slug):
    return f"/api/projections/{slug}/penny"


def _auth(tok):
    return {"Authorization": f"Bearer {tok}"}


# ============================================================ detail: happy path
def test_detail_penny_applies_via_patch_and_persists(client, store):
    p = _create(client)
    chain = _use_chain(client, ScriptedChain(
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}),
        _text("Done — I lowered the labor assumption; the capital figure updated."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "cut labor to 0.55"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "anthropic"
    assert body["narration"].startswith("Done")
    # mutation went through the normal write path: version++ + actor:penny revision
    assert len(body["applied_revisions"]) == 1
    applied = body["applied_revisions"][0]
    assert applied["version"] == 2
    assert applied["actor"] == "penny"
    assert applied["changed"], "the recomputed view-model diff must be relayed"

    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 2
    revs = store.list_revisions(row["id"])
    assert any(rv["actor"] == "penny" and rv["seq"] == 2 for rv in revs)

    # turns are persisted to the per-project transcript (read back via GET seam)
    tr = client.get(_penny_url(p["view_slug"]) + "/transcript",
                    headers=_auth(p["owner_token"]))
    assert tr.status_code == 200
    contents = [t["content"] for t in tr.json()["turns"]]
    assert "cut labor to 0.55" in contents
    assert any(c.startswith("Done") for c in contents)
    assert chain.calls, "the loop must have called the provider"


def test_detail_penny_unknown_slug_404(client):
    _use_chain(client, ScriptedChain(_text("hi")))
    r = client.post(_penny_url("nope"), json={"message": "hi"},
                    headers=_auth("whatever"))
    assert r.status_code == 404


# ====================================================== capability: answer-only
def test_view_only_caller_is_answer_only(client, store):
    p = _create(client)
    chain = _use_chain(client, ScriptedChain(
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}),
        _text("I can explain the numbers, but I can't edit from a view-only link."),
    ))
    # No Authorization header => view-only caller.
    r = client.post(_penny_url(p["view_slug"]), json={"message": "cut labor"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied_revisions"] == []
    assert body["narration"]
    # nothing mutated, no actor:penny revision, version unchanged
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 1
    assert not any(rv["actor"] == "penny" for rv in store.list_revisions(row["id"]))
    # a random viewer cannot pollute the owner's persisted transcript
    tr = client.get(_penny_url(p["view_slug"]) + "/transcript",
                    headers=_auth(p["owner_token"]))
    assert tr.json()["turns"] == []
    assert chain.calls, "answer-only still runs the loop"


# =============================================================== error contract
def test_ai_disabled_returns_409_with_zero_provider_calls(client, store):
    p = _create(client)
    _set_ai_opt_out(store, p["view_slug"])
    chain = _use_chain(client, ScriptedChain(_text("should never run")))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "ai_disabled"
    assert chain.calls == [], "ai-disabled must make ZERO provider calls"


def test_no_provider_configured_is_ai_disabled(client):
    p = _create(client)
    # empty chain (no keys) => AI disabled, zero calls
    chain = _use_chain(client, ScriptedChain(_text("x"), providers=()))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 409
    assert chain.calls == []


def test_both_providers_down_returns_503(client):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        AIUnavailableError("anthropic+openai down"), providers=("anthropic", "openai")))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 503
    assert r.json()["detail"]["error"] == "ai_unavailable"


def test_rate_limited_returns_429_with_retry_after(client, monkeypatch):
    p = _create(client)
    chain = _use_chain(client, ScriptedChain(_text("x")))
    monkeypatch.setattr(
        penny_router, "_check_rate", lambda ip, token, projection_id=None: (False, 30))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 429
    assert r.json()["detail"]["retry_after_seconds"] == 30
    assert r.headers.get("Retry-After") == "30"
    assert chain.calls == [], "a rate-limit breach must not call a provider"


# =================================== #189: per-token / per-projection keying, NOT
# the shared Railway proxy IP. Every external user sits behind ONE proxy IP, so a
# per-IP Penny cap is a single GLOBAL bucket: one owner's turns lock out everyone
# else (collateral lockout), and a token-mint abuser evades the per-token cap while
# the per-IP brake can't isolate them. The PRIMARY key must be the caller's
# capability token and/or the projection; the per-IP cap is a coarse safety bound.
def _xff(tok, ip):
    return {**_auth(tok), "X-Forwarded-For": f"9.9.9.9, {ip}"}


def test_two_different_owners_do_not_share_a_penny_bucket(client, monkeypatch):
    # Owner A exhausting their budget must NOT 429 owner B. Two distinct clients (two
    # right-most XFF hops, two tokens, two projections) get INDEPENDENT buckets; the
    # buggy raw-socket-host keying collapsed them onto the shared proxy IP.
    monkeypatch.setattr(penny_router, "_PENNY_IP_LIMIT", 2, raising=False)
    a = _create(client)
    b = _create(client)
    _use_chain(client, ScriptedChain(_text("ok")))
    for _ in range(2):
        r = client.post(_penny_url(a["view_slug"]), json={"message": "hi"},
                        headers=_xff(a["owner_token"], "1.1.1.1"))
        assert r.status_code == 200, r.text
    # owner A is now capped (their own bucket)...
    ra = client.post(_penny_url(a["view_slug"]), json={"message": "hi"},
                     headers=_xff(a["owner_token"], "1.1.1.1"))
    assert ra.status_code == 429, ra.text
    # ...but owner B (different token + projection + client IP) is NOT collateral-locked.
    rb = client.post(_penny_url(b["view_slug"]), json={"message": "hi"},
                     headers=_xff(b["owner_token"], "2.2.2.2"))
    assert rb.status_code == 200, rb.text


def test_single_owner_projection_is_still_capped_with_retry_after(client, monkeypatch):
    # The primary per-token brake must still fire: one owner over their cap -> 429 +
    # retry_after_seconds, BEFORE any provider call (Spec §6.1 / API_SPEC §6.6).
    monkeypatch.setattr(penny_router, "_PENNY_TOKEN_LIMIT", 3, raising=False)
    p = _create(client)
    _use_chain(client, ScriptedChain(_text("ok")))
    for _ in range(3):
        r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                        headers=_auth(p["owner_token"]))
        assert r.status_code == 200, r.text
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["error"] == "rate_limited"
    assert r.json()["detail"]["retry_after_seconds"] >= 1
    assert int(r.headers["Retry-After"]) >= 1


def test_anonymous_penny_is_capped_per_projection_not_globally(client, monkeypatch):
    # Worst case from #189: an anonymous (view-only, no-token) turn skips the token
    # scope, so WITHOUT a per-projection key it falls back to the single shared-IP
    # bucket. Two different projections must NOT share an anonymous bucket.
    monkeypatch.setattr(penny_router, "_PENNY_PROJECTION_LIMIT", 2, raising=False)
    a = _create(client)
    b = _create(client)
    _use_chain(client, ScriptedChain(_text("ok")))
    for _ in range(2):  # no Authorization header => view-only / answer-only
        assert client.post(_penny_url(a["view_slug"]),
                           json={"message": "hi"}).status_code == 200
    # projection A's anonymous bucket is capped...
    ra = client.post(_penny_url(a["view_slug"]), json={"message": "hi"})
    assert ra.status_code == 429, ra.text
    # ...projection B is an independent bucket.
    rb = client.post(_penny_url(b["view_slug"]), json={"message": "hi"})
    assert rb.status_code == 200, rb.text


def test_penny_rate_limit_keys_on_hashed_token_not_raw(client):
    # The bearer is a capability SECRET: it must never become a limiter key verbatim
    # (no plaintext token in process memory keys / any future log). Reuse the at-rest
    # SHA-256 digest (SECURITY §2.3 / §10.1).
    from app import ratelimit
    from app.deps import hash_token
    p = _create(client)
    _use_chain(client, ScriptedChain(_text("ok")))
    tok = p["owner_token"]
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(tok))
    assert r.status_code == 200, r.text
    token_keys = [k for (_endpoint, scope, k) in ratelimit._hits if scope == "token"]
    assert token_keys, "a per-token bucket must exist for an authorized caller"
    assert tok not in token_keys, "the RAW capability token must never be a limiter key"
    assert hash_token(tok) in token_keys, "the bucket must key on the SHA-256 token hash"


def test_draft_two_different_tokens_do_not_share_a_bucket(client, monkeypatch):
    # /penny/draft has no projection, so the per-token (hashed) key is the SOLE primary
    # brake. Two different edit bearers must NOT share a bucket (no shared-IP collapse).
    monkeypatch.setattr(penny_router, "_PENNY_TOKEN_LIMIT", 2, raising=False)
    monkeypatch.setattr(penny_router, "_PENNY_IP_LIMIT", 1000, raising=False)
    _use_chain(client, ScriptedChain(_text("ok")))
    body = {"message": "tweak", "draft_state": {"inputs": {"city": "Longview, Texas"}}}
    for _ in range(2):
        assert client.post("/api/penny/draft", headers=_auth("tok-A"),
                           json=body).status_code == 200
    # tok-A has spent its budget...
    assert client.post("/api/penny/draft", headers=_auth("tok-A"),
                       json=body).status_code == 429
    # ...tok-B is an independent bucket.
    assert client.post("/api/penny/draft", headers=_auth("tok-B"),
                       json=body).status_code == 200


def test_penny_per_ip_coarse_bound_still_caps_a_single_real_ip(client, monkeypatch):
    # The per-IP cap is DEMOTED to a coarse bound, not removed: a genuine flood from
    # ONE real client IP (same right-most XFF hop) still trips 429 even as the caller
    # rotates tokens/projections to dodge the per-token/per-projection brakes (#189).
    monkeypatch.setattr(penny_router, "_PENNY_IP_LIMIT", 2, raising=False)
    a = _create(client)
    b = _create(client)
    _use_chain(client, ScriptedChain(_text("ok")))
    # two distinct tokens + projections, but the SAME real client IP
    assert client.post(_penny_url(a["view_slug"]), json={"message": "hi"},
                       headers=_xff(a["owner_token"], "5.5.5.5")).status_code == 200
    assert client.post(_penny_url(b["view_slug"]), json={"message": "hi"},
                       headers=_xff(b["owner_token"], "5.5.5.5")).status_code == 200
    # the shared real IP has hit the coarse bound -> 429 despite a fresh token/projection
    r = client.post(_penny_url(a["view_slug"]), json={"message": "hi"},
                    headers=_xff(a["owner_token"], "5.5.5.5"))
    assert r.status_code == 429, r.text


# ==================================================================== draft loop
def test_draft_mutates_supplied_draft_and_persists_nothing(client, store):
    chain = _use_chain(client, ScriptedChain(
        _tool("set_input", {"field": "city", "value": "Tyler, Texas"}),
        _text("Updated the city to Tyler, Texas in your draft."),
    ))
    r = client.post("/api/penny/draft", headers=_auth("edit-tok"), json={
        "message": "set the city to Tyler",
        "draft_state": {"inputs": {"city": "Longview, Texas"}},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["draft"]["inputs"]["city"] == "Tyler, Texas"
    assert body["narration"]
    # NOTHING persisted: no transcript rows, no projections created by the draft
    n_tr = store._conn.execute("SELECT COUNT(*) FROM penny_transcripts").fetchone()[0]
    assert n_tr == 0
    n_proj = store._conn.execute("SELECT COUNT(*) FROM projections").fetchone()[0]
    assert n_proj == 0
    assert chain.calls


def test_draft_requires_bearer(client):
    _use_chain(client, ScriptedChain(_text("x")))
    r = client.post("/api/penny/draft", json={"message": "hi", "draft_state": {}})
    assert r.status_code == 403


# =============================================================== proposal upload
def _pdf(n_extra=0):
    return b"%PDF-1.4\n" + b"x" * n_extra + b"\n%%EOF\n"


def test_proposal_upload_accepts_pdf_and_returns_ref(client):
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=_pdf(64),
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 201, r.text
    ref = r.json()["proposal_ref"]
    assert ref
    # a second upload gets a distinct ref (never collides / overwrites)
    r2 = client.post("/api/penny/proposal?filename=plan2.pdf", content=_pdf(8),
                     headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r2.status_code == 201
    assert r2.json()["proposal_ref"] != ref


def test_proposal_rejects_non_pdf_type(client):
    r = client.post("/api/penny/proposal?filename=notes.txt",
                    content=b"just some text, not a pdf",
                    headers={**_auth("tok"), "Content-Type": "text/plain"})
    assert r.status_code == 415
    assert r.json()["detail"]["error"] == "unsupported_type"


def test_proposal_rejects_oversize(client, monkeypatch):
    from app.penny import proposal
    monkeypatch.setattr(proposal, "MAX_PROPOSAL_BYTES", 8)
    r = client.post("/api/penny/proposal?filename=big.pdf", content=_pdf(64),
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 413
    assert r.json()["detail"]["error"] == "file_too_large"


def test_proposal_blocks_ssrf_source_url(client):
    # the cloud-metadata address must never be reachable through proposal intake
    r = client.post("/api/penny/proposal",
                    json={"source_url": "http://169.254.169.254/latest/meta-data/"},
                    headers=_auth("tok"))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "ssrf_blocked"


def test_proposal_requires_bearer(client):
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=_pdf(8),
                    headers={"Content-Type": "application/pdf"})
    assert r.status_code == 403


def test_proposal_empty_body_is_422(client):
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=b"",
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "empty_upload"


def test_proposal_magic_bytes_beat_a_forged_content_type(client):
    # the bytes are the authority: a non-PDF body labelled application/pdf is rejected
    r = client.post("/api/penny/proposal?filename=evil.pdf",
                    content=b"GIF89a not really a pdf",
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 415
    assert r.json()["detail"]["error"] == "unsupported_type"


def test_proposal_clean_public_url_defers_to_pe9(client):
    # SSRF-clean, but server-side remote fetch is out of scope here (PE9).
    r = client.post("/api/penny/proposal",
                    json={"source_url": "http://93.184.216.34/proposal.pdf"},
                    headers=_auth("tok"))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "remote_intake_unavailable"


def test_proposal_blocks_private_source_url(client):
    r = client.post("/api/penny/proposal",
                    json={"source_url": "http://10.1.2.3/x"}, headers=_auth("tok"))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "ssrf_blocked"


def test_proposal_source_url_requires_url(client):
    r = client.post("/api/penny/proposal", json={}, headers=_auth("tok"))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "empty_upload"


def test_proposal_rate_limited_returns_429(client, monkeypatch):
    monkeypatch.setattr(penny_router.ratelimit, "check", lambda *a, **k: (False, 42))
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=_pdf(8),
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 429
    assert r.json()["detail"]["retry_after_seconds"] == 42
    assert r.headers.get("Retry-After") == "42"


def test_uploaded_proposal_is_held_not_executed(client):
    body = _pdf(16)
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=body,
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    ref = r.json()["proposal_ref"]
    # bytes are held verbatim behind the ref (never parsed / rendered / executed)
    held = proposal_intake.get_proposal(ref)
    assert held["data"] == body
    assert r.json()["size"] == len(body)


# =================================================== detail: error contract extras
def test_kill_switch_disables_penny(client, monkeypatch):
    p = _create(client)
    monkeypatch.setenv("AI_DISABLED", "1")
    chain = _use_chain(client, ScriptedChain(_text("x")))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "hi"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "ai_disabled"
    assert chain.calls == []


def test_input_too_large_is_422(client):
    p = _create(client)
    _use_chain(client, ScriptedChain(_text("x")))
    huge = "x" * 600_000  # exceeds the loop's max_input_tokens cap (~120k tokens)
    r = client.post(_penny_url(p["view_slug"]), json={"message": huge},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "input_too_large"


# ============================================== detail: capability + edit path
def test_edit_token_can_mutate_as_penny(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}),
        _text("Lowered labor."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "cut labor"},
                    headers=_auth(p["edit_token"]))
    assert r.status_code == 200, r.text
    assert r.json()["applied_revisions"][0]["actor"] == "penny"
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 2


def test_multi_tool_turn_produces_one_revision_per_edit(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}, call_id="a"),
        _tool("set_assumption", {"name": "marketing_pct", "value": "0.04"}, call_id="b"),
        _text("Adjusted two assumptions."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "tune both"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    versions = [a["version"] for a in r.json()["applied_revisions"]]
    assert versions == [2, 3], versions  # each edit bumps version + writes a revision
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 3
    penny_revs = [rv for rv in store.list_revisions(row["id"]) if rv["actor"] == "penny"]
    assert {rv["seq"] for rv in penny_revs} == {2, 3}


def test_computed_figure_in_mutate_arg_is_stripped_not_applied(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        # a stubbed model that puts a *display-formatted* figure into a mutate arg
        _tool("set_assumption", {"name": "labor_pct", "value": "$5,000"}),
        _text("I can only apply a raw number, not a computed figure."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "set labor to $5,000"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    assert r.json()["applied_revisions"] == []  # figure-strip => nothing applied
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 1
    assert not any(rv["actor"] == "penny" for rv in store.list_revisions(row["id"]))


def test_non_pinnable_node_is_relayed_not_applied(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("set_override", {"node": "net_profit", "year": 1, "value": "100"}),
        _text("That total can't be pinned directly."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "pin net profit"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    assert r.json()["applied_revisions"] == []  # 422 relayed to the model, no mutation
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 1


def test_read_only_tool_does_not_mutate(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("read_projection", {}),
        _text("Your capital required is in the current model."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "what's my capital?"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200
    assert r.json()["applied_revisions"] == []
    assert store.get_projection_by_slug(p["view_slug"])["version"] == 1


def test_transcript_accumulates_across_turns(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(_text("First answer.")))
    client.post(_penny_url(p["view_slug"]), json={"message": "turn one"},
                headers=_auth(p["owner_token"]))
    _use_chain(client, ScriptedChain(_text("Second answer.")))
    client.post(_penny_url(p["view_slug"]), json={"message": "turn two"},
                headers=_auth(p["owner_token"]))
    tr = client.get(_penny_url(p["view_slug"]) + "/transcript",
                    headers=_auth(p["owner_token"]))
    contents = [t["content"] for t in tr.json()["turns"]]
    assert "turn one" in contents and "turn two" in contents
    assert "First answer." in contents and "Second answer." in contents


# ======================================================= draft: per-tool surface
def _draft_post(client, *responses, draft_state=None, message="go", token="edit-tok"):
    _use_chain(client, ScriptedChain(*responses))
    return client.post("/api/penny/draft", headers=_auth(token), json={
        "message": message, "draft_state": draft_state or {}})


def test_draft_set_assumption_mutates_assumptions(client):
    r = _draft_post(
        client,
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}),
        _text("Set labor to 0.55 in your draft."),
        draft_state={"assumptions": {"labor_pct": "0.60"}})
    assert r.status_code == 200, r.text
    assert r.json()["draft"]["assumptions"]["labor_pct"] == "0.55"


def test_draft_edit_cost_schedule_adds_row_with_ai_provenance(client):
    r = _draft_post(
        client,
        _tool("edit_cost_schedule",
              {"ops": [{"op": "add", "category": "Build-out", "month": 2, "amount": 40000}]}),
        _text("Added a build-out cost in month 2."))
    sched = r.json()["draft"]["cost_schedule"]
    assert len(sched) == 1
    row = sched[0]
    assert row["category"] == "Build-out" and row["month"] == 2 and row["amount"] == 40000
    assert row["provenance"]["source"] == "ai"


def test_draft_parse_proposal_extracts_only_document_figures(client):
    r = _draft_post(
        client,
        _tool("parse_proposal", {"proposal_text": "Phase 1 build-out is $40,000 plus $1,200."}),
        _text("I found two figures in the proposal."))
    # extraction lives in the tool result, not the draft — assert no fabricated mutation
    assert r.json()["draft"].get("cost_schedule") == []


def test_draft_read_projection_returns_draft_facts(client):
    r = _draft_post(
        client,
        _tool("read_projection", {}),
        _text("Your draft has labor at 0.6."),
        draft_state={"assumptions": {"labor_pct": "0.60"}})
    assert r.status_code == 200
    # read does not mutate the draft
    assert r.json()["draft"]["assumptions"] == {"labor_pct": "0.60"}


def test_draft_strips_computed_figure(client):
    r = _draft_post(
        client,
        _tool("set_assumption", {"name": "labor_pct", "value": "8%"}),
        _text("That's a percentage display — give me the fraction."),
        draft_state={"assumptions": {"labor_pct": "0.60"}})
    assert r.status_code == 200
    # the computed figure was stripped — the draft value is unchanged
    assert r.json()["draft"]["assumptions"]["labor_pct"] == "0.60"


def test_draft_ai_disabled_when_no_provider(client):
    _use_chain(client, ScriptedChain(_text("x"), providers=()))
    r = client.post("/api/penny/draft", headers=_auth("edit-tok"),
                    json={"message": "hi", "draft_state": {}})
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "ai_disabled"


def test_draft_both_providers_down_returns_503(client):
    _use_chain(client, ScriptedChain(
        AIUnavailableError("down"), providers=("anthropic", "openai")))
    r = client.post("/api/penny/draft", headers=_auth("edit-tok"),
                    json={"message": "hi", "draft_state": {}})
    assert r.status_code == 503


def test_draft_edit_cost_schedule_remove(client):
    r = _draft_post(
        client,
        _tool("edit_cost_schedule",
              {"ops": [{"op": "remove", "category": "Build-out", "month": 2}]}),
        _text("Removed the build-out row."),
        draft_state={"cost_schedule": [
            {"category": "Build-out", "month": 2, "amount": 40000},
            {"category": "Signage", "month": 3, "amount": 5000}]})
    sched = r.json()["draft"]["cost_schedule"]
    assert [row["category"] for row in sched] == ["Signage"]


def test_draft_strips_computed_figure_in_cost_amount(client):
    r = _draft_post(
        client,
        _tool("edit_cost_schedule",
              {"ops": [{"op": "add", "category": "Build-out", "month": 2, "amount": "$40,000"}]}),
        _text("That's a formatted figure — give me a raw number."))
    # the computed figure is stripped; nothing is added to the draft schedule
    assert r.json()["draft"]["cost_schedule"] == []


def test_draft_unknown_field_is_not_applied(client):
    r = _draft_post(
        client,
        _tool("set_input", {"field": "not_a_field", "value": "x"}),
        _text("I don't recognize that field."),
        draft_state={"inputs": {"city": "Longview, Texas"}})
    # an unknown field never mutates the draft (fail-closed)
    assert r.json()["draft"]["inputs"] == {"city": "Longview, Texas"}


def test_draft_missing_message_is_422(client):
    _use_chain(client, ScriptedChain(_text("x")))
    r = client.post("/api/penny/draft", headers=_auth("edit-tok"),
                    json={"draft_state": {}})
    assert r.status_code == 422


# ====================================================== detail: more loop coverage
def test_detail_set_input_applies_as_penny(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("set_input", {"field": "city", "value": "Tyler, Texas"}),
        _text("Updated the city."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "move to Tyler"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    assert r.json()["applied_revisions"][0]["actor"] == "penny"
    assert store.get_projection_by_slug(p["view_slug"])["version"] == 2


def test_detail_turns_appended_link_applied_revision(client):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("set_assumption", {"name": "labor_pct", "value": "0.55"}),
        _text("Done."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "cut labor"},
                    headers=_auth(p["owner_token"]))
    turns = r.json()["turns_appended"]
    tool_turns = [t for t in turns if t["role"] == "tool"]
    assert len(tool_turns) == 1
    # the tool turn links to the revision it produced (provenance ↔ §4 audit)
    assert tool_turns[0]["revision_id"] == 2
    assert tool_turns[0]["tool_name"] == "set_assumption"


def test_detail_parse_proposal_extracts_only_document_figures(client):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("parse_proposal", {"proposal_text": "Phase 1 build-out: $40,000."}),
        _text("I found one figure in the proposal."),
    ))
    r = client.post(_penny_url(p["view_slug"]),
                    json={"message": "read the proposal", "proposal_ref": "prop_x"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200
    # extract-only: no mutation results from reading a proposal
    assert r.json()["applied_revisions"] == []


def test_detail_missing_message_is_422(client):
    p = _create(client)
    _use_chain(client, ScriptedChain(_text("x")))
    r = client.post(_penny_url(p["view_slug"]), json={}, headers=_auth(p["owner_token"]))
    assert r.status_code == 422


def test_proposal_response_echoes_filename(client):
    r = client.post("/api/penny/proposal?filename=consultant-plan.pdf", content=_pdf(8),
                    headers={**_auth("tok"), "Content-Type": "application/pdf"})
    assert r.status_code == 201
    assert r.json()["filename"] == "consultant-plan.pdf"
    assert r.json()["content_type"] == "application/pdf"


def test_proposal_accepts_octet_stream_with_pdf_magic(client):
    # the magic-byte sniff is the authority — a generic octet-stream that IS a PDF
    # is accepted; the (advisory) content-type is not what gates.
    r = client.post("/api/penny/proposal?filename=plan.pdf", content=_pdf(8),
                    headers={**_auth("tok"), "Content-Type": "application/octet-stream"})
    assert r.status_code == 201
    assert r.json()["proposal_ref"]


def test_detail_edit_cost_schedule_applies_as_penny(client, store):
    p = _create(client)
    _use_chain(client, ScriptedChain(
        _tool("edit_cost_schedule",
              {"ops": [{"op": "add", "category": "Build-out", "month": 2, "amount": 40000}]}),
        _text("Added a build-out cost in month 2."),
    ))
    r = client.post(_penny_url(p["view_slug"]), json={"message": "add build-out"},
                    headers=_auth(p["owner_token"]))
    assert r.status_code == 200, r.text
    assert r.json()["applied_revisions"][0]["version"] == 2
    row = store.get_projection_by_slug(p["view_slug"])
    assert row["version"] == 2
    # the cost row landed in the stored inputs with AI provenance
    inputs = json.loads(row["inputs_json"])
    added = [c for c in inputs["cost_schedule"] if c.get("category") == "Build-out"]
    assert added and added[0].get("provenance", {}).get("source") == "ai"


def test_draft_set_input_name_updates_draft_name(client):
    r = _draft_post(
        client,
        _tool("set_input", {"field": "name", "value": "Grace Mission Thrift"}),
        _text("Renamed your draft."),
        draft_state={"name": "Untitled"})
    assert r.json()["draft"]["name"] == "Grace Mission Thrift"

"""Epic F (#265, decisions #7/#12) — Penny → GitHub product-feedback tool.

Penny files a redacted GitHub issue AT HER DISCRETION when a chat surfaces a real
bug/opportunity. The capability ships DORMANT behind ``PENNY_GITHUB_FEEDBACK_ENABLED``
(default OFF): with the flag off the tool is not even in Penny's tool surface, so she
has no way to auto-file in prod. These are adversarial CI tests with a STUBBED GitHub
client (an injected ``MockTransport`` — no real issue is ever created):

  * flag-off  ⇒ the tool is not registered (no-op); the seven-tool surface unchanged;
  * flag-on   ⇒ Penny files through the EXISTING ``file_github_issue()`` redacted path,
    tagged ``filed-by-penny``, and persists the row (with creator_* identity);
  * redaction ⇒ $/%/links/slugs/tokens/emails never reach the outbound payload;
  * dedup     ⇒ the same redacted body (per identity/window) files at most once;
  * rate-limit⇒ per-user cap returns a friendly no-op with no GitHub/DB write;
  * creator   ⇒ the server-only creator_* identity rides the ROW, never the issue;
  * in-thread ⇒ the loop relays Penny's acknowledgement to the user.
"""
from __future__ import annotations

import json
import logging
import re

import httpx
import pytest

import app.routers.feedback as feedback_mod
from app.penny import tools as T
from app.penny.loop import ToolContext, run_turn
from app.penny.providers import ProviderResponse, ToolCall, Usage
from app.store.sqlite import SqliteStore

SEVEN_TOOLS = {
    "read_projection", "parse_proposal", "set_input", "set_assumption",
    "set_override", "clear_override", "edit_cost_schedule",
}

# Leak classes (mirror the fuzz suite) asserted against the ACTUAL outbound bytes.
_LEAK_CLASSES = {
    "money": re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?"),
    "percent": re.compile(r"\b\d+(?:\.\d+)?\s?%"),
    "url": re.compile(r"https?://", re.IGNORECASE),
    "bearer": re.compile(r"\bBearer\b", re.IGNORECASE),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
}

_LIVE_SLUG = "p_8xKQ9mZ2vR7sT4uW6yA1bC3"


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def flag_on(monkeypatch):
    monkeypatch.setenv("PENNY_GITHUB_FEEDBACK_ENABLED", "1")


@pytest.fixture()
def gh_creds(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_pennytoken")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")


@pytest.fixture()
def captured(monkeypatch):
    """Stub the GitHub client with an injected MockTransport — no real egress ever."""
    reqs: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        reqs.append(request)
        return httpx.Response(
            201, json={"html_url": "https://github.com/rallytasks/projections/issues/42"}
        )

    monkeypatch.setattr(
        feedback_mod, "_default_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    return reqs


def _ctx(*, token=None, slug=None, ip="203.0.113.7"):
    return ToolContext(
        view_slug=slug, bearer_token=token, can_mutate=False, version=None,
        extra={"client_ip": ip, "turn_id": "turn_x"},
    )


def _file(store, ctx, **args):
    return T.build_registry(store).get("file_product_feedback").handler(args, ctx)


def _rows(store):
    return store._conn.execute("SELECT * FROM feedback").fetchall()


def _assert_no_leaks(blob: str, *literals: str) -> None:
    for name, rx in _LEAK_CLASSES.items():
        m = rx.search(blob)
        assert m is None, f"leak-class {name!r} matched {m.group(0)!r} in {blob!r}"
    for lit in literals:
        assert lit not in blob, f"literal {lit!r} leaked into {blob!r}"


# ----------------------------------------------------- flag gates registration
def test_flag_off_registers_exactly_seven_tools_no_feedback(store):
    # Default: PENNY_GITHUB_FEEDBACK_ENABLED unset ⇒ dormant.
    reg = T.build_registry(store)
    assert set(reg.names()) == SEVEN_TOOLS
    assert reg.get("file_product_feedback") is None


def test_flag_on_registers_the_eighth_tool(store, flag_on):
    reg = T.build_registry(store)
    assert set(reg.names()) == SEVEN_TOOLS | {"file_product_feedback"}
    tool = reg.get("file_product_feedback")
    assert tool is not None
    assert tool.input_schema["type"] == "object"
    assert "description" in tool.input_schema["properties"]


def test_flag_off_is_a_noop_even_if_invoked(store, gh_creds, captured):
    # With the flag off the tool isn't in the surface; an attempt to execute it is an
    # unknown-tool no-op — no GitHub call, no DB row.
    reg = T.build_registry(store)
    res = reg.execute("file_product_feedback", {"description": "the chart is broken"},
                      _ctx(), tool_use_id="tu_1")
    assert res.is_error is True
    assert res.content.get("error") == "unknown_tool"
    assert captured == []
    assert _rows(store) == []


# ------------------------------------------------------------ files when flag on
def test_flag_on_files_via_redacted_path_and_persists(store, flag_on, gh_creds, captured):
    res = _file(store, _ctx(),
                title="Chart marker is off",
                description="The break-even marker is off by one month on the chart.",
                type="bug")
    assert res["filed"] is True
    assert res["support_id"].startswith("SUP-")
    assert res["github_issue_filed"] is True
    assert "logged this as product feedback" in res["message"]
    assert res["support_id"] in res["message"]  # the in-thread ack carries the ref

    # exactly one outbound POST, tagged filed-by-penny, body carries the support_id.
    assert len(captured) == 1
    req = captured[0]
    assert str(req.url) == "https://api.github.com/repos/rallytasks/projections/issues"
    sent = json.loads(req.content)
    assert "filed-by-penny" in sent["labels"]
    assert res["support_id"] in sent["body"]

    # persisted: one row, with the issue url and the SAME redacted body.
    rows = _rows(store)
    assert len(rows) == 1
    row = dict(rows[0])
    assert row["support_id"] == res["support_id"]
    assert row["github_issue_url"] == "https://github.com/rallytasks/projections/issues/42"
    assert row["type"] == "bug"


def test_files_a_row_even_when_github_creds_unset(store, flag_on, captured):
    # No GITHUB_TOKEN/REPO (root conftest clears them): file_github_issue degrades to a
    # null url, but the feedback row is still persisted and Penny still acknowledges.
    res = _file(store, _ctx(), description="Add a CSV export of the monthly cash-flow.",
                type="idea")
    assert res["filed"] is True
    assert res["github_issue_filed"] is False
    assert captured == []  # never built a client (creds unset → returns before egress)
    row = dict(_rows(store)[0])
    assert row["github_issue_url"] is None


# ----------------------------------------------------------------- redaction
def test_outbound_payload_and_row_are_redacted(store, flag_on, gh_creds, captured):
    leaky_desc = (
        f"see https://projections.thriftly.com/p/{_LIVE_SLUG}/edit "
        "email me@example.org Bearer ghp_secret capital $277,990 margin 6.0%"
    )
    res = _file(store, _ctx(slug=_LIVE_SLUG),
                title=f"broken {_LIVE_SLUG}", description=leaky_desc, type="bug")
    assert res["filed"] is True
    blob = captured[0].content.decode()
    _assert_no_leaks(blob, _LIVE_SLUG, "me@example.org", "$277,990", "6.0%")
    # and the persisted row carries no leak either.
    row = dict(_rows(store)[0])
    persisted = " ".join(str(v) for v in row.values() if v is not None)
    # github_issue_url legitimately holds a github.com link; check the body/title only.
    _assert_no_leaks(f"{row['title']} {row['body']} {row['context_json']}",
                     _LIVE_SLUG, "me@example.org", "$277,990", "6.0%")
    assert "github.com/rallytasks/projections/issues" in persisted


def test_empty_description_is_not_filed(store, flag_on, gh_creds, captured):
    res = _file(store, _ctx(), title="t", description="   ")
    assert res["filed"] is False
    assert res.get("error") == "invalid_inputs"
    assert captured == []
    assert _rows(store) == []


# ---------------------------------------------------------------------- dedup
def test_dedup_same_redacted_body_files_once(store, flag_on, gh_creds, captured):
    ctx = _ctx(token="owner_tok_abc")
    first = _file(store, ctx, description="The PDF export is missing the cover page.")
    assert first["filed"] is True
    second = _file(store, ctx, description="The PDF export is missing the cover page.")
    assert second["filed"] is False
    assert second["duplicate"] is True
    # only ONE issue, only ONE row.
    assert len(captured) == 1
    assert len(_rows(store)) == 1


def test_dedup_is_per_identity(store, flag_on, gh_creds, captured):
    body = "The sidebar overlaps the table on mobile."
    assert _file(store, _ctx(token="tok_user_a"), description=body)["filed"] is True
    # a DIFFERENT identity filing the same body is not a duplicate.
    assert _file(store, _ctx(token="tok_user_b"), description=body)["filed"] is True
    assert len(captured) == 2
    assert len(_rows(store)) == 2


# ------------------------------------------------------------------- rate limit
def test_per_user_rate_limit_blocks_after_cap(store, flag_on, gh_creds, captured):
    ctx = _ctx(token="busy_owner")
    filed = 0
    limited = None
    for i in range(T._PENNY_FEEDBACK_USER_LIMIT + 2):
        # distinct bodies so dedup never interferes — we are testing the rate cap.
        res = _file(store, ctx, description=f"Distinct issue number {i} to report.")
        if res.get("filed"):
            filed += 1
        elif res.get("rate_limited"):
            limited = res
            break
    assert filed == T._PENNY_FEEDBACK_USER_LIMIT
    assert limited is not None
    assert limited["status"] == 429
    assert limited["retry_after_seconds"] >= 1
    # GitHub was called only for the accepted ones; the blocked one wrote nothing.
    assert len(captured) == T._PENNY_FEEDBACK_USER_LIMIT
    assert len(_rows(store)) == T._PENNY_FEEDBACK_USER_LIMIT


# --------------------------------------------- creator identity (row, not issue)
def test_creator_identity_on_row_never_in_issue(store, flag_on, gh_creds, captured,
                                                monkeypatch):
    import app.clerk.verify as clerkverify
    from app.tests.clerk_testkit import (
        TEST_AZP,
        TEST_ISSUER,
        make_keypair,
        mint,
        stub_for,
    )

    priv, pub = make_keypair()
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: stub_for(pub))
    monkeypatch.setenv("CLERK_ENABLED", "1")
    monkeypatch.setenv("CLERK_JWT_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", TEST_AZP)

    pii_email, pii_name, pii_sub = "ed@hopethrift.org", "Dana Operator", "user_2clerk99"
    token = mint(priv, sub=pii_sub, extra={"email": pii_email, "name": pii_name})

    res = _file(store, _ctx(token=token),
                title="Banner bug", description="The banner is off by one.", type="bug")
    assert res["filed"] is True

    # creator_* persisted SERVER-SIDE on the row.
    row = dict(_rows(store)[0])
    assert row["creator_email"] == pii_email
    assert row["creator_name"] == pii_name
    assert row["creator_clerk_user_id"] == pii_sub

    # …but NONE of it (and no creator_* key) reaches the outbound GitHub payload.
    out = captured[0].content.decode()
    for leak in (pii_email, pii_name, pii_sub):
        assert leak not in out
    for col in ("creator_email", "creator_name", "creator_phone", "creator_clerk_user_id"):
        assert col not in out


# ------------------------------------------------- in-thread ack via the PE3 loop
class _ScriptedChain:
    def __init__(self, *responses, providers=("anthropic",)):
        self._responses = list(responses)
        self.providers = list(providers)

    def complete(self, request):
        return self._responses.pop(0) if self._responses else ProviderResponse(
            provider="anthropic", text="done", usage=Usage(1, 1))


def test_penny_files_and_acknowledges_in_thread(store, flag_on, gh_creds, captured):
    tool_call = ProviderResponse(
        provider="anthropic",
        tool_calls=[ToolCall(id="tu_1", name="file_product_feedback",
                             arguments={"description": "The 409 modal never closes.",
                                        "type": "bug"})],
        stop_reason="tool_use", usage=Usage(1, 1),
    )
    ack = ProviderResponse(
        provider="anthropic",
        text="Thanks — I've logged that as feedback for the team (ref SUP-XXXXXX).",
        usage=Usage(1, 1),
    )
    res = run_turn(
        user_message="the 409 modal is stuck open, that's a bug",
        chain=_ScriptedChain(tool_call, ack),
        registry=T.build_registry(store),
        context=_ctx(),
        grounding_context={"version": 1},
    )
    inv = res.tool_invocations[0]
    assert inv.name == "file_product_feedback"
    assert inv.is_error is False
    assert inv.result["filed"] is True
    assert inv.result["support_id"].startswith("SUP-")
    # Penny relays an acknowledgement to the user (final assistant text).
    assert "logged that as feedback" in res.final_text
    assert len(captured) == 1  # exactly one issue filed through the loop


# ---------------------------------- diagnosability of file_github_issue failures
def test_failure_handler_logs_status_and_truncated_body(monkeypatch, caplog):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_secret_should_never_log")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Bad credentials — check the token. " + "x" * 500)

    monkeypatch.setattr(
        feedback_mod, "_default_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with caplog.at_level(logging.WARNING, logger="app.feedback"):
        out = feedback_mod.file_github_issue(
            {"support_id": "SUP-DIAG00", "type": "bug", "title": "t", "body": "b",
             "context": {}})
    assert out is None
    rec = next(r for r in caplog.records if "github_issue_failed" in r.getMessage())
    msg = rec.getMessage()
    assert "status=401" in msg
    assert "Bad credentials" in msg            # GitHub's own error text is diagnosable
    assert "ghp_secret_should_never_log" not in msg  # our token is NEVER logged
    # the response body is truncated (~200 chars), not dumped whole.
    assert msg.count("x") <= 200


def test_timeout_failure_logs_without_a_response(monkeypatch, caplog):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")
    monkeypatch.setenv("GITHUB_REPO", "rallytasks/projections")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow")

    monkeypatch.setattr(
        feedback_mod, "_default_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with caplog.at_level(logging.WARNING, logger="app.feedback"):
        out = feedback_mod.file_github_issue(
            {"support_id": "SUP-TMO", "type": "bug", "title": "t", "body": "b",
             "context": {}})
    assert out is None
    rec = next(r for r in caplog.records if "github_issue_failed" in r.getMessage())
    assert "status=None" in rec.getMessage()  # a timeout carries no response


# --------------------------------------------- config flag (default OFF, dormant)
def test_config_flag_defaults_off_and_parses_truthy():
    from app import config

    # Unset / blank / unknown ⇒ OFF (dormant).
    assert config.penny_github_feedback_enabled({}) is False
    assert config.penny_github_feedback_enabled({"PENNY_GITHUB_FEEDBACK_ENABLED": ""}) is False
    assert config.penny_github_feedback_enabled(
        {"PENNY_GITHUB_FEEDBACK_ENABLED": "maybe"}) is False
    # Truthy spellings, case/space-insensitive.
    for val in ("1", "true", "TRUE", "yes", "on", "  On  "):
        assert config.penny_github_feedback_enabled(
            {"PENNY_GITHUB_FEEDBACK_ENABLED": val}) is True, val


def test_config_flag_is_never_a_required_boot_secret():
    # The flag must NOT appear in the prod boot-refuse set — an unset value is OFF,
    # not a boot failure (it is a no-deploy behavior toggle, not a secret).
    from app import config

    prod = {
        "APP_ENV": "prod", "DB_BACKEND": "sqlite", "DB_PATH": "/data/x.db",
        "GOOGLE_PLACES_API_KEY": "k", "ANTHROPIC_API_KEY": "k",
    }
    # No PENNY_GITHUB_FEEDBACK_ENABLED set — boot must still succeed.
    config.validate_required(prod)  # does not raise


# ---------------------------------------------------------- dedup unit (pure)
def test_dedup_body_hash_is_deterministic_and_order_independent():
    from app.feedback import dedup

    assert dedup.body_hash("same text") == dedup.body_hash("same text")
    assert dedup.body_hash("a") != dedup.body_hash("b")
    assert dedup.body_hash(None) == dedup.body_hash("")  # None normalizes to ""


def test_dedup_is_duplicate_is_read_only_until_record():
    from app.feedback import dedup

    dedup.reset_dedup()
    body = "the export button is greyed out"
    # A bare check NEVER records — repeated checks stay False until we record.
    assert dedup.is_duplicate("id-1", body) is False
    assert dedup.is_duplicate("id-1", body) is False
    dedup.record("id-1", body)
    assert dedup.is_duplicate("id-1", body) is True
    # A different identity with the same body is independent.
    assert dedup.is_duplicate("id-2", body) is False


def test_dedup_window_expiry(monkeypatch):
    from app.feedback import dedup

    dedup.reset_dedup()
    clock = {"t": 1000.0}
    monkeypatch.setattr(dedup.time, "time", lambda: clock["t"])
    dedup.record("id", "body")
    assert dedup.is_duplicate("id", "body", window_seconds=100) is True
    clock["t"] = 1000.0 + 101  # past the window
    assert dedup.is_duplicate("id", "body", window_seconds=100) is False


def test_dedup_reset_clears_state():
    from app.feedback import dedup

    dedup.record("id", "body")
    assert dedup.is_duplicate("id", "body") is True
    dedup.reset_dedup()
    assert dedup.is_duplicate("id", "body") is False


# ----------------------------------------------- extra_labels merge (filing)
def test_labels_for_type_merges_extra_labels_deduped():
    base = feedback_mod._labels_for_type("idea")
    assert base == ["app-suggestion", "type:idea"]
    merged = feedback_mod._labels_for_type("bug", ["filed-by-penny", "feedback"])
    # base channel/type labels, plus the new attribution; existing ones not doubled.
    assert merged[0] == "feedback" and "type:bug" in merged
    assert "filed-by-penny" in merged
    assert merged.count("feedback") == 1
    # non-list / junk extra labels are ignored (no crash, base set unchanged).
    assert feedback_mod._labels_for_type("other", None) == ["feedback", "type:other"]
    assert feedback_mod._labels_for_type("other", "nope") == ["feedback", "type:other"]


# ------------------------------------------- view-only caller / type defaulting
def test_view_only_caller_can_still_file_feedback(store, flag_on, gh_creds, captured):
    # Filing product feedback is NOT a projection mutation — a view-only caller
    # (can_mutate False) may still have Penny log a bug. The tool is kind "action".
    tool = T.build_registry(store).get("file_product_feedback")
    assert tool.kind == "action"
    ctx = ToolContext(view_slug="p_x", bearer_token=None, can_mutate=False,
                      version=None, extra={"client_ip": "203.0.113.9"})
    res = tool.handler({"description": "Tooltip text is cut off on the KPI cards."}, ctx)
    assert res["filed"] is True
    assert len(captured) == 1


def test_type_defaults_to_other_when_omitted_or_garbage(store, flag_on, gh_creds, captured):
    res = _file(store, _ctx(), description="Something feels off but I can't name it.",
                type="not-a-type")
    assert res["filed"] is True
    sent = json.loads(captured[0].content)
    # type rides the issue as a `type:*` label and is normalized to the closed enum.
    assert "type:other" in sent["labels"]
    assert dict(_rows(store)[0])["type"] == "other"

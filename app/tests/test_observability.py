"""Structured logging + opt-in Sentry hook tests (#190).

Incident-readiness: app logs must be structured JSON stamped with deploy context
and secret-scrubbed (no secret/financial field ever reaches a log line or Sentry).
The Sentry init is OPT-IN and SAFE: a no-op when ``SENTRY_DSN`` is unset or when the
``sentry_sdk`` package is absent — it must never break boot.
"""
from __future__ import annotations

import io
import json
import logging
import sys
import types

from app import observability
from engine.model import MODEL_VERSION


# --- JSON structured logging ------------------------------------------------
def test_json_formatter_emits_json_with_deploy_context():
    fmt = observability.JsonLogFormatter(context={"deployment_sha": "abc123", "env": "test"})
    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="hello world", args=(), exc_info=None,
    )
    parsed = json.loads(fmt.format(record))
    assert parsed["msg"] == "hello world"
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "app.test"
    assert parsed["deployment_sha"] == "abc123"
    assert parsed["env"] == "test"


def test_json_formatter_scrubs_secrets_and_financials():
    fmt = observability.JsonLogFormatter()
    record = logging.LogRecord(
        name="app.test", level=logging.WARNING, pathname=__file__, lineno=1,
        msg="auth=Bearer sk-secretkey1234567890 cost=$12,345.67", args=(), exc_info=None,
    )
    out = fmt.format(record)
    assert "sk-secretkey1234567890" not in out
    assert "$12,345.67" not in out
    assert "[redacted]" in out


def test_json_formatter_includes_structured_extra_fields():
    fmt = observability.JsonLogFormatter()
    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="event", args=(), exc_info=None,
    )
    record.support_id = "sup_123"  # a structured "extra"
    parsed = json.loads(fmt.format(record))
    assert parsed["support_id"] == "sup_123"


def test_configure_logging_is_idempotent():
    observability.configure_logging({"APP_ENV": "test"})
    observability.configure_logging({"APP_ENV": "test"})
    root = logging.getLogger()
    marked = [h for h in root.handlers if getattr(h, "_app_json_handler", False)]
    assert len(marked) == 1


def test_deployment_context_uses_railway_sha_and_model_version():
    ctx = observability.deployment_context(
        {"RAILWAY_GIT_COMMIT_SHA": "cafef00d", "APP_ENV": "production"}
    )
    assert ctx["deployment_sha"] == "cafef00d"
    assert ctx["model_version"] == MODEL_VERSION
    assert ctx["env"] == "production"


# --- Sentry init (opt-in, safe) ---------------------------------------------
def test_init_sentry_noop_without_dsn():
    # Opt-in: no DSN => never initializes, never raises.
    assert observability.init_sentry({"APP_ENV": "production"}) is False


def test_init_sentry_noop_when_sdk_missing():
    # DSN set but sentry_sdk not installed in this env => safe no-op (no boot break).
    assert observability.init_sentry({"SENTRY_DSN": "https://x@example.test/1"}) is False


def _fake_sentry(calls: dict) -> types.ModuleType:
    """A minimal stand-in for the (intentionally absent) sentry_sdk package."""
    fake = types.ModuleType("sentry_sdk")

    def _init(**kwargs):
        calls["init"] = kwargs

    def _set_tag(key, value):
        calls.setdefault("tags", {})[key] = value

    fake.init = _init  # type: ignore[attr-defined]
    fake.set_tag = _set_tag  # type: ignore[attr-defined]
    return fake


def test_init_sentry_success_path_tags_and_scrubs(monkeypatch):
    # The SUCCESS branch (SDK present + DSN set): init args carry deploy context,
    # PII is off, before_send is wired, and the deploy tags are set.
    calls: dict = {}
    monkeypatch.setitem(sys.modules, "sentry_sdk", _fake_sentry(calls))
    ok = observability.init_sentry(
        {
            "SENTRY_DSN": "https://pub@example.test/1",
            "APP_ENV": "production",
            "RAILWAY_GIT_COMMIT_SHA": "sha9",
            "SENTRY_TRACES_SAMPLE_RATE": "0.25",
        }
    )
    assert ok is True
    init = calls["init"]
    assert init["dsn"] == "https://pub@example.test/1"
    assert init["environment"] == "production"
    assert init["release"] == "sha9"
    assert init["send_default_pii"] is False
    assert init["traces_sample_rate"] == 0.25
    assert callable(init["before_send"])
    assert calls["tags"]["deployment_sha"] == "sha9"
    assert calls["tags"]["model_version"] == MODEL_VERSION


def test_init_sentry_bad_traces_rate_defaults_to_zero(monkeypatch):
    calls: dict = {}
    monkeypatch.setitem(sys.modules, "sentry_sdk", _fake_sentry(calls))
    assert observability.init_sentry(
        {"SENTRY_DSN": "https://x@e.test/1", "SENTRY_TRACES_SAMPLE_RATE": "garbage"}
    ) is True
    assert calls["init"]["traces_sample_rate"] == 0.0


def test_init_sentry_returns_false_when_init_raises(monkeypatch):
    # A misconfigured DSN that makes sentry_sdk.init raise must NEVER break boot.
    fake = types.ModuleType("sentry_sdk")

    def _boom(**_kwargs):
        raise RuntimeError("bad dsn")

    fake.init = _boom  # type: ignore[attr-defined]
    fake.set_tag = lambda *a, **k: None  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    assert observability.init_sentry({"SENTRY_DSN": "https://x@e.test/1"}) is False


def test_before_send_handles_event_without_request():
    out = observability._before_send({"extra": {"note": "rent $5,000"}}, None)
    assert "$5,000" not in json.dumps(out)


def test_before_send_tolerates_non_dict_headers():
    event = {"request": {"headers": "not-a-dict", "data": {"x": "ok"}}}
    out = observability._before_send(event, None)
    assert out["request"]["data"] == {"x": "ok"}  # data still scrubbed, no crash


def test_before_send_never_raises_on_scrub_error(monkeypatch):
    def _raise(_value):
        raise ValueError("scrub blew up")

    monkeypatch.setattr(observability, "scrub", _raise)
    event = {"extra": {"a": 1}}
    # Best-effort redaction: a scrub failure returns the event, never propagates.
    assert observability._before_send(event, None) is event


def test_configure_logging_routes_records_to_stream():
    buf = io.StringIO()
    observability.configure_logging(
        {"APP_ENV": "test", "RAILWAY_GIT_COMMIT_SHA": "z1"}, stream=buf
    )
    try:
        logging.getLogger("app.routetest").warning("hello %s", "world")
        line = buf.getvalue().strip().splitlines()[-1]
        parsed = json.loads(line)
        assert parsed["msg"] == "hello world"
        assert parsed["deployment_sha"] == "z1"
        assert parsed["logger"] == "app.routetest"
    finally:
        observability.configure_logging({"APP_ENV": "test"})  # restore stderr handler


def test_configure_logging_respects_log_level():
    observability.configure_logging({"APP_ENV": "test", "LOG_LEVEL": "ERROR"})
    try:
        assert logging.getLogger().level == logging.ERROR
    finally:
        observability.configure_logging({"APP_ENV": "test"})
    assert logging.getLogger().level == logging.INFO


def test_json_formatter_includes_exception_text():
    fmt = observability.JsonLogFormatter()
    try:
        raise ValueError("boom-detail")
    except ValueError:
        record = logging.LogRecord(
            name="app.test", level=logging.ERROR, pathname=__file__, lineno=1,
            msg="failed", args=(), exc_info=sys.exc_info(),
        )
    parsed = json.loads(fmt.format(record))
    assert parsed["msg"] == "failed"
    assert "ValueError" in parsed["exc"]
    assert "boom-detail" in parsed["exc"]


def test_deployment_context_defaults_to_dev():
    ctx = observability.deployment_context({})
    assert ctx["env"] == "dev"
    assert ctx["deployment_sha"] == "dev"
    assert ctx["model_version"] == MODEL_VERSION


def test_before_send_redacts_authorization_and_scrubs_financials():
    event = {
        "request": {
            "headers": {"Authorization": "Bearer sk-secret1234567890", "Accept": "json"},
            "cookies": {"sid": "x"},
            "data": {"capital": "$277,990"},
        },
        "extra": {"note": "rent is $14/sqft"},
    }
    out = observability._before_send(event, None)
    assert out["request"]["headers"]["Authorization"] == "[redacted]"
    assert out["request"]["headers"]["Accept"] == "json"
    assert "cookies" not in out["request"]
    assert "$277,990" not in json.dumps(out)
    assert "$14" not in json.dumps(out)

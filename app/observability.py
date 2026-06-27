"""app/observability.py — structured (JSON) logging + opt-in Sentry init (#190).

Incident-readiness, beyond the per-provider metrics in #95:

- ``configure_logging`` installs a JSON formatter on the root logger so every record
  is one machine-parseable line stamped with deploy context (``deployment_sha`` /
  ``model_version`` / ``env``) and **secret-scrubbed** via ``app.metrics.scrub``
  (SECURITY §6.3/§10 — no secret or financial figure ever lands in a log line). It is
  additive + idempotent: it tags its own handler and never clobbers another (so
  pytest ``caplog`` and uvicorn keep working).

- ``init_sentry`` is the durable error-capture hook (OPS_RUNBOOK §6.2). It is
  **opt-in and safe**: a no-op when ``SENTRY_DSN`` is unset OR when ``sentry_sdk`` is
  not installed — it must NEVER break boot. When active it tags every event with
  ``deployment_sha`` / ``model_version`` / environment and runs a ``before_send`` that
  drops ``Authorization`` headers + cookies and scrubs request bodies / financial
  fields before anything leaves the server.

``sentry_sdk`` is intentionally NOT a hard dependency: the import is guarded so dev
and CI run without it. To activate Sentry in production, install ``sentry-sdk`` in the
runtime image and set ``SENTRY_DSN`` (OPS_RUNBOOK §5.2).
"""
from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Mapping
from typing import IO, Any

from app import config
from app.metrics import scrub
from engine.model import MODEL_VERSION

logger = logging.getLogger("app")

# LogRecord built-ins we never echo as structured "extra" fields.
_RESERVED_LOGRECORD_ATTRS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message", "asctime",
    }
)


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def deployment_context(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """The deploy tags stamped on every log line and Sentry event."""
    e = _env(env)
    return {
        "deployment_sha": config.build_sha(e),
        "model_version": MODEL_VERSION,
        "env": "production" if config.is_production(e) else (e.get("APP_ENV") or "dev"),
    }


class JsonLogFormatter(logging.Formatter):
    """Render each record as a single scrubbed JSON line with deploy context."""

    def __init__(self, *, context: Mapping[str, Any] | None = None) -> None:
        super().__init__()
        self._context = dict(context or {})

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            **self._context,
        }
        # Structured extras (logger.info(..., extra={...})) ride along verbatim.
        for key, val in record.__dict__.items():
            if key not in _RESERVED_LOGRECORD_ATTRS and not key.startswith("_"):
                payload[key] = val
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Defense-in-depth: scrub the whole payload so an accidental secret/financial
        # value in a message or extra cannot leak to the log sink.
        return json.dumps(scrub(payload), default=str, sort_keys=True)


def configure_logging(
    env: Mapping[str, str] | None = None, *, stream: IO[str] | None = None
) -> None:
    """Attach a JSON handler with deploy context to the root logger (idempotent).

    Adds (never replaces) a single tagged handler so app logs become structured JSON
    without clobbering pytest ``caplog`` or uvicorn's own handlers. Re-invocation
    swaps only the previously-tagged handler.
    """
    e = _env(env)
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not getattr(h, "_app_json_handler", False)]
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JsonLogFormatter(context=deployment_context(e)))
    handler._app_json_handler = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    level = (e.get("LOG_LEVEL") or "INFO").upper()
    root.setLevel(getattr(logging, level, logging.INFO))


def _before_send(event: dict[str, Any], hint: Any | None = None) -> dict[str, Any]:
    """Sentry ``before_send``: drop auth/cookies, scrub bodies + financial fields.

    Never raises — a scrub failure must not suppress the (less-redacted) event nor
    break the request path.
    """
    try:
        request = event.get("request")
        if isinstance(request, dict):
            headers = request.get("headers")
            if isinstance(headers, dict):
                request["headers"] = {
                    k: ("[redacted]" if k.lower() == "authorization" else v)
                    for k, v in headers.items()
                }
            request.pop("cookies", None)
            request.pop("query_string", None)
            if "data" in request:
                request["data"] = scrub(request["data"])
        for key in ("extra", "contexts"):
            if isinstance(event.get(key), dict):
                event[key] = scrub(event[key])
    except Exception:  # redaction is best-effort; never drop the event on error
        return event
    return event


def init_sentry(env: Mapping[str, str] | None = None) -> bool:
    """Opt-in, safe Sentry init. Returns True only when Sentry was actually wired.

    No-op (returns False) when ``SENTRY_DSN`` is unset or ``sentry_sdk`` is absent —
    boot must never break because error tracking is optional (OPS_RUNBOOK §5.2/§6.2).
    """
    e = _env(env)
    dsn = e.get("SENTRY_DSN")
    if not dsn:
        return False  # opt-in: no DSN, no Sentry
    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except Exception:
        # DSN set but the SDK isn't installed — log a structured nudge, don't crash.
        logger.warning(
            "sentry_dsn_set_but_sdk_missing: install sentry-sdk to enable error tracking"
        )
        return False
    ctx = deployment_context(e)
    try:
        traces = float(e.get("SENTRY_TRACES_SAMPLE_RATE") or 0.0)
    except (TypeError, ValueError):
        traces = 0.0
    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=ctx["env"],
            release=ctx["deployment_sha"],
            send_default_pii=False,  # never auto-attach IPs / headers / cookies
            before_send=_before_send,
            traces_sample_rate=traces,
        )
        sentry_sdk.set_tag("deployment_sha", ctx["deployment_sha"])
        sentry_sdk.set_tag("model_version", ctx["model_version"])
    except Exception as exc:  # a misconfigured DSN must not break boot
        logger.warning("sentry_init_failed: %s", type(exc).__name__)
        return False
    logger.info("sentry_initialized", extra={"env": ctx["env"]})
    return True

"""app/config.py — single source of truth for env requirements (SECURITY.md §4).

Boot-refuse policy: in PRODUCTION the server refuses to boot if any required var
is unset — NO fallback chains, NO silent defaults (timpager regression #21).
Dev/test are permissive so the AI-opt-out path stays testable with no keys set.

Required in prod (SECURITY.md §4.1):
  DB_BACKEND, DB_PATH (sqlite) / DATABASE_URL (postgres),
  GOOGLE_PLACES_API_KEY, and at-least-one AI provider
  (ANTHROPIC_API_KEY OR OPENAI_API_KEY).
Optional / graceful-degrade: OPENAI_API_KEY, CENSUS_API_KEY (the Census API
  works keyless for low volume; a key only raises rate limits), GITHUB_TOKEN+
  GITHUB_REPO, CRM_API_KEY, LITESTREAM_* (health-checked live), SENTRY_DSN.
"""
from __future__ import annotations

import os
from collections.abc import Mapping


class ConfigError(RuntimeError):
    """Raised at boot when a required secret/config var is unset in production."""


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def is_production(env: Mapping[str, str] | None = None) -> bool:
    return _env(env).get("APP_ENV", "dev").lower() in ("prod", "production")


def _missing_required(env: Mapping[str, str]) -> list[str]:
    """Return the names of required-but-unset vars (no fallback chains).

    The AI provider rule is the only "at least one" rule; everything else
    required is required outright.
    """
    missing: list[str] = []

    backend = env.get("DB_BACKEND", "")
    if not backend:
        missing.append("DB_BACKEND")
    elif backend == "sqlite":
        if not env.get("DB_PATH"):
            missing.append("DB_PATH")
    elif backend == "postgres":
        if not env.get("DATABASE_URL"):
            missing.append("DATABASE_URL")
    else:
        missing.append("DB_BACKEND (must be 'sqlite' or 'postgres')")

    if not env.get("GOOGLE_PLACES_API_KEY"):
        missing.append("GOOGLE_PLACES_API_KEY")
    # CENSUS_API_KEY is optional: the Census API serves low-volume requests
    # keyless; a key only raises rate limits, so it must not block boot.

    # At least one AI provider.
    if not (env.get("ANTHROPIC_API_KEY") or env.get("OPENAI_API_KEY")):
        missing.append("ANTHROPIC_API_KEY or OPENAI_API_KEY")

    return missing


def validate_required(env: Mapping[str, str] | None = None) -> None:
    """Refuse to boot in production if any required var is unset.

    Called at app startup BEFORE serving (SECURITY.md §11.3 boot order:
    migrate -> validate config -> serve). Dev/test are permissive: a missing
    var is tolerated (logged by the caller) so opt-out tests run with no keys.
    """
    env = _env(env)
    if not is_production(env):
        return
    missing = _missing_required(env)
    if missing:
        raise ConfigError(
            "Refusing to boot: required configuration is unset (no fallback "
            "chains): " + ", ".join(missing)
        )


def build_sha(env: Mapping[str, str] | None = None) -> str:
    """The deployed git SHA (Railway sets RAILWAY_GIT_COMMIT_SHA); 'dev' locally.

    Used by /api/health so the promote step can verify the NEW build is live
    (DEFINITION_OF_DONE — a bare 200 from the old build is not proof).
    """
    env = _env(env)
    return env.get("BUILD_SHA") or env.get("RAILWAY_GIT_COMMIT_SHA") or "dev"


def app_origin(env: Mapping[str, str] | None = None) -> str:
    """The exact app origin for the CORS allowlist (SECURITY.md §8.2)."""
    env = _env(env)
    return env.get("APP_ORIGIN", "http://localhost:5173")


def _as_bool(val: str | None) -> bool:
    return (val or "").strip().lower() in ("1", "true", "yes", "on")


# --- Business-model price/gate FLAG (PRD §3, M6-GATE / issue #85) --------------
# THE single server config for the free-vs-paid decision: `gate_config` below is
# the canonical {gate_mode, price_usd} toggle. The older `pricing_config` (cents-
# denominated UI posture) is retained for backward compatibility only.
GATE_MODE_FREE = "free"
GATE_MODE_PAID = "paid_review"
_VALID_GATE_MODES = (GATE_MODE_FREE, GATE_MODE_PAID)


def _parse_price_usd(raw: str | None) -> float | int | None:
    """Parse GATE_PRICE_USD -> a non-negative number (int when whole), else None.

    Garbage / negative / unset -> None so the client never renders a bad price and
    the server never crashes on a typo'd config value.
    """
    if raw is None or not raw.strip():
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if val < 0:
        return None
    return int(val) if val.is_integer() else val


def gate_config(
    env: Mapping[str, str] | None = None, cohort: str | None = None
) -> dict:
    """The free-vs-paid price/gate flag (PRD §3 business-model TOGGLE, issue #85).

    Shape: ``{"gate_mode": "free"|"paid_review", "price_usd": number|None}``.

    - **Safe default `free`** — an unset/unknown ``GATE_MODE`` resolves to ``free``
      (the lead-gen flywheel default). This flag is NEVER a required boot secret;
      a missing value must not refuse boot (it is absent from ``validate_required``).
    - **No-deploy flip** — resolved from the environment on EVERY call (the read
      endpoint and the gate dependency call this per request), so a settings/env
      change flips behavior on the next request with no restart.
    - **price_usd** is surfaced ONLY in ``paid_review`` (``None`` in ``free``); the
      client renders the CTA from this value — no client-side price math.
    - **A/B seam (M-1)** — ``cohort`` lets an experiment address a per-cohort mode
      via ``GATE_MODE__<COHORT>``, falling back to the global ``GATE_MODE``. Wiring
      the experiment itself is M-1; this only exposes the seam.

    Whether the gated expert-review surface is open is a business-model decision,
    NOT an access-control bug (SECURITY.md §3): the basic ``.xlsx``/packet always
    remain free and ungated, and this flag is orthogonal to the terms gate.
    """
    env = _env(env)
    raw_mode: str | None = None
    if cohort:
        raw_mode = env.get(f"GATE_MODE__{cohort.strip().upper()}")
    if raw_mode is None:
        raw_mode = env.get("GATE_MODE")
    mode = (raw_mode or "").strip().lower()
    if mode not in _VALID_GATE_MODES:
        mode = GATE_MODE_FREE
    price_usd = (
        _parse_price_usd(env.get("GATE_PRICE_USD"))
        if mode == GATE_MODE_PAID
        else None
    )
    return {"gate_mode": mode, "price_usd": price_usd}


def pricing_config(env: Mapping[str, str] | None = None) -> dict:
    """Legacy cents-denominated pricing posture (superseded by ``gate_config``).

    Retained for backward compatibility. The canonical free-vs-paid gate for
    issue #85 is ``gate_config`` above; whether export/share is gated behind the
    paid expert-review event is a business-model TOGGLE (PRD §3), NOT an
    access-control bug (SECURITY.md §3). Defaults: free, ungated, $0.
    """
    env = _env(env)
    try:
        price_cents = int(env.get("PRICE_CENTS", "0"))
    except (TypeError, ValueError):
        price_cents = 0
    return {
        "tier": env.get("PRICING_TIER", "free").strip().lower() or "free",
        "export_gated": _as_bool(env.get("EXPORT_GATED")),
        "price_cents": max(price_cents, 0),
    }


def crm_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Intent -> CRM is optional/graceful-degrade (SECURITY.md §4.2)."""
    return bool(_env(env).get("CRM_API_KEY"))


def litestream_status(env: Mapping[str, str] | None = None) -> str:
    """Reported by /api/health. 'replicating' if LITESTREAM_* configured.

    In production replication must not be silently off (SECURITY.md §11.2); the
    health check surfaces 'disabled' loudly so monitoring can alert.
    """
    env = _env(env)
    if env.get("LITESTREAM_BUCKET"):
        return "replicating"
    return "disabled"

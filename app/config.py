"""app/config.py — single source of truth for env requirements (SECURITY.md §4).

Boot-refuse policy: in PRODUCTION the server refuses to boot if any required var
is unset — NO fallback chains, NO silent defaults (timpager regression #21).
Dev/test are permissive so the AI-opt-out path stays testable with no keys set.

Required in prod (SECURITY.md §4.1):
  DB_BACKEND, DB_PATH (sqlite) / DATABASE_URL (postgres),
  GOOGLE_PLACES_API_KEY, CENSUS_API_KEY, and at-least-one AI provider
  (ANTHROPIC_API_KEY OR OPENAI_API_KEY).
Optional / graceful-degrade: OPENAI_API_KEY, GITHUB_TOKEN+GITHUB_REPO,
  CRM_API_KEY, LITESTREAM_* (health-checked live), SENTRY_DSN.
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
    if not env.get("CENSUS_API_KEY"):
        missing.append("CENSUS_API_KEY")

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


def litestream_status(env: Mapping[str, str] | None = None) -> str:
    """Reported by /api/health. 'replicating' if LITESTREAM_* configured.

    In production replication must not be silently off (SECURITY.md §11.2); the
    health check surfaces 'disabled' loudly so monitoring can alert.
    """
    env = _env(env)
    if env.get("LITESTREAM_BUCKET"):
        return "replicating"
    return "disabled"

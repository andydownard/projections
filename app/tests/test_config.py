"""Boot-refuse config validation tests (M0.3 / SECURITY.md §4).

Prod refuses to boot on a missing required secret (no fallback chains). Dev/test
are permissive so the AI-opt-out path stays testable with no keys set.
"""
import pytest

from app.config import (
    ConfigError,
    app_origin,
    build_sha,
    is_production,
    litestream_status,
    validate_required,
)

PROD_FULL = {
    "APP_ENV": "production",
    "DB_BACKEND": "sqlite",
    "DB_PATH": "/data/projections.db",
    "GOOGLE_PLACES_API_KEY": "g",
    "CENSUS_API_KEY": "c",
    "ANTHROPIC_API_KEY": "a",
}


def test_prod_boots_when_all_required_present():
    validate_required(dict(PROD_FULL))  # no raise


def test_prod_refuses_on_missing_places_key():
    env = dict(PROD_FULL)
    del env["GOOGLE_PLACES_API_KEY"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "GOOGLE_PLACES_API_KEY" in str(exc.value)


def test_prod_tolerates_missing_census_key():
    # Census API is keyless-capable for low volume; the key is optional and must
    # NOT block boot (a missing key boots fine; a key only raises rate limits).
    env = dict(PROD_FULL)
    del env["CENSUS_API_KEY"]
    validate_required(env)  # no raise


def test_prod_refuses_when_no_ai_provider():
    env = dict(PROD_FULL)
    del env["ANTHROPIC_API_KEY"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "ANTHROPIC_API_KEY or OPENAI_API_KEY" in str(exc.value)


def test_prod_at_least_one_ai_provider_openai_suffices():
    env = dict(PROD_FULL)
    del env["ANTHROPIC_API_KEY"]
    env["OPENAI_API_KEY"] = "o"
    validate_required(env)  # no raise — the "at least one" rule


def test_prod_refuses_on_missing_db_path_for_sqlite():
    env = dict(PROD_FULL)
    del env["DB_PATH"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "DB_PATH" in str(exc.value)


def test_postgres_backend_requires_database_url():
    env = dict(PROD_FULL)
    env["DB_BACKEND"] = "postgres"
    env.pop("DB_PATH")
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "DATABASE_URL" in str(exc.value)


def test_unknown_backend_is_rejected():
    env = dict(PROD_FULL)
    env["DB_BACKEND"] = "mongodb"
    with pytest.raises(ConfigError):
        validate_required(env)


def test_dev_is_permissive_with_nothing_set():
    validate_required({"APP_ENV": "dev"})  # no raise — opt-out path stays testable


def test_no_fallback_chain_each_missing_named():
    env = {"APP_ENV": "production", "DB_BACKEND": "sqlite"}
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    msg = str(exc.value)
    for name in ("DB_PATH", "GOOGLE_PLACES_API_KEY"):
        assert name in msg


def test_is_production_detection():
    assert is_production({"APP_ENV": "production"})
    assert is_production({"APP_ENV": "prod"})
    assert not is_production({"APP_ENV": "dev"})
    assert not is_production({})


def test_build_sha_falls_back_to_dev():
    assert build_sha({}) == "dev"
    assert build_sha({"BUILD_SHA": "abc123"}) == "abc123"
    assert build_sha({"RAILWAY_GIT_COMMIT_SHA": "rail9"}) == "rail9"


def test_litestream_status_reflects_config():
    assert litestream_status({}) == "disabled"
    assert litestream_status({"LITESTREAM_BUCKET": "b"}) == "replicating"


def test_app_origin_default_and_override():
    assert app_origin({}) == "http://localhost:5173"
    assert app_origin({"APP_ORIGIN": "https://x.thriftly.com"}) == "https://x.thriftly.com"

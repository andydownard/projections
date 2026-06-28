"""Phase 1 — Clerk config: kill switch, boot-refuse matrix, no-secret guardrail.

Ship-dark contract: with ``CLERK_ENABLED`` off/unset the app is byte-for-byte the
capability-token app it is today — NO Clerk var is required and boot is unchanged.
When ``CLERK_ENABLED`` is on in production, the verify-side vars are required
(fail-closed). projections is a satellite and must NEVER hold a Clerk secret.
"""
import pytest

from app.config import ConfigError, clerk_config, clerk_enabled, validate_required

# A fully-configured prod env WITHOUT any Clerk vars (Clerk off == today).
PROD_BASE = {
    "APP_ENV": "production",
    "DB_BACKEND": "sqlite",
    "DB_PATH": "/data/projections.db",
    "GOOGLE_PLACES_API_KEY": "g",
    "ANTHROPIC_API_KEY": "a",
}

CLERK_ON = {
    "CLERK_ENABLED": "1",
    "CLERK_JWT_ISSUER": "https://clerk.rallytasks.com",
    "CLERK_PUBLISHABLE_KEY": "pk_live_x",
    "CLERK_AUTHORIZED_PARTIES": "https://projections.thriftly.com",
}


# ---- kill switch -----------------------------------------------------------
def test_clerk_disabled_by_default():
    assert clerk_enabled({}) is False
    assert clerk_enabled({"CLERK_ENABLED": ""}) is False
    assert clerk_enabled({"CLERK_ENABLED": "0"}) is False
    assert clerk_enabled({"CLERK_ENABLED": "false"}) is False


def test_clerk_enabled_strict_truthy():
    for v in ("1", "true", "TRUE", "yes", "on"):
        assert clerk_enabled({"CLERK_ENABLED": v}) is True
    assert clerk_enabled({"CLERK_ENABLED": "maybe"}) is False


# ---- boot-refuse: Clerk OFF => no Clerk vars required (ship dark) ----------
def test_prod_boots_with_clerk_off_and_no_clerk_vars():
    validate_required(dict(PROD_BASE))  # no raise — unchanged from today


def test_clerk_vars_not_required_when_disabled():
    env = dict(PROD_BASE)
    env["CLERK_JWT_ISSUER"] = ""  # present-but-empty, still off
    validate_required(env)  # no raise


# ---- boot-refuse: Clerk ON in prod => verify vars required ------------------
def test_prod_clerk_on_requires_issuer():
    env = {**PROD_BASE, **CLERK_ON}
    del env["CLERK_JWT_ISSUER"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "CLERK_JWT_ISSUER" in str(exc.value)


def test_prod_clerk_on_requires_publishable_key():
    env = {**PROD_BASE, **CLERK_ON}
    del env["CLERK_PUBLISHABLE_KEY"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "CLERK_PUBLISHABLE_KEY" in str(exc.value)


def test_prod_clerk_on_requires_authorized_parties():
    env = {**PROD_BASE, **CLERK_ON}
    del env["CLERK_AUTHORIZED_PARTIES"]
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "CLERK_AUTHORIZED_PARTIES" in str(exc.value)


def test_prod_clerk_on_fully_configured_boots():
    validate_required({**PROD_BASE, **CLERK_ON})  # no raise


# ---- guardrail: projections is a satellite and holds NO Clerk secret -------
def test_prod_refuses_when_clerk_secret_key_set():
    env = {**PROD_BASE, **CLERK_ON, "CLERK_SECRET_KEY": "sk_live_should_not_be_here"}
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "CLERK_SECRET_KEY" in str(exc.value)


def test_prod_refuses_webhook_secret_even_with_clerk_off():
    # The no-secret guardrail is unconditional: a satellite never holds it, even
    # if someone leaves Clerk disabled.
    env = {**PROD_BASE, "CLERK_WEBHOOK_SIGNING_SECRET": "whsec_x"}
    with pytest.raises(ConfigError) as exc:
        validate_required(env)
    assert "CLERK_WEBHOOK_SIGNING_SECRET" in str(exc.value)


# ---- clerk_config: the single resolved view of the env ---------------------
def test_clerk_config_shape_when_on():
    cfg = clerk_config(CLERK_ON)
    assert cfg["enabled"] is True
    assert cfg["issuer"] == "https://clerk.rallytasks.com"
    assert cfg["authorized_parties"] == ["https://projections.thriftly.com"]
    assert cfg["leeway_seconds"] == 10  # default


def test_clerk_config_parses_csv_authorized_parties_and_leeway():
    cfg = clerk_config({
        **CLERK_ON,
        "CLERK_AUTHORIZED_PARTIES": "https://a.thriftly.com, https://b.thriftly.com",
        "CLERK_JWT_LEEWAY_SECONDS": "45",
    })
    assert cfg["authorized_parties"] == [
        "https://a.thriftly.com",
        "https://b.thriftly.com",
    ]
    assert cfg["leeway_seconds"] == 45


def test_clerk_config_bad_leeway_falls_back_to_default():
    cfg = clerk_config({**CLERK_ON, "CLERK_JWT_LEEWAY_SECONDS": "garbage"})
    assert cfg["leeway_seconds"] == 10


def test_clerk_config_off_has_no_required_values():
    cfg = clerk_config({})
    assert cfg["enabled"] is False
    assert cfg["issuer"] is None
    assert cfg["authorized_parties"] == []

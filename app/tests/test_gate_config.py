"""Business-model price/gate FLAG — the single server config (PRD §3, issue #85).

`config.gate_config` is the canonical free-vs-paid toggle: it returns the shape
`{gate_mode: "free"|"paid_review", price_usd: number|None}` with a SAFE DEFAULT of
`free`. It is NEVER a required boot secret (a missing value defaults to free and
must not refuse boot), it is re-read every call (no-deploy flip), and it surfaces
`price_usd` ONLY in paid mode. A `cohort` arg exposes the M-1 A/B seam.

These unit tests pin the flag's pure behavior; the enforcement boundary (the gate
dependency over the expert-review surface, independence from terms, and the
toggle matrix over the export surfaces) lives in test_gate_api.py.
"""
from app import config
from app.config import (
    GATE_MODE_FREE,
    GATE_MODE_PAID,
    ConfigError,
    gate_config,
    validate_required,
)

PROD_FULL = {
    "APP_ENV": "production",
    "DB_BACKEND": "sqlite",
    "DB_PATH": "/data/projections.db",
    "GOOGLE_PLACES_API_KEY": "g",
    "ANTHROPIC_API_KEY": "a",
}


# --- safe default = free, ungated, no price -----------------------------------

def test_default_is_free_with_no_price():
    cfg = gate_config({})
    assert cfg["gate_mode"] == "free"
    assert cfg["price_usd"] is None


def test_constants_match_the_two_modes():
    assert GATE_MODE_FREE == "free"
    assert GATE_MODE_PAID == "paid_review"


def test_unknown_mode_falls_back_to_free():
    # A typo / unknown value must never silently gate (safe default).
    assert gate_config({"GATE_MODE": "premium"})["gate_mode"] == "free"
    assert gate_config({"GATE_MODE": ""})["gate_mode"] == "free"


def test_mode_is_case_insensitive():
    assert gate_config({"GATE_MODE": "PAID_REVIEW"})["gate_mode"] == "paid_review"
    assert gate_config({"GATE_MODE": " Free "})["gate_mode"] == "free"


# --- price_usd surfaced ONLY in paid_review -----------------------------------

def test_paid_review_surfaces_price():
    cfg = gate_config({"GATE_MODE": "paid_review", "GATE_PRICE_USD": "49"})
    assert cfg["gate_mode"] == "paid_review"
    assert cfg["price_usd"] == 49


def test_price_is_none_in_free_even_when_set():
    # No client-side price math: a price only travels when the gate is paid.
    cfg = gate_config({"GATE_MODE": "free", "GATE_PRICE_USD": "49"})
    assert cfg["price_usd"] is None


def test_price_garbage_is_none_not_a_crash():
    cfg = gate_config({"GATE_MODE": "paid_review", "GATE_PRICE_USD": "not-a-number"})
    assert cfg["price_usd"] is None


def test_negative_price_is_rejected_to_none():
    cfg = gate_config({"GATE_MODE": "paid_review", "GATE_PRICE_USD": "-10"})
    assert cfg["price_usd"] is None


def test_whole_price_is_int_fractional_is_float():
    assert gate_config({"GATE_MODE": "paid_review", "GATE_PRICE_USD": "49"})["price_usd"] == 49
    frac = gate_config({"GATE_MODE": "paid_review", "GATE_PRICE_USD": "49.5"})["price_usd"]
    assert frac == 49.5
    assert isinstance(frac, float)


def test_missing_price_in_paid_is_none():
    cfg = gate_config({"GATE_MODE": "paid_review"})
    assert cfg["gate_mode"] == "paid_review"
    assert cfg["price_usd"] is None


# --- A/B seam (M-1): a cohort can address a per-cohort mode --------------------

def test_cohort_overrides_global_mode():
    env = {"GATE_MODE": "free", "GATE_MODE__B": "paid_review", "GATE_PRICE_USD": "49"}
    assert gate_config(env)["gate_mode"] == "free"
    assert gate_config(env, cohort="b")["gate_mode"] == "paid_review"
    assert gate_config(env, cohort="b")["price_usd"] == 49


def test_cohort_without_override_falls_back_to_global():
    env = {"GATE_MODE": "paid_review", "GATE_PRICE_USD": "49"}
    assert gate_config(env, cohort="control")["gate_mode"] == "paid_review"


# --- safe default: the flag is NEVER a required boot secret --------------------

def test_missing_gate_config_does_not_refuse_boot():
    # Contrast a required secret: the gate has a safe default, so prod boots fine
    # with GATE_MODE/GATE_PRICE_USD entirely unset (SECURITY.md §3/§4).
    validate_required(dict(PROD_FULL))  # no raise


def test_gate_vars_are_not_in_the_required_set():
    env = dict(PROD_FULL)
    env["GATE_MODE"] = ""  # explicitly blank
    env["GATE_PRICE_USD"] = ""
    validate_required(env)  # still no raise


def test_a_real_missing_required_secret_still_refuses():
    # Sanity: the gate's leniency did not loosen the boot-refuse policy.
    env = dict(PROD_FULL)
    del env["GOOGLE_PLACES_API_KEY"]
    try:
        validate_required(env)
        raised = False
    except ConfigError:
        raised = True
    assert raised


def test_gate_config_reads_live_environment(monkeypatch):
    # No-deploy flip at the source: env=None reads os.environ on every call.
    monkeypatch.delenv("GATE_MODE", raising=False)
    assert config.gate_config()["gate_mode"] == "free"
    monkeypatch.setenv("GATE_MODE", "paid_review")
    monkeypatch.setenv("GATE_PRICE_USD", "75")
    assert config.gate_config()["gate_mode"] == "paid_review"
    assert config.gate_config()["price_usd"] == 75

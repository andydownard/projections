"""Epic F (#265, decisions #6/#13) — Clerk-identity feedback foundations.

When a signed-in Clerk owner files feedback, the server reads email/name/phone
from the Clerk session-JWT **claims** (NO Clerk Backend API, NO Clerk secret) and
persists them SERVER-SIDE in the new nullable ``creator_*`` columns. These PII
fields must NEVER reach the public GitHub issue — ``redact.py`` still governs the
public payload (the product's #1 data-leak risk, PRD §22, Regression #7).

Additive + dormant: with ``CLERK_ENABLED`` off (the default), and for anonymous
feedback, the row is byte-for-byte what it is today (all ``creator_*`` NULL).
"""
import json

import pytest
from fastapi.testclient import TestClient

import app.clerk.verify as clerkverify
import app.routers.feedback as feedback_mod
from app.feedback.creator import creator_fields_from_claims
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore
from app.tests.clerk_testkit import TEST_AZP, TEST_ISSUER, make_keypair, mint, stub_for

CREATOR_COLS = (
    "creator_email",
    "creator_name",
    "creator_phone",
    "creator_clerk_user_id",
)

# Realistic PII that an enriched Clerk JWT template would carry. None of these
# strings may ever appear in the outbound GitHub payload.
PII_EMAIL = "ed@hopethrift.org"
PII_NAME = "Dana Operator"
PII_PHONE = "+15551234567"
PII_SUB = "user_2clerkOwner99"


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    reset_rate_limits()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


@pytest.fixture()
def captured(monkeypatch):
    """Capture every outbound GitHub payload (the redaction seam)."""
    calls = []

    def _fake_file(payload: dict) -> str:
        calls.append(payload)
        return "https://github.com/rallytasks/projections/issues/1"

    monkeypatch.setattr(feedback_mod, "file_github_issue", _fake_file)
    return calls


@pytest.fixture()
def clerk_on(monkeypatch):
    """Turn on CLERK_ENABLED and route JWKS resolution to an in-memory stub."""
    priv, pub = make_keypair()
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: stub_for(pub))
    monkeypatch.setenv("CLERK_ENABLED", "1")
    monkeypatch.setenv("CLERK_JWT_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", TEST_AZP)
    return priv


def _row(store, sid):
    r = store._conn.execute(
        "SELECT * FROM feedback WHERE support_id = ?", (sid,)
    ).fetchone()
    return dict(r)


# --- 1) the pure extractor (no network, no secret) --------------------------
def test_extractor_reads_email_name_phone_from_claims():
    fields = creator_fields_from_claims(
        {
            "sub": PII_SUB,
            "email": PII_EMAIL,
            "name": PII_NAME,
            "phone_number": PII_PHONE,
        },
        clerk_user_id=PII_SUB,
    )
    assert fields["creator_email"] == PII_EMAIL
    assert fields["creator_name"] == PII_NAME
    assert fields["creator_phone"] == PII_PHONE
    assert fields["creator_clerk_user_id"] == PII_SUB


def test_extractor_tolerates_missing_claims():
    # A bare session token (no enriched claims) — every PII field is optional.
    fields = creator_fields_from_claims({"sub": PII_SUB}, clerk_user_id=PII_SUB)
    assert fields["creator_clerk_user_id"] == PII_SUB
    assert fields["creator_email"] is None
    assert fields["creator_name"] is None
    assert fields["creator_phone"] is None


def test_extractor_derives_name_from_first_last():
    fields = creator_fields_from_claims(
        {"sub": "u", "first_name": "Dana", "last_name": "Operator"},
        clerk_user_id="u",
    )
    assert fields["creator_name"] == "Dana Operator"


def test_extractor_handles_none_claims():
    fields = creator_fields_from_claims(None, clerk_user_id=None)
    assert set(fields) == set(CREATOR_COLS)
    assert all(v is None for v in fields.values())


# --- 2) migration: additive nullable columns --------------------------------
def test_creator_columns_exist_and_are_nullable(store):
    info = {r[1]: r for r in store._conn.execute("PRAGMA table_info(feedback)")}
    for col in CREATOR_COLS:
        assert col in info, f"{col} missing from feedback"
        # PRAGMA table_info: col[3] == notnull flag (0 == nullable).
        assert info[col][3] == 0, f"{col} must be nullable"


def test_migration_registered_and_additive():
    from app.store.migration_safety import scan_sql
    from app.store.migrations import MIGRATIONS

    names = [n for n, _ in MIGRATIONS]
    assert "0011_feedback_creator" in names
    sql = dict(MIGRATIONS)["0011_feedback_creator"]
    assert scan_sql(sql) == []  # no DROP/RENAME/destructive ALTER


def test_migration_is_idempotent(store):
    # Re-running migrate() must not raise (duplicate-column-safe runner, #185).
    store.migrate()
    info = {r[1] for r in store._conn.execute("PRAGMA table_info(feedback)")}
    for col in CREATOR_COLS:
        assert col in info


# --- 3) signed-in Clerk owner: creator_* persisted SERVER-SIDE ---------------
def test_signed_in_clerk_owner_persists_creator_fields(client, store, captured, clerk_on):
    token = mint(
        clerk_on,
        sub=PII_SUB,
        extra={"email": PII_EMAIL, "name": PII_NAME, "phone_number": PII_PHONE},
    )
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "title": "x", "description": "y", "route": "/p/ex"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    row = _row(store, r.json()["support_id"])
    assert row["creator_email"] == PII_EMAIL
    assert row["creator_name"] == PII_NAME
    assert row["creator_phone"] == PII_PHONE
    assert row["creator_clerk_user_id"] == PII_SUB


# --- 4) THE security gate: creator_* PII never reaches GitHub ----------------
def test_creator_pii_never_reaches_github_payload(client, store, captured, clerk_on):
    token = mint(
        clerk_on,
        sub=PII_SUB,
        extra={"email": PII_EMAIL, "name": PII_NAME, "phone_number": PII_PHONE},
    )
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "title": "Banner bug", "description": "off by one"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    assert captured, "GitHub filer was not called"
    out = json.dumps(captured[-1])
    for leak in (PII_EMAIL, PII_NAME, PII_PHONE, PII_SUB):
        assert leak not in out, f"creator PII {leak!r} leaked into GitHub payload"
    # the redacted context still carries ONLY the server allowlist.
    from app.feedback.redact import SAFE_CONTEXT_KEYS

    assert set(captured[-1]["context"]) == set(SAFE_CONTEXT_KEYS)
    # and no creator_* key smuggled into the payload at all.
    for col in CREATOR_COLS:
        assert col not in out


# --- 5) anonymous + ship-dark: unchanged (creator_* NULL) -------------------
def test_anonymous_feedback_leaves_creator_fields_null(client, store, captured):
    r = client.post(
        "/api/feedback",
        json={"type": "idea", "description": "dark mode please"},
    )
    assert r.status_code == 201, r.text
    row = _row(store, r.json()["support_id"])
    for col in CREATOR_COLS:
        assert row[col] is None


def test_clerk_jwt_ignored_when_kill_switch_off(client, store, captured, monkeypatch):
    # CLERK_ENABLED unset → a Clerk JWT is just an opaque bearer; no creator_*.
    monkeypatch.delenv("CLERK_ENABLED", raising=False)
    priv, pub = make_keypair()
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: stub_for(pub))
    token = mint(priv, sub=PII_SUB, extra={"email": PII_EMAIL})
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "title": "x", "description": "y"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    row = _row(store, r.json()["support_id"])
    for col in CREATOR_COLS:
        assert row[col] is None


def test_invalid_clerk_jwt_files_anonymously(client, store, captured, monkeypatch):
    # Well-formed JWT shape but wrong issuer → verify fails → no creator_*, no 500.
    priv, pub = make_keypair()
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: stub_for(pub))
    monkeypatch.setenv("CLERK_ENABLED", "1")
    monkeypatch.setenv("CLERK_JWT_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", TEST_AZP)
    token = mint(priv, sub=PII_SUB, iss="https://evil.example.com", extra={"email": PII_EMAIL})
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "title": "x", "description": "y"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    row = _row(store, r.json()["support_id"])
    for col in CREATOR_COLS:
        assert row[col] is None

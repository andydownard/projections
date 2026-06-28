"""Phase 2 — ``resolve_bearer_identity``: shape-route a Bearer to Clerk vs capability.

COOKIE-BLIND by construction (the resolver only ever receives the Authorization
header string — there is no cookies parameter). Returns exactly one of
``ClerkOwner`` / ``CapabilityBearer`` / ``Anonymous`` and NEVER raises (no 500) —
a malformed or invalid Clerk JWT falls through to the capability path (fail-closed).

Ship-dark: with ``CLERK_ENABLED`` off, a Clerk JWT is treated as an opaque bearer
(it won't match any owner hash → anonymous at the row level), so the capability
flow is 100% unchanged.
"""
import pytest

import app.clerk.verify as clerkverify
from app.deps import (
    Anonymous,
    CapabilityBearer,
    ClerkOwner,
    resolve_bearer_identity,
)
from app.tests.clerk_testkit import (
    TEST_AZP,
    TEST_ISSUER,
    make_keypair,
    mint,
    stub_for,
)

CLERK_ON = {
    "CLERK_ENABLED": "1",
    "CLERK_JWT_ISSUER": TEST_ISSUER,
    "CLERK_AUTHORIZED_PARTIES": TEST_AZP,
}


@pytest.fixture()
def clerk_keys(monkeypatch):
    priv, pub = make_keypair()
    jwks = stub_for(pub)
    # Route the production JWKS-client lookup to the in-memory stub (no network).
    monkeypatch.setattr(clerkverify, "_get_jwks_client", lambda issuer: jwks)
    return priv


# ---- anonymous / cookie-blind ---------------------------------------------
def test_no_authorization_is_anonymous():
    assert isinstance(resolve_bearer_identity(None, env=CLERK_ON), Anonymous)


def test_empty_bearer_is_anonymous():
    assert isinstance(resolve_bearer_identity("Bearer   ", env=CLERK_ON), Anonymous)
    assert isinstance(resolve_bearer_identity("Basic abc", env=CLERK_ON), Anonymous)


def test_resolver_takes_only_the_authorization_header_cookie_blind():
    # Structural guarantee: the signature accepts the header (and env) — there is
    # no place to pass cookies, so a cookie can never authenticate.
    import inspect
    params = set(inspect.signature(resolve_bearer_identity).parameters)
    assert "cookie" not in {p.lower() for p in params}
    assert "cookies" not in {p.lower() for p in params}


# ---- capability token path (unchanged) -------------------------------------
def test_opaque_token_is_capability_bearer():
    ident = resolve_bearer_identity("Bearer abc123opaque", env=CLERK_ON)
    assert isinstance(ident, CapabilityBearer)
    assert ident.token == "abc123opaque"


def test_opaque_token_capability_when_clerk_off():
    ident = resolve_bearer_identity("Bearer abc123opaque", env={})
    assert isinstance(ident, CapabilityBearer)
    assert ident.token == "abc123opaque"


# ---- Clerk JWT path --------------------------------------------------------
def test_valid_jwt_resolves_to_clerk_owner(clerk_keys):
    token = mint(clerk_keys, sub="user_77", org_id="org_9")
    ident = resolve_bearer_identity(f"Bearer {token}", env=CLERK_ON)
    assert isinstance(ident, ClerkOwner)
    assert ident.clerk_user_id == "user_77"
    assert ident.org_id == "org_9"


def test_valid_jwt_treated_as_opaque_when_clerk_disabled(clerk_keys):
    # SHIP DARK: with the kill switch off, a JWT is just an unrecognized bearer —
    # never verified, never a ClerkOwner.
    token = mint(clerk_keys)
    ident = resolve_bearer_identity(f"Bearer {token}", env={})
    assert isinstance(ident, CapabilityBearer)
    assert ident.token == token


def test_invalid_jwt_falls_through_fail_closed(clerk_keys):
    # Well-formed RS256 shape but wrong issuer → verify fails → fall through to the
    # capability path (which won't match any owner) → never a ClerkOwner, never 500.
    token = mint(clerk_keys, iss="https://evil.example.com")
    ident = resolve_bearer_identity(f"Bearer {token}", env=CLERK_ON)
    assert not isinstance(ident, ClerkOwner)
    assert isinstance(ident, (CapabilityBearer, Anonymous))


def test_expired_jwt_is_not_clerk_owner(clerk_keys):
    token = mint(clerk_keys, exp_delta=-3600)
    ident = resolve_bearer_identity(f"Bearer {token}", env=CLERK_ON)
    assert not isinstance(ident, ClerkOwner)


def test_bad_azp_jwt_is_not_clerk_owner(clerk_keys):
    token = mint(clerk_keys, azp="https://attacker.example.com")
    ident = resolve_bearer_identity(f"Bearer {token}", env=CLERK_ON)
    assert not isinstance(ident, ClerkOwner)


# ---- property: never raises, always one of the three -----------------------
@pytest.mark.parametrize(
    "value",
    [
        None, "", "Bearer ", "Bearer x", "Bearer a.b.c", "Bearer ...",
        "Bearer " + "z" * 500, "garbage", "Bearer \x00\x01",
    ],
)
def test_resolver_never_raises_and_returns_one_of_three(value, clerk_keys):
    ident = resolve_bearer_identity(value, env=CLERK_ON)
    assert isinstance(ident, (ClerkOwner, CapabilityBearer, Anonymous))

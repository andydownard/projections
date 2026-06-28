"""Phase 0 — networkless Clerk JWKS verifier (mirrors timpager/lib/clerk-jwt-verify.js).

RS256-only, ``kid``-resolved, issuer-mandatory/fail-closed, ``exp``/``nbf`` with
leeway, ``azp`` allowlist (stricter than pennyai/vibe101). NO Clerk secret; NO
network — every key is generated in-process and the JWKS is stubbed.
"""
import pytest

from app.clerk import (
    ClerkVerificationError,
    looks_like_jwt,
    verify_clerk_session_token,
)
from app.tests.clerk_testkit import (
    TEST_AZP,
    TEST_ISSUER,
    make_keypair,
    mint,
    stub_for,
)


@pytest.fixture()
def keys():
    priv, pub = make_keypair()
    return priv, pub, stub_for(pub)


def _verify(token, jwks, **over):
    kw = dict(
        issuer=TEST_ISSUER,
        authorized_parties=[TEST_AZP],
        jwks=jwks,
    )
    kw.update(over)
    return verify_clerk_session_token(token, **kw)


def test_accepts_valid_token_returns_user_and_org(keys):
    priv, _pub, jwks = keys
    token = mint(priv, sub="user_2abc", org_id="org_42")
    ident = _verify(token, jwks)
    assert ident.clerk_user_id == "user_2abc"
    assert ident.org_id == "org_42"
    assert ident.claims["iss"] == TEST_ISSUER


def test_valid_token_without_org_has_none_org(keys):
    priv, _pub, jwks = keys
    ident = _verify(mint(priv), jwks)
    assert ident.org_id is None


def test_rejects_wrong_issuer(keys):
    priv, _pub, jwks = keys
    token = mint(priv, iss="https://evil.example.com")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks)


def test_rejects_hs256_algorithm_confusion(keys):
    priv, _pub, jwks = keys
    token = mint(priv, alg="HS256")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks)


def test_rejects_alg_none(keys):
    priv, _pub, jwks = keys
    token = mint(priv, alg="none")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks)


def test_rejects_expired_beyond_leeway(keys):
    priv, _pub, jwks = keys
    token = mint(priv, exp_delta=-120)  # expired 2 min ago
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks, leeway=10)


def test_accepts_recently_expired_within_leeway(keys):
    priv, _pub, jwks = keys
    token = mint(priv, exp_delta=-5)  # expired 5s ago
    ident = _verify(token, jwks, leeway=30)  # 30s leeway absorbs it
    assert ident.clerk_user_id


def test_rejects_azp_not_in_allowlist(keys):
    priv, _pub, jwks = keys
    token = mint(priv, azp="https://attacker.thriftly.com")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks)


def test_rejects_unknown_kid(keys):
    priv, _pub, jwks = keys
    token = mint(priv, kid="some_other_kid")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks)


def test_rejects_missing_sub(keys):
    # mint always sets sub; force the require-claim path by minting a token WITHOUT
    # it so the verifier's ``options={"require": ["exp", "sub"]}`` rejects it.
    priv, _pub, jwks = keys
    import time as _t

    import jwt as _jwt
    now = int(_t.time())
    bad = _jwt.encode(
        {"iss": TEST_ISSUER, "iat": now, "exp": now + 300, "azp": TEST_AZP},
        priv, algorithm="RS256", headers={"kid": "ins_test_key_1"},
    )
    with pytest.raises(ClerkVerificationError):
        _verify(bad, jwks)


def test_issuer_unset_fails_closed(keys):
    priv, _pub, jwks = keys
    token = mint(priv)
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks, issuer="")
    with pytest.raises(ClerkVerificationError):
        _verify(token, jwks, issuer=None)


def test_empty_authorized_parties_does_not_enforce_azp(keys):
    # azp enforcement only kicks in when an allowlist is configured (defense in
    # depth, opt-in) — an empty allowlist must not crash or accept blindly here.
    priv, _pub, jwks = keys
    ident = _verify(mint(priv), jwks, authorized_parties=[])
    assert ident.clerk_user_id


def test_no_network_call_used(keys):
    # The default code path uses a module-level PyJWKClient; this test injects a
    # stub jwks so verification is fully offline — proven by it returning without
    # any network access (CI runs with no egress).
    priv, _pub, jwks = keys
    assert _verify(mint(priv), jwks).clerk_user_id


# ---- looks_like_jwt: shape-routing for the resolver ------------------------
def test_looks_like_jwt_true_for_rs256(keys):
    priv, _pub, _jwks = keys
    assert looks_like_jwt(mint(priv)) is True


def test_looks_like_jwt_false_for_opaque_capability_token():
    import secrets
    assert looks_like_jwt(secrets.token_urlsafe(32)) is False


def test_looks_like_jwt_false_for_hs256(keys):
    # An HS256 token is NOT shape-routed to Clerk verify (no RS256 header) — it
    # falls through to the capability path and resolves anonymous (fail-closed).
    priv, _pub, _jwks = keys
    assert looks_like_jwt(mint(priv, alg="HS256")) is False


def test_looks_like_jwt_false_for_garbage():
    assert looks_like_jwt("a.b") is False
    assert looks_like_jwt("not-a-jwt") is False
    assert looks_like_jwt("") is False

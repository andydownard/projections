"""Shared Clerk-JWT test helpers — a LOCAL RSA keypair, signed test JWTs, and a
networkless stub JWKS. NEVER calls Clerk and NEVER touches the network (the keys
are generated in-process). Not a test module (no ``test_`` prefix) so pytest does
not collect it; imported by the Clerk backend tests.
"""
from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

TEST_ISSUER = "https://clerk.rallytasks.com"
TEST_AZP = "https://projections.thriftly.com"
TEST_KID = "ins_test_key_1"


def make_keypair() -> tuple[Any, Any]:
    """A throwaway 2048-bit RSA keypair (private, public)."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return priv, priv.public_key()


def priv_pem(priv: Any) -> bytes:
    return priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def mint(
    priv: Any,
    *,
    sub: str = "user_2abc",
    iss: str | None = TEST_ISSUER,
    azp: str | None = TEST_AZP,
    kid: str = TEST_KID,
    alg: str = "RS256",
    exp_delta: int = 300,
    nbf_delta: int = -10,
    iat_delta: int = -10,
    org_id: str | None = None,
    extra: dict | None = None,
    hs_secret: str = "not-the-rsa-key-but-long-enough-to-avoid-warnings",
) -> str:
    """Mint a signed JWT with the given claims/header. ``alg`` of ``HS256``/``none``
    exercise the algorithm-confusion rejection paths.
    """
    now = int(time.time())
    claims: dict[str, Any] = {"sub": sub, "iat": now + iat_delta}
    if iss is not None:
        claims["iss"] = iss
    if nbf_delta is not None:
        claims["nbf"] = now + nbf_delta
    if exp_delta is not None:
        claims["exp"] = now + exp_delta
    if azp is not None:
        claims["azp"] = azp
    if org_id is not None:
        claims["org_id"] = org_id
    if extra:
        claims.update(extra)
    headers = {"kid": kid}
    if alg == "none":
        # Unsigned token (alg=none) to exercise the verifier's rejection path.
        return jwt.encode(claims, None, algorithm="none", headers=headers)  # type: ignore[arg-type]
    if alg.startswith("HS"):
        return jwt.encode(claims, hs_secret, algorithm=alg, headers=headers)
    return jwt.encode(claims, priv, algorithm=alg, headers=headers)


class StubJWKS:
    """Networkless stand-in for ``PyJWKClient`` — resolves a signing key by ``kid``
    from an in-memory map, raising on an unknown ``kid`` exactly as the real client.
    """

    def __init__(self, keys: dict):
        self._keys = keys  # kid -> public key object

    def get_signing_key_from_jwt(self, token: str) -> Any:
        hdr = jwt.get_unverified_header(token)
        kid = hdr.get("kid")
        if kid not in self._keys:
            raise jwt.PyJWKClientError(f"Unable to find a signing key for kid={kid!r}")
        # Mirror PyJWKClient.get_signing_key_from_jwt: an object exposing ``.key``.
        return SimpleNamespace(key=self._keys[kid])


def stub_for(pub: Any, *, kid: str = TEST_KID) -> StubJWKS:
    return StubJWKS({kid: pub})

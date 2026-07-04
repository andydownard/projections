"""Unit tests for ``app/routers/common.py`` — the single-sourced router plumbing.

These lock the *exact* behavior the per-router copies had before extraction so the
refactor is provably behavior-preserving:

- ``client_ip`` — the right-most, un-spoofable X-Forwarded-For hop (SECURITY §10;
  issue #189). Railway appends the real client IP as the LAST XFF entry, so anything
  a client injects lands to the LEFT and is never selected.
- ``bearer`` — the capability-token extractor (``Authorization: Bearer <tok>``),
  case-sensitive scheme, empty payload coerced to ``None``.
- ``is_owner`` / ``is_editor`` — owner/editor gates that still route through the
  constant-time ``app.deps.token_matches`` (``hmac.compare_digest``) underneath.
- ``utcnow`` — the ISO-8601 ``...Z`` timestamp string every router stamps.
"""
from datetime import datetime, timezone

from app.deps import hash_token
from app.routers import common


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    """Minimal Request stand-in: only ``.headers`` (a dict) and ``.client`` are read."""

    def __init__(self, xff=None, client_host="203.0.113.9"):
        self.headers = {}
        if xff is not None:
            self.headers["x-forwarded-for"] = xff
        self.client = _FakeClient(client_host) if client_host is not None else None


# --------------------------------------------------------------------- client_ip
def test_client_ip_no_header_falls_back_to_socket_peer():
    assert common.client_ip(_FakeRequest(client_host="198.51.100.7")) == "198.51.100.7"


def test_client_ip_no_header_no_client_is_unknown():
    assert common.client_ip(_FakeRequest(client_host=None)) == "unknown"


def test_client_ip_single_hop():
    assert common.client_ip(_FakeRequest(xff="198.51.100.7")) == "198.51.100.7"


def test_client_ip_multi_hop_takes_rightmost():
    req = _FakeRequest(xff="198.51.100.7, 10.0.0.1, 203.0.113.9")
    assert common.client_ip(req) == "203.0.113.9"


def test_client_ip_ignores_spoofed_left_hop():
    # A client injects "1.2.3.4"; Railway's proxy appends the REAL IP to the right.
    req = _FakeRequest(xff="1.2.3.4, 203.0.113.9")
    assert common.client_ip(req) == "203.0.113.9"


def test_client_ip_strips_surrounding_whitespace():
    assert common.client_ip(_FakeRequest(xff="  203.0.113.9  ")) == "203.0.113.9"


# ------------------------------------------------------------------------ bearer
def test_bearer_missing_header_is_none():
    assert common.bearer(None) is None


def test_bearer_ok():
    assert common.bearer("Bearer abc123") == "abc123"


def test_bearer_trailing_whitespace_stripped():
    assert common.bearer("Bearer abc123  ") == "abc123"


def test_bearer_empty_payload_is_none():
    assert common.bearer("Bearer   ") is None


def test_bearer_wrong_scheme_is_none():
    assert common.bearer("Token abc123") is None


def test_bearer_case_sensitive_scheme():
    # The capability-token routers used a case-sensitive "Bearer " prefix.
    assert common.bearer("bearer abc123") is None


def test_bearer_no_scheme_is_none():
    assert common.bearer("abc123") is None


# ----------------------------------------------------------- is_owner / is_editor
def _row(owner="owner-secret", edit=None):
    row = {"owner_token_hash": hash_token(owner)}
    row["edit_token_hash"] = hash_token(edit) if edit is not None else None
    return row


def test_is_owner_matches_via_constant_time_compare():
    assert common.is_owner("owner-secret", _row(owner="owner-secret")) is True


def test_is_owner_wrong_token_rejected():
    assert common.is_owner("nope", _row(owner="owner-secret")) is False


def test_is_owner_none_token_rejected():
    assert common.is_owner(None, _row(owner="owner-secret")) is False


def test_is_editor_matches_when_edit_hash_present():
    assert common.is_editor("edit-secret", _row(edit="edit-secret")) is True


def test_is_editor_no_edit_hash_never_matches():
    # A row with no edit token (NULL hash) must never grant edit, even with a token.
    assert common.is_editor("edit-secret", _row(edit=None)) is False


def test_is_editor_wrong_token_rejected():
    assert common.is_editor("nope", _row(edit="edit-secret")) is False


def test_is_editor_none_token_rejected():
    assert common.is_editor(None, _row(edit="edit-secret")) is False


def test_is_owner_uses_deps_token_matches(monkeypatch):
    # Prove the gate routes through the constant-time comparator, not a raw ==.
    calls = []

    def _spy(presented, stored_hash):
        calls.append((presented, stored_hash))
        return True

    monkeypatch.setattr(common, "token_matches", _spy)
    assert common.is_owner("tok", {"owner_token_hash": "h"}) is True
    assert calls == [("tok", "h")]


# ------------------------------------------------------------------------ utcnow
def test_utcnow_is_iso_z_string():
    s = common.utcnow()
    assert isinstance(s, str)
    assert s.endswith("Z")
    # Parseable back to a tz-aware UTC instant.
    parsed = datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert parsed.tzinfo is timezone.utc

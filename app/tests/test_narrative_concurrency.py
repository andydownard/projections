"""Task 4.1 — narrative writes get REAL optimistic concurrency + LLM rate limits.

Two audited P0s, closed here:

  1. ``PUT …/narrative`` and ``POST …/narrative:regenerate`` PARSED ``If-Match`` but
     then IGNORED the value — two editors loading the same version both "won", so the
     second silently clobbered the first's board-packet prose. Now every narrative
     write compares ``If-Match`` against the projection's live ``version``, returns a
     409 (shape identical to PATCH's ``version_conflict``) on a stale value, BUMPS the
     version on success via the standard optimistic ``UPDATE … WHERE version=?``, and
     snapshots a revision — so a concurrent edit CONFLICTS instead of clobbering.

  2. ``narrative:regenerate`` is a PAID-LLM surface and was uncapped. It is now capped
     per IP + per token (hourly) AND per projection (daily) BEFORE the provider is
     called, so a rejected request never spends a token of LLM budget. The provider is
     asserted NOT called on a 429 or on a stale-``If-Match`` 409 (cost containment is
     the whole point). ``PUT …/narrative`` (a local sanitize+grounding write, no
     provider) gets a coarse per-token/hr cap.

RED-first: written before the endpoints enforced ``If-Match`` or rate-limited.
"""
from __future__ import annotations

import app.narrative_provider as prov
import app.routers.projections as P
from app.tests.conftest import create_projection

REGEN = "narrative:regenerate"


def _auth(token: str, version: int) -> dict:
    return {"Authorization": f"Bearer {token}", "If-Match": str(version)}


def _put_url(slug: str) -> str:
    return f"/api/projections/{slug}/narrative"


def _regen_url(slug: str) -> str:
    return f"/api/projections/{slug}/{REGEN}"


def _stub_provider(monkeypatch):
    """Replace ``narrative_provider.generate`` with a call-counting stub that still
    produces GROUNDED prose (via the router's real deterministic builder), so the
    grounding gate + write path run normally and we can assert the provider is NOT
    invoked on a rejected (429 / stale-409) request."""
    calls = {"n": 0}
    real_gen = P._generate_narrative_md

    def fake_generate(vm, role=None, *, generator=None):
        calls["n"] += 1
        gen = generator or real_gen
        return gen(vm), "anthropic"

    monkeypatch.setattr(prov, "generate", fake_generate)
    return calls


# ============================================================ optimistic concurrency
def test_rate_limit_numbers_match_security_10_1():
    # SECURITY.md §10.1: regenerate = 10/hr/IP + 20/hr/token + 50/day/projection;
    # PUT narrative = coarse 120/hr/token.
    assert P._REGEN_IP_LIMIT == 10
    assert P._REGEN_TOKEN_LIMIT == 20
    assert P._REGEN_PROJECTION_DAILY_LIMIT == 50
    assert P._REGEN_DAY_SECONDS == 86400
    assert P._NARRATIVE_PUT_TOKEN_LIMIT == 120


def test_put_stale_if_match_returns_409(client):
    slug, owner, _version, _ = create_projection(client)
    # First save advances the version 1 -> 2.
    r1 = client.put(_put_url(slug), json={"body_md": "<p>first</p>"},
                    headers=_auth(owner, 1))
    assert r1.status_code == 200, r1.text
    # A save still holding the pre-bump version is a stale write -> 409.
    r2 = client.put(_put_url(slug), json={"body_md": "<p>second</p>"},
                    headers=_auth(owner, 1))
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["error"] == "version_conflict"
    assert detail["current_version"] == 2


def test_put_success_bumps_version_and_snapshots_revision(client_store):
    client, store = client_store
    slug, owner, _version, _ = create_projection(client)
    pid = store.get_projection_by_slug(slug)["id"]

    r = client.put(_put_url(slug), json={"body_md": "<p>board note</p>"},
                   headers=_auth(owner, 1))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert r.headers["ETag"] == "2"

    revs = store.list_revisions(pid)
    assert any(rv["seq"] == 2 and rv["change_summary"] == "narrative_edit"
               for rv in revs), revs


def test_concurrent_second_put_conflicts_and_preserves_first_prose(client):
    slug, owner, _version, _ = create_projection(client)
    # Editor A saves at version 1.
    ra = client.put(_put_url(slug), json={"body_md": "<p>Alice reviewed this.</p>"},
                    headers=_auth(owner, 1))
    assert ra.status_code == 200, ra.text
    assert ra.json()["version"] == 2
    # Editor B also loaded version 1 and saves -> must conflict, never clobber.
    rb = client.put(_put_url(slug), json={"body_md": "<p>Bob rewrote this.</p>"},
                    headers=_auth(owner, 1))
    assert rb.status_code == 409, rb.text
    assert rb.json()["detail"]["error"] == "version_conflict"
    # Alice's prose survived; Bob's clobbering write was rejected.
    g = client.get(_put_url(slug)).json()
    assert "Alice" in g["body_md"]
    assert "Bob" not in g["body_md"]


def test_regenerate_stale_if_match_409_does_not_call_provider(client, monkeypatch):
    calls = _stub_provider(monkeypatch)
    slug, owner, _version, _ = create_projection(client)
    # A settings PATCH advances the version 1 -> 2 (does not touch the narrative provider).
    p = client.patch(f"/api/projections/{slug}",
                     json={"inputs": {"share_y1": "0.07"}},
                     headers=_auth(owner, 1))
    assert p.status_code == 200, p.text
    # Regenerate holding the now-stale version 1 -> 409 with NO provider spend.
    r = client.post(_regen_url(slug), headers=_auth(owner, 1))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "version_conflict"
    assert r.json()["detail"]["current_version"] == 2
    assert calls["n"] == 0, "provider must NOT be called on a stale-If-Match regenerate"


def test_regenerate_success_bumps_version(client, monkeypatch):
    _stub_provider(monkeypatch)
    slug, owner, _version, _ = create_projection(client)
    r = client.post(_regen_url(slug), headers=_auth(owner, 1))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert r.headers["ETag"] == "2"


# ================================================================= LLM rate limits
def test_regenerate_over_ip_cap_returns_429_and_skips_provider(client, monkeypatch):
    calls = _stub_provider(monkeypatch)
    monkeypatch.setattr(P, "_REGEN_IP_LIMIT", 2, raising=False)
    slug, owner, _version, _ = create_projection(client)

    version = 1
    for _ in range(2):
        r = client.post(_regen_url(slug), headers=_auth(owner, version))
        assert r.status_code == 200, r.text
        version = r.json()["version"]

    before = calls["n"]
    r = client.post(_regen_url(slug), headers=_auth(owner, version))
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1
    assert calls["n"] == before, "provider must be skipped on the rate-capped call"


def test_regenerate_over_token_cap_returns_429(client, monkeypatch):
    _stub_provider(monkeypatch)
    monkeypatch.setattr(P, "_REGEN_TOKEN_LIMIT", 2, raising=False)
    slug, owner, _version, _ = create_projection(client)

    version = 1
    for _ in range(2):
        r = client.post(_regen_url(slug), headers=_auth(owner, version))
        assert r.status_code == 200, r.text
        version = r.json()["version"]

    r = client.post(_regen_url(slug), headers=_auth(owner, version))
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"


def test_regenerate_daily_projection_cap_returns_429_and_skips_provider(client, monkeypatch):
    calls = _stub_provider(monkeypatch)
    monkeypatch.setattr(P, "_REGEN_PROJECTION_DAILY_LIMIT", 2, raising=False)
    slug, owner, _version, _ = create_projection(client)

    version = 1
    for _ in range(2):
        r = client.post(_regen_url(slug), headers=_auth(owner, version))
        assert r.status_code == 200, r.text
        version = r.json()["version"]

    before = calls["n"]
    r = client.post(_regen_url(slug), headers=_auth(owner, version))
    assert r.status_code == 429, r.text
    assert r.json()["scope"] == "projection"
    assert int(r.headers["Retry-After"]) >= 1
    assert calls["n"] == before, "provider must be skipped on the per-projection daily cap"


def test_put_over_token_cap_returns_429(client, monkeypatch):
    monkeypatch.setattr(P, "_NARRATIVE_PUT_TOKEN_LIMIT", 2, raising=False)
    slug, owner, _version, _ = create_projection(client)

    version = 1
    for _ in range(2):
        r = client.put(_put_url(slug), json={"body_md": "<p>note</p>"},
                       headers=_auth(owner, version))
        assert r.status_code == 200, r.text
        version = r.json()["version"]

    r = client.put(_put_url(slug), json={"body_md": "<p>note</p>"},
                   headers=_auth(owner, version))
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1


# ===================================================== IMP-3 quad secondary legs
# Whole-branch review: the enforcement below is already shared-code-path-verified
# (PUT and regenerate share the literal `_is_owner(token, row) or _is_editor(token,
# row)` gate; regenerate shares `_mutation`-style per-IP+per-token dual caps with
# PUT). These tests were the missing pins, transcribed from the xown/rlm patterns
# used elsewhere in the suite.

def test_regenerate_requires_owner_or_editor_403(client):
    # IMP-3(1): PUT's view-only->403 gate (narrApi:91) had no regenerate twin, even
    # though the two share the identical auth check verbatim.
    slug, _owner, _version, _ = create_projection(client)
    no_auth = client.post(_regen_url(slug), headers={"If-Match": "1"})
    assert no_auth.status_code == 403, no_auth.text
    assert no_auth.json().get("detail", no_auth.json())["error"] == "forbidden"

    wrong = client.post(
        _regen_url(slug),
        headers={"Authorization": "Bearer not-the-token", "If-Match": "1"},
    )
    assert wrong.status_code == 403, wrong.text


def test_put_and_regenerate_other_owner_forbidden_and_untouched(client_store):
    # IMP-3(2): a valid but DIFFERENT owner's token must not read/write another
    # workspace's narrative surface (TENANT, PRD §20). PUT and regenerate share the
    # SAME owner/editor gate, so one test pins both legs.
    client, store = client_store
    slug, _victim_owner, _v, _b = create_projection(client, name="Victim")
    _a_slug, attacker_owner, _v2, _b2 = create_projection(client, name="Attacker")

    r = client.put(_put_url(slug), json={"body_md": "<p>pwned</p>"},
                   headers=_auth(attacker_owner, 1))
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "forbidden"

    r2 = client.post(_regen_url(slug), headers=_auth(attacker_owner, 1))
    assert r2.status_code == 403, r2.text
    assert r2.json().get("detail", r2.json())["error"] == "forbidden"

    # the victim's narrative surface is completely untouched.
    after = store.get_projection_by_slug(slug)
    assert after["version"] == 1
    g = client.get(_put_url(slug)).json()
    assert g["body_md"] == ""


def test_put_over_ip_cap_returns_429(client, monkeypatch):
    # IMP-3(3): only the TOKEN leg (test_put_over_token_cap_returns_429 above) was
    # pinned; the independently-checked IP leg (wired identically to regenerate's)
    # had no coverage of its own.
    monkeypatch.setattr(P, "_NARRATIVE_PUT_IP_LIMIT", 2, raising=False)
    slug, owner, _version, _ = create_projection(client)

    version = 1
    for _ in range(2):
        r = client.put(_put_url(slug), json={"body_md": "<p>note</p>"},
                       headers=_auth(owner, version))
        assert r.status_code == 200, r.text
        version = r.json()["version"]

    r = client.put(_put_url(slug), json={"body_md": "<p>note</p>"},
                   headers=_auth(owner, version))
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1

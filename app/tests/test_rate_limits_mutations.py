"""Mutation-Safety-Quad leg (d) — rate limits on EVERY mutating endpoint.

CLAUDE.md's Mutation Safety Quad requires a per-IP + per-token abuse cap on every
PATCH/POST/DELETE (SECURITY.md §10.1). Task 3.2 covered create/duplicate/exports and
4.1 the narrative writes; this closes the remaining mutations: the hot autosave
`PATCH` (240/hr) and the owner-only lifecycle mutations — rotate-tokens,
revisions/restore, trash, restore, delete (60/hr each).

Over the cap → `429 {"error":"rate_limited","retry_after_seconds":…}` + `Retry-After`,
emitted BEFORE the merge/recompute/write. The limiter is process-global; the conftest
autouse fixture resets it per test, and each endpoint is driven with a stale If-Match /
bogus id / non-trashed state so the abuse cap is exercised with NO state mutation (the
count is recorded before the eventual 404/409). Test seam: monkeypatch the module
constant to a small N (repo convention) rather than driving hundreds of real requests.
"""
import app.routers.projections as P
from app.tests.conftest import create_projection


# ------------------------------------------------------------ documented caps
def test_mutation_default_caps_documented():
    # PATCH is the hot autosave path (350 ms debounce ⇒ ~170/hr worst-case legit),
    # capped generously at 240/hr; the rarer owner-only lifecycle mutations at 60/hr.
    assert P._PATCH_IP_LIMIT == 240
    assert P._PATCH_TOKEN_LIMIT == 240
    assert P._PATCH_WINDOW_SECONDS == 3600
    assert P._MUTATION_IP_LIMIT == 60
    assert P._MUTATION_TOKEN_LIMIT == 60
    assert P._MUTATION_WINDOW_SECONDS == 3600


def _assert_429(r):
    assert r.status_code == 429, r.text
    assert r.json()["error"] == "rate_limited"
    assert r.json()["retry_after_seconds"] >= 1
    assert int(r.headers["Retry-After"]) >= 1


# --------------------------------------------------------------------- PATCH
def test_patch_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_PATCH_IP_LIMIT", 3, raising=False)

    # Stale If-Match ⇒ each attempt 409s (no state change); the limiter counts BEFORE
    # the write, so the (N+1)th is rejected 429 regardless of the merge outcome.
    def _patch():
        return client.patch(
            f"/api/projections/{slug}",
            json={"assumptions": {"labor_pct": "0.45"}},
            headers={"Authorization": f"Bearer {owner}", "If-Match": "99"},
        )

    for _ in range(3):
        assert _patch().status_code != 429
    _assert_429(_patch())


def test_patch_bypassed_under_e2e_seed_flag(client, monkeypatch):
    # The Playwright autosave path (E2E_SEED=1, non-prod) must never trip the cap.
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_PATCH_IP_LIMIT", 2, raising=False)
    monkeypatch.setenv("E2E_SEED", "1")
    monkeypatch.setenv("APP_ENV", "dev")
    for i in range(6):  # far past the cap
        r = client.patch(
            f"/api/projections/{slug}",
            json={"name": f"n{i}"},
            headers={"Authorization": f"Bearer {owner}", "If-Match": str(i + 1)},
        )
        assert r.status_code == 200, r.text


# -------------------------------------------------------------- rotate-tokens
def test_rotate_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_MUTATION_IP_LIMIT", 3, raising=False)

    # Stale If-Match ⇒ 409 (no rotation), so the slug/owner token survive every call.
    def _rotate():
        return client.post(
            f"/api/projections/{slug}/rotate-tokens",
            headers={"Authorization": f"Bearer {owner}", "If-Match": "99"},
        )

    for _ in range(3):
        assert _rotate().status_code != 429
    _assert_429(_rotate())


# ---------------------------------------------------------- revisions/restore
def test_restore_revision_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_MUTATION_IP_LIMIT", 3, raising=False)

    # A bogus revision id ⇒ 404 (after the cap check), so nothing is restored.
    def _restore():
        return client.post(
            f"/api/projections/{slug}/revisions/nope/restore",
            headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
        )

    for _ in range(3):
        assert _restore().status_code != 429
    _assert_429(_restore())


# ---------------------------------------------------------------------- trash
def test_trash_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_MUTATION_IP_LIMIT", 3, raising=False)

    def _trash():
        return client.post(
            f"/api/projections/{slug}/trash",
            headers={"Authorization": f"Bearer {owner}", "If-Match": "99"},
        )

    for _ in range(3):
        assert _trash().status_code != 429
    _assert_429(_trash())


# -------------------------------------------------------------------- restore
def test_restore_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_MUTATION_IP_LIMIT", 3, raising=False)

    def _restore():
        return client.post(
            f"/api/projections/{slug}/restore",
            headers={"Authorization": f"Bearer {owner}", "If-Match": "99"},
        )

    for _ in range(3):
        assert _restore().status_code != 429
    _assert_429(_restore())


# --------------------------------------------------------------------- delete
def test_delete_over_cap_returns_429(client, monkeypatch):
    slug, owner, _v, _b = create_projection(client)
    monkeypatch.setattr(P, "_MUTATION_IP_LIMIT", 3, raising=False)

    # The projection is active (not trashed) ⇒ 409 not_trashed (after the cap check),
    # so nothing is purged; the cap still trips on the (N+1)th.
    def _delete():
        return client.delete(
            f"/api/projections/{slug}",
            headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
        )

    for _ in range(3):
        assert _delete().status_code != 429
    _assert_429(_delete())

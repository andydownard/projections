"""M4 API — rotate-tokens (API_SPEC §4.7, SECURITY.md §3, DATA_MODEL §6.1).

Owner-only. In one transaction it regenerates + re-hashes owner/edit/view_slug and
all role links, immediately invalidating every previously shared link, writes a
rotation event to the revision/audit log, and returns the new secrets once.

Invariants tested: rotate invalidates the OLD owner/edit tokens and OLD view_slug;
the new tokens work; edit/view cannot rotate (owner_required); If-Match enforced.
RED-first: the endpoint + store.rotate_tokens do not exist yet.
"""

from app.tests.conftest import _create


def test_rotate_invalidates_old_and_mints_new(client):
    created = _create(client)
    slug, owner, edit = (
        created["view_slug"], created["owner_token"], created["edit_token"])

    r = client.post(
        f"/api/projections/{slug}/rotate-tokens",
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    new_slug = body["view_slug"]
    new_owner = body["tokens"]["owner_token"]
    new_edit = body["tokens"]["edit_token"]
    assert new_slug != slug
    assert new_owner != owner
    assert new_edit != edit
    assert body["version"] == 2

    # OLD view_slug is dead (slug rotated)
    assert client.get(f"/api/projections/{slug}").status_code == 404
    # NEW view_slug reads
    assert client.get(f"/api/projections/{new_slug}").status_code == 200

    # OLD owner token cannot mutate the new resource
    stale = client.patch(
        f"/api/projections/{new_slug}",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {owner}", "If-Match": "2"},
    )
    assert stale.status_code == 403
    # OLD edit token also dead
    stale_e = client.patch(
        f"/api/projections/{new_slug}",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {edit}", "If-Match": "2"},
    )
    assert stale_e.status_code == 403

    # NEW owner token works
    ok = client.patch(
        f"/api/projections/{new_slug}",
        json={"name": "Rotated"},
        headers={"Authorization": f"Bearer {new_owner}", "If-Match": "2"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["name"] == "Rotated"


def test_rotate_writes_audit_revision(client, store):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    pid = store.get_projection_by_slug(slug)["id"]
    r = client.post(
        f"/api/projections/{slug}/rotate-tokens",
        headers={"Authorization": f"Bearer {owner}", "If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    revs = store.list_revisions(pid)
    assert any("rotate" in (rv.get("change_summary") or "") for rv in revs)


def test_edit_token_cannot_rotate(client):
    created = _create(client)
    slug, edit = created["view_slug"], created["edit_token"]
    r = client.post(
        f"/api/projections/{slug}/rotate-tokens",
        headers={"Authorization": f"Bearer {edit}", "If-Match": "1"},
    )
    assert r.status_code == 403, r.text
    assert r.json().get("detail", r.json())["error"] == "owner_required"


def test_rotate_requires_if_match(client):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    r = client.post(
        f"/api/projections/{slug}/rotate-tokens",
        headers={"Authorization": f"Bearer {owner}"},
    )
    assert r.status_code == 428, r.text

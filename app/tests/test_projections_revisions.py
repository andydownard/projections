"""M4 API — revisions list + restore (API_SPEC §5, DATA_MODEL §3.2).

Owner-only. The list is metadata + change_summary (snapshots not inlined). Restore
appends the named snapshot's inputs/assumptions/overrides as a NEW forward revision
(history is never rewound) and recomputes, bumping version.

RED-first: the endpoints + store.get_revision do not exist yet.
"""

from app.tests.conftest import _create


def test_revisions_list_owner_only(client):
    created = _create(client)
    slug, owner, edit = (
        created["view_slug"], created["owner_token"], created["edit_token"])
    # make two edits -> two revisions
    client.patch(f"/api/projections/{slug}", json={"assumptions": {"labor_pct": "0.45"}},
                 headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})
    client.patch(f"/api/projections/{slug}", json={"assumptions": {"labor_pct": "0.50"}},
                 headers={"Authorization": f"Bearer {owner}", "If-Match": "2"})

    r = client.get(f"/api/projections/{slug}/revisions",
                   headers={"Authorization": f"Bearer {owner}"})
    assert r.status_code == 200, r.text
    revs = r.json()["revisions"]
    assert len(revs) == 2
    assert {"id", "version", "change_summary", "created_at"} <= set(revs[0])
    # newest first
    assert revs[0]["version"] >= revs[1]["version"]
    # snapshot bodies are NOT inlined (metadata only)
    assert "computed_json" not in revs[0]

    # edit token cannot browse history
    re = client.get(f"/api/projections/{slug}/revisions",
                    headers={"Authorization": f"Bearer {edit}"})
    assert re.status_code == 403
    assert re.json().get("detail", re.json())["error"] == "owner_required"


def test_restore_appends_forward_revision(client, store):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    # v1->v2: set labor 0.45 (revision seq 2 captures THIS state)
    client.patch(f"/api/projections/{slug}", json={"assumptions": {"labor_pct": "0.45"}},
                 headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})
    # v2->v3: set labor 0.50
    client.patch(f"/api/projections/{slug}", json={"assumptions": {"labor_pct": "0.50"}},
                 headers={"Authorization": f"Bearer {owner}", "If-Match": "2"})

    revs = client.get(f"/api/projections/{slug}/revisions",
                      headers={"Authorization": f"Bearer {owner}"}).json()["revisions"]
    # find the seq-2 snapshot (labor 0.45)
    target = [rv for rv in revs if rv["version"] == 2][0]

    r = client.post(
        f"/api/projections/{slug}/revisions/{target['id']}/restore",
        headers={"Authorization": f"Bearer {owner}", "If-Match": "3"},
    )
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["version"] == 4  # forward revision, not a rewind
    assert abs(vm["settings"]["laborPct"] - 0.45) < 1e-9
    # a new revision row was appended (history preserved + new entry)
    pid = store.get_projection_by_slug(slug)["id"]
    assert len(store.list_revisions(pid)) == 3


def test_restore_unknown_revision_404(client):
    created = _create(client)
    slug, owner = created["view_slug"], created["owner_token"]
    client.patch(f"/api/projections/{slug}", json={"assumptions": {"labor_pct": "0.45"}},
                 headers={"Authorization": f"Bearer {owner}", "If-Match": "1"})
    r = client.post(
        f"/api/projections/{slug}/revisions/nope/restore",
        headers={"Authorization": f"Bearer {owner}", "If-Match": "2"},
    )
    assert r.status_code == 404, r.text

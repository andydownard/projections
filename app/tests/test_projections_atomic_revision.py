"""#186 — router mutations bump version + write their revision in ONE transaction.

The store exposes ``update_with_version_check_and_revision`` (version-checked UPDATE
+ revision INSERT in a single committed transaction, with a UNIQUE(projection_id,
seq) backstop). These tests assert the *router* call sites actually use it, so the
version bump and its snapshot can never split:

- the happy path moves version AND revision together (seq == new version);
- a stale If-Match (409) writes NEITHER;
- if the revision INSERT fails (a duplicate (projection_id, seq) trips the backstop),
  the whole mutation rolls back — the version does NOT advance and no orphan lands.

The last assertion is the RED/GREEN discriminator: with the OLD two-call path the
version-checked UPDATE commits on its own *before* the separate ``insert_revision``,
so a failed INSERT leaves the version bumped with no snapshot (an unrecoverable hole
in the restore/audit trail). With the single-transaction method it rolls back.

Covers both remaining mutation sites (PATCH / restore) — rotate-tokens was deleted
along with the rest of the capability-token model. The PATCH path is the one Penny
converges on via ``apply_projection_patch`` (actor:penny), so the Penny write path
inherits the same atomicity.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore
from engine.model import MODEL_VERSION


@pytest.fixture()
def store():
    s = SqliteStore(":memory:")
    s.migrate()
    return s


@pytest.fixture()
def client(store):
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    # raise_server_exceptions=False so an unhandled IntegrityError surfaces as a 500
    # response and we can assert the DB rolled back, rather than re-raising into the test.
    return TestClient(app, raise_server_exceptions=False)


VALID_BODY = {
    "name": "House of Hope",
    "inputs": {
        "org_name": "House of Hope", "city": "Longview, Texas",
        "opening_status": "pre_launch",
        "share_y1": "0.06", "share_y2": "0.08", "share_y3": "0.10",
        "donation_value": "74", "building_sqft": "10000", "salesfloor_pct": "0.70",
        "source_of_funds": "300000", "occupancy_annual": "120000",
        "lease_type": "nnn", "nnn_opex_annual": "0",
    },
    "trade_area": {"basis": "city", "households": "31798"},
    "assumptions": {"labor_pct": "0.60"},
}


def _create(client):
    r = client.post("/api/projections", json=VALID_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def _pid(store, slug):
    return store.get_projection_by_slug(slug)["id"]


def _seed_revision(store, pid, seq):
    """Pre-insert a revision at ``seq`` so the next mutation's INSERT at the same
    (projection_id, seq) trips the UNIQUE backstop — simulating a partial-write
    failure the single transaction must roll back atomically."""
    store.insert_revision({
        "id": f"seed_{pid}_{seq}",
        "projection_id": pid,
        "seq": seq,
        "inputs_json": "{}",
        "assumptions_json": "{}",
        "overrides_json": "{}",
        "monthly_json": "{}",
        "computed_json": "{}",
        "model_version": MODEL_VERSION,
        "created_at": "2026-01-01T00:00:00Z",
    })


# ---------------------------------------------------------------- PATCH path

def test_patch_version_and_revision_move_together(client, store):
    """Happy path: a successful settle advances version AND writes exactly one
    revision whose seq equals the new version (they are one transaction)."""
    created = _create(client)
    slug = created["view_slug"]
    pid = _pid(store, slug)

    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    revs = store.list_revisions(pid)
    assert len(revs) == 1
    assert revs[0]["seq"] == 2  # revision seq tracks the new version exactly


def test_patch_conflict_writes_neither_version_nor_revision(client, store):
    """409 (stale If-Match): the version stays put and NO revision is written."""
    created = _create(client)
    slug = created["view_slug"]
    pid = _pid(store, slug)

    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "99"},
    )
    assert r.status_code == 409, r.text
    assert store.get_projection_by_slug(slug)["version"] == 1
    assert store.list_revisions(pid) == []


def test_patch_revision_insert_failure_rolls_back_version(client, store):
    """RED on the old two-call path: if the revision INSERT fails, the version bump
    must roll back with it (no version without a snapshot)."""
    created = _create(client)
    slug = created["view_slug"]
    pid = _pid(store, slug)
    # Force the next revision INSERT (seq == new version == 2) to collide.
    _seed_revision(store, pid, 2)

    r = client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "1"},
    )
    assert r.status_code == 500, r.text  # the duplicate-seq backstop fired
    # Atomic: the version did NOT advance and no extra revision landed.
    assert store.get_projection_by_slug(slug)["version"] == 1
    assert len(store.list_revisions(pid)) == 1  # only the seeded one


# -------------------------------------------------------------- restore path

def test_restore_revision_insert_failure_rolls_back_version(client, store):
    """Restore writes a NEW forward revision; that INSERT and the version bump are
    one transaction. A failed INSERT must not leave the version advanced."""
    created = _create(client)
    slug = created["view_slug"]
    pid = _pid(store, slug)
    # v1 -> v2 (real revision at seq 2 we can restore from)
    client.patch(
        f"/api/projections/{slug}",
        json={"assumptions": {"labor_pct": "0.45"}},
        headers={"If-Match": "1"},
    )
    target = [rv for rv in store.list_revisions(pid) if rv["seq"] == 2][0]
    # Force the restore's revision INSERT (seq == new version == 3) to collide.
    _seed_revision(store, pid, 3)

    r = client.post(
        f"/api/projections/{slug}/revisions/{target['id']}/restore",
        headers={"If-Match": "2"},
    )
    assert r.status_code == 500, r.text
    assert store.get_projection_by_slug(slug)["version"] == 2  # not advanced to 3
    assert {rv["seq"] for rv in store.list_revisions(pid)} == {2, 3}  # no new row

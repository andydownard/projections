"""Phase 3 — additive Clerk-owner columns + owner-scoped Clerk lists.

A projection can be token-owned OR clerk-owned (or both, after a claim — a
follow-up). The migration adds nullable ``owner_clerk_user_id`` / ``owner_org_id``
(additive-only, no DROP/RENAME) and ``list_*_by_clerk_owner`` scope strictly on the
Clerk identity — NEVER global, no cross-owner read (Override TENANT / PRD §20).
"""
from app.store.migration_safety import scan_sql
from app.store.migrations import MIGRATIONS
from app.store.sqlite import SqliteStore


def _store() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _row(pid, slug, *, owner_hash="tok", clerk=None, org=None, name="P"):
    r = {
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": owner_hash,
        "name": name,
        "model_version": "1.0.0",
        "compute_schema_version": "1.0.0",
        "computed_json": "{}",
        "created_at": "2026-06-27T00:00:00Z",
        "updated_at": "2026-06-27T00:00:00Z",
    }
    if clerk is not None:
        r["owner_clerk_user_id"] = clerk
    if org is not None:
        r["owner_org_id"] = org
    return r


# ---- migration: additive + columns present ---------------------------------
def test_clerk_owner_migration_is_registered_and_additive():
    names = [n for n, _ in MIGRATIONS]
    assert "0010_clerk_owner" in names
    sql = dict(MIGRATIONS)["0010_clerk_owner"]
    assert scan_sql(sql) == []  # no DROP/RENAME/destructive ALTER


def test_columns_exist_after_migration():
    s = _store()
    cols = {r[1] for r in s._read_conn().execute("PRAGMA table_info(projections)")}
    assert "owner_clerk_user_id" in cols
    assert "owner_org_id" in cols


# ---- create persists the clerk owner ---------------------------------------
def test_create_persists_clerk_owner_columns():
    s = _store()
    s.create_projection(_row("p1", "slug1", clerk="user_a", org="org_x"))
    got = s.get_projection_by_slug("slug1")
    assert got["owner_clerk_user_id"] == "user_a"
    assert got["owner_org_id"] == "org_x"


def test_token_owned_row_has_null_clerk_owner():
    s = _store()
    s.create_projection(_row("p1", "slug1"))  # no clerk owner
    got = s.get_projection_by_slug("slug1")
    assert got.get("owner_clerk_user_id") is None


# ---- owner-scoped Clerk lists ----------------------------------------------
def test_list_by_clerk_owner_returns_only_that_owner():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="user_a", name="A1"))
    s.create_projection(_row("p2", "s2", clerk="user_a", name="A2"))
    s.create_projection(_row("p3", "s3", clerk="user_b", name="B1"))
    s.create_projection(_row("p4", "s4"))  # token-owned only
    rows = s.list_by_clerk_owner("user_a")
    assert {r["view_slug"] for r in rows} == {"s1", "s2"}


def test_list_by_clerk_owner_never_global_for_token_owned_rows():
    s = _store()
    s.create_projection(_row("p4", "s4"))  # token-owned, no clerk owner
    assert s.list_by_clerk_owner("user_a") == []
    # An empty/None clerk id must never match the NULL token-owned rows.
    assert s.list_by_clerk_owner("") == []


def test_list_card_summaries_by_clerk_owner_scoped():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="user_a", name="A1"))
    s.create_projection(_row("p2", "s2", clerk="user_b", name="B1"))
    rows = s.list_card_summaries_by_clerk_owner("user_a")
    assert {r["view_slug"] for r in rows} == {"s1"}
    assert "summary_json" in rows[0]


def test_clerk_owner_list_excludes_trashed_by_default():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="user_a"))
    s.set_status("p1", "trashed", 1)
    assert s.list_by_clerk_owner("user_a") == []
    assert {r["view_slug"] for r in s.list_by_clerk_owner("user_a", include_trashed=True)} == {"s1"}


# ---- claim/bridge: token-owned rows backfill onto a Clerk identity --------------
def test_claim_links_only_matching_token_and_returns_count():
    s = _store()
    s.create_projection(_row("p1", "s1", owner_hash="hashA"))  # token A, unclaimed
    s.create_projection(_row("p2", "s2", owner_hash="hashA"))  # token A, unclaimed
    s.create_projection(_row("p3", "s3", owner_hash="hashB"))  # a DIFFERENT token
    linked = s.claim_projections_to_clerk_owner("hashA", "user_a", None)
    assert linked == 2
    assert {r["view_slug"] for r in s.list_by_clerk_owner("user_a")} == {"s1", "s2"}
    # The other token's row is untouched (never a cross-owner backfill).
    assert s.get_projection_by_slug("s3")["owner_clerk_user_id"] is None


def test_claim_is_idempotent_and_anti_takeover():
    s = _store()
    s.create_projection(_row("p1", "s1", owner_hash="hashA"))
    assert s.claim_projections_to_clerk_owner("hashA", "user_a", None) == 1
    # Re-claim by the same owner links 0 more (already stamped).
    assert s.claim_projections_to_clerk_owner("hashA", "user_a", None) == 0
    # A different Clerk user with the same token hash cannot steal a claimed row.
    assert s.claim_projections_to_clerk_owner("hashA", "user_b", None) == 0
    assert s.get_projection_by_slug("s1")["owner_clerk_user_id"] == "user_a"


def test_claim_stamps_org_id_when_present():
    s = _store()
    s.create_projection(_row("p1", "s1", owner_hash="hashA"))
    assert s.claim_projections_to_clerk_owner("hashA", "user_a", "org_x") == 1
    got = s.get_projection_by_slug("s1")
    assert got["owner_clerk_user_id"] == "user_a"
    assert got["owner_org_id"] == "org_x"


def test_claim_noops_on_empty_identity():
    s = _store()
    s.create_projection(_row("p1", "s1", owner_hash="hashA"))
    # Empty/None guards: never backfill the NULL token-owned rows with an empty id.
    assert s.claim_projections_to_clerk_owner("hashA", "", None) == 0
    assert s.claim_projections_to_clerk_owner("", "user_a", None) == 0
    assert s.get_projection_by_slug("s1")["owner_clerk_user_id"] is None

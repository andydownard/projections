"""Store layer — share_grants: editable shares that follow a Clerk account (#323).

The grant is keyed on the recipient's Clerk ``sub`` (Override TENANT / PRD §20):
``list_shared_card_summaries_by_clerk_owner`` scopes STRICTLY on the grantee's
grants — never global, never another grantee's. ``create_share_grant`` is idempotent
(the UNIQUE(projection_id, grantee_clerk_user_id) backstop), and ``has_share_grant``
is the constant-cost membership check the PATCH-grant auth path consults.
"""
from app.store.sqlite import SqliteStore


def _store() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _row(pid, slug, *, owner_hash="tok", clerk=None, name="P", status="active"):
    r = {
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": owner_hash,
        "name": name,
        "status": status,
        "model_version": "2.7.0",
        "compute_schema_version": "1.5.0",
        "computed_json": "{}",
        "created_at": "2026-06-29T00:00:00Z",
        "updated_at": "2026-06-29T00:00:00Z",
    }
    if clerk is not None:
        r["owner_clerk_user_id"] = clerk
    return r


# ---- create_share_grant: idempotent, scoped, empty-safe ------------------------
def test_create_share_grant_is_idempotent():
    s = _store()
    s.create_projection(_row("p1", "s1"))
    assert s.create_share_grant("p1", "user_a") is True
    # The UNIQUE(projection_id, grantee) backstop makes a re-grant a no-op.
    assert s.create_share_grant("p1", "user_a") is False
    rows = s._read_conn().execute(
        "SELECT COUNT(*) FROM share_grants WHERE projection_id='p1'"
    ).fetchone()[0]
    assert rows == 1


def test_create_share_grant_noops_on_empty_grantee():
    s = _store()
    s.create_projection(_row("p1", "s1"))
    # An empty/None grantee must never create a grant (no NULL-grantee leak).
    assert s.create_share_grant("p1", "") is False
    assert s.create_share_grant("", "user_a") is False
    assert s._read_conn().execute("SELECT COUNT(*) FROM share_grants").fetchone()[0] == 0


def test_create_share_grant_defaults_role_editor():
    s = _store()
    s.create_projection(_row("p1", "s1"))
    s.create_share_grant("p1", "user_a")
    role = s._read_conn().execute(
        "SELECT role FROM share_grants WHERE projection_id='p1'"
    ).fetchone()[0]
    assert role == "editor"


# ---- has_share_grant -----------------------------------------------------------
def test_has_share_grant():
    s = _store()
    s.create_projection(_row("p1", "s1"))
    assert s.has_share_grant("p1", "user_a") is False
    s.create_share_grant("p1", "user_a")
    assert s.has_share_grant("p1", "user_a") is True
    # Never matches a different grantee or a different projection (TENANT).
    assert s.has_share_grant("p1", "user_b") is False
    assert s.has_share_grant("p2", "user_a") is False
    # Empty grantee never matches.
    assert s.has_share_grant("p1", "") is False


# ---- list_shared_card_summaries_by_clerk_owner: grant-scoped, never global -----
def test_list_shared_returns_only_my_grants():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="owner_x", name="X1"))
    s.create_projection(_row("p2", "s2", clerk="owner_x", name="X2"))
    s.create_projection(_row("p3", "s3", clerk="owner_x", name="X3"))
    s.create_share_grant("p1", "user_a")
    s.create_share_grant("p2", "user_a")
    s.create_share_grant("p3", "user_b")  # a DIFFERENT grantee
    rows = s.list_shared_card_summaries_by_clerk_owner("user_a")
    assert {r["view_slug"] for r in rows} == {"s1", "s2"}
    assert "summary_json" in rows[0]


def test_list_shared_never_global_for_empty_grantee():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="owner_x"))
    s.create_share_grant("p1", "user_a")
    # An empty grantee id must never match any grant (no global list).
    assert s.list_shared_card_summaries_by_clerk_owner("") == []
    assert s.list_shared_card_summaries_by_clerk_owner("user_z") == []


def test_list_shared_excludes_trashed_and_deleted():
    s = _store()
    s.create_projection(_row("p1", "s1", clerk="owner_x"))
    s.create_projection(_row("p2", "s2", clerk="owner_x"))
    s.create_share_grant("p1", "user_a")
    s.create_share_grant("p2", "user_a")
    s.set_status("p1", "trashed", 1)  # owner trashed it
    s.soft_delete("p2", 1)  # owner purged/deleted it
    assert s.list_shared_card_summaries_by_clerk_owner("user_a") == []


def test_list_shared_excludes_rows_the_grantee_already_owns():
    s = _store()
    # user_a is BOTH the Clerk owner and (degenerately) a grantee of p1; the shared
    # list must not double-list their own row (it belongs to the owner list).
    s.create_projection(_row("p1", "s1", clerk="user_a"))
    s.create_share_grant("p1", "user_a")
    assert s.list_shared_card_summaries_by_clerk_owner("user_a") == []

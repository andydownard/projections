"""m0012 — one-shot Longview recovery (B4 / issue #295).

Pins the recovery migration: it re-links EXACTLY the one orphaned row (matched by
its unique ``view_slug``) to the owner's Clerk identity, is idempotent + anti-clobber
(the ``owner_clerk_user_id IS NULL`` guard), never touches a bystander row, and is
NOT a destructive statement (an UPDATE — migration_safety must pass it).
"""
from app.store.migration_safety import scan_sql
from app.store.migrations import MIGRATIONS
from app.store.sqlite import SqliteStore

_SQL = dict(MIGRATIONS)["0012_recover_longview"]
_SLUG = "aFk_Lm-RhA9hGc2q7-b8mg"
_CLERK = "user_3DvN53qoUbgMRuDBjKmWT44m3Cf"


def _store() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _row(pid, slug, *, clerk=None):
    r = {
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": "tok-" + pid,
        "name": "House of Hope",
        "model_version": "2.4.0",
        "compute_schema_version": "1.2.0",
        "computed_json": "{}",
        "created_at": "2026-06-28T14:28:59Z",
        "updated_at": "2026-06-28T14:28:59Z",
    }
    if clerk is not None:
        r["owner_clerk_user_id"] = clerk
    return r


def _clerk_of(s, slug):
    row = s._read_conn().execute(
        "SELECT owner_clerk_user_id FROM projections WHERE view_slug = ?", (slug,)
    ).fetchone()
    return row[0] if row else None


def test_migration_is_registered_and_not_destructive():
    assert "0012_recover_longview" in [n for n, _ in MIGRATIONS]
    # An UPDATE is additive/safe — no DROP / DELETE / RENAME / destructive ALTER.
    assert scan_sql(_SQL) == []


def test_relinks_exactly_the_longview_row_and_no_bystander():
    s = _store()
    s.create_projection(_row("p_long", _SLUG, clerk=None))            # the orphan
    s.create_projection(_row("p_other", "some-other-slug", clerk=None))  # bystander
    s._conn.executescript(_SQL)
    s._conn.commit()
    assert _clerk_of(s, _SLUG) == _CLERK                  # recovered
    assert _clerk_of(s, "some-other-slug") is None         # untouched


def test_is_idempotent_and_anti_clobber():
    s = _store()
    # A row already owned by a DIFFERENT clerk id must NEVER be overwritten.
    s.create_projection(_row("p_owned", _SLUG, clerk="user_SOMEONE_ELSE"))
    s._conn.executescript(_SQL)
    s._conn.commit()
    assert _clerk_of(s, _SLUG) == "user_SOMEONE_ELSE"
    # Re-running links 0 more (idempotent).
    s._conn.executescript(_SQL)
    s._conn.commit()
    assert _clerk_of(s, _SLUG) == "user_SOMEONE_ELSE"

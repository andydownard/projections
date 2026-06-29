"""m0013 — corrective rebind of the Longview projection to the correct Clerk sub
(B4 / issue #323).

Pins the fix: migration m0012 stamped the Longview row with the WRONG Clerk sub
('user_3DvN53qoUbgMRuDBjKmWT44m3Cf'). Andy's real sub is
'user_3DiaveyeKg7vzXhxVlSCFIDew5V' (owner-confirmed). m0013 corrects exactly that
one row and is:
  (a) targeted  — the Longview row is rebound to the correct sub;
  (b) isolated  — a bystander row at a different sub is untouched;
  (c) idempotent — re-running after the sub is already correct is a no-op;
  (d) anti-clobber — a row already at the correct sub is never touched again;
  (e) slug-scoped — a row at the wrong sub but a different slug is untouched.
Also verifies the migration is registered in MIGRATIONS and passes the additive-only
safety scan (an UPDATE is not destructive).
"""
from __future__ import annotations

from app.store.migration_safety import scan_sql
from app.store.migrations import MIGRATIONS
from app.store.sqlite import SqliteStore

_SQL = dict(MIGRATIONS)["0013_rebind_longview_clerk_sub"]
_SLUG = "aFk_Lm-RhA9hGc2q7-b8mg"
_WRONG_SUB = "user_3DvN53qoUbgMRuDBjKmWT44m3Cf"
_CORRECT_SUB = "user_3DiaveyeKg7vzXhxVlSCFIDew5V"


def _store() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.migrate()
    return s


def _row(pid: str, slug: str, *, clerk: str | None = None) -> dict:
    r = {
        "id": pid,
        "view_slug": slug,
        "owner_token_hash": "tok-" + pid,
        "name": "House of Hope",
        "model_version": "2.6.0",
        "compute_schema_version": "1.5.0",
        "computed_json": "{}",
        "created_at": "2026-06-29T00:00:00Z",
        "updated_at": "2026-06-29T00:00:00Z",
    }
    if clerk is not None:
        r["owner_clerk_user_id"] = clerk
    return r


def _clerk_of(s: SqliteStore, slug: str) -> str | None:
    row = s._read_conn().execute(
        "SELECT owner_clerk_user_id FROM projections WHERE view_slug = ?", (slug,)
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Safety / registration
# ---------------------------------------------------------------------------


def test_migration_is_registered_and_not_destructive():
    """m0013 appears in the MIGRATIONS list and passes the additive-only scan."""
    assert "0013_rebind_longview_clerk_sub" in [n for n, _ in MIGRATIONS]
    # UPDATE is permitted; DROP/DELETE/TRUNCATE/RENAME are not.
    assert scan_sql(_SQL) == []


def test_migration_ordering():
    """m0013 is the last entry and follows m0012 immediately."""
    names = [n for n, _ in MIGRATIONS]
    assert names[-1] == "0013_rebind_longview_clerk_sub"
    assert names[-2] == "0012_recover_longview"


# ---------------------------------------------------------------------------
# (a) + (b) targeted fix — relinks the Longview row; bystander untouched
# ---------------------------------------------------------------------------


def test_relinks_longview_row_and_leaves_bystander_alone():
    """(a) wrong-sub Longview row is corrected; (b) bystander at a different sub is not."""
    s = _store()
    s.create_projection(_row("p_long", _SLUG, clerk=_WRONG_SUB))
    s.create_projection(_row("p_other", "some-other-slug", clerk=_WRONG_SUB))

    s._conn.executescript(_SQL)
    s._conn.commit()

    assert _clerk_of(s, _SLUG) == _CORRECT_SUB          # (a) corrected
    assert _clerk_of(s, "some-other-slug") == _WRONG_SUB  # (b) untouched (different slug)


# ---------------------------------------------------------------------------
# (c) idempotent — re-running after correction is a safe no-op
# ---------------------------------------------------------------------------


def test_is_idempotent_after_correction():
    """(c) Re-running m0013 when the sub is already correct leaves it unchanged."""
    s = _store()
    s.create_projection(_row("p_long", _SLUG, clerk=_WRONG_SUB))

    # First run: corrects the sub.
    s._conn.executescript(_SQL)
    s._conn.commit()
    assert _clerk_of(s, _SLUG) == _CORRECT_SUB

    # Second run: the AND guard on _WRONG_SUB fails → 0 rows matched → no-op.
    s._conn.executescript(_SQL)
    s._conn.commit()
    assert _clerk_of(s, _SLUG) == _CORRECT_SUB


# ---------------------------------------------------------------------------
# (d) anti-clobber — row already at the correct sub is never overwritten
# ---------------------------------------------------------------------------


def test_does_not_touch_row_already_at_correct_sub():
    """(d) A row already carrying the correct sub must never be re-written."""
    s = _store()
    s.create_projection(_row("p_long", _SLUG, clerk=_CORRECT_SUB))

    s._conn.executescript(_SQL)
    s._conn.commit()

    # The AND predicate on _WRONG_SUB never matches → sub remains _CORRECT_SUB.
    assert _clerk_of(s, _SLUG) == _CORRECT_SUB


# ---------------------------------------------------------------------------
# (e) slug-scoped — a row at the wrong sub but a DIFFERENT slug is untouched
# ---------------------------------------------------------------------------


def test_different_slug_with_wrong_sub_is_untouched():
    """(e) The wrong sub on an unrelated slug must not be corrected."""
    s = _store()
    other_slug = "totally-different-slug"
    s.create_projection(_row("p_unrelated", other_slug, clerk=_WRONG_SUB))

    s._conn.executescript(_SQL)
    s._conn.commit()

    # Only the exact _SLUG is in scope; the other slug keeps its (wrong) sub.
    assert _clerk_of(s, other_slug) == _WRONG_SUB

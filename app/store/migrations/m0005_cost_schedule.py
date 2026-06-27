"""m0005 — timed cost schedule + opening anchor (Spec §5/§7; epic:wizard W1).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): adds three columns to
``projections`` carrying the timed-cost-schedule data model and the opening anchor.
NEVER DROP/RENAME — ``ALTER TABLE ADD COLUMN`` only.

- ``target_opening_date``  — ISO month/date string for the grand-opening milestone.
- ``opening_month_number`` — the project month (>=1) grand opening lands on.
- ``cost_schedule_json``   — [{category, month, amount}] timed startup line items.

The fixed ``STARTUP`` lump is superseded by ``cost_schedule``. Legacy rows (and the
seeded example) created before this migration backfill to the **month-1 lump
default** via the column DEFAULTs: every ``STARTUP`` line at month 1 with
``opening_month_number = 1`` — a single lump at opening that reproduces today's
numbers exactly (the same result a user gets entering costs in month 1 + opening
month 1, NOT a special engine mode).

**Frozen defaults (issue #187).** A migration is an immutable historical artifact:
the SQL an already-applied 0005 ran must NOT change. So the column DEFAULTs are
hand-written **frozen literals**, NOT ``json.dumps(default_cost_schedule())``
evaluated at import time. The old approach (a) tracked whatever the engine returned
at deploy time, so two DBs first-migrated under different engine versions backfilled
DIFFERENT legacy data while ``schema_migrations`` recorded "0005 applied"
identically (silent drift), and (b) embedded engine output into a single-quoted SQL
literal with no apostrophe escaping (a future "Owner's draw" category would break the
shipped migration). The frozen literal below equals today's
``json.dumps(default_cost_schedule())`` byte-for-byte; a forward-guard test
(``test_cost_schedule_migration``) asserts ``default_cost_schedule()`` STILL parses
to it, so an intentional engine-default change fails RED and forces a NEW migration
instead of silently rewriting this one. ``_sql_str_literal`` doubles any apostrophe
so the embedding is genuinely injection-safe.
"""

# Frozen, immutable shipped default for ``cost_schedule_json`` (issue #187). Equal to
# ``json.dumps(default_cost_schedule())`` at the time 0005 shipped. DO NOT edit to
# track an engine change — add a new migration instead (the forward-guard test makes
# a drift fail loudly).
FROZEN_DEFAULT_COST_SCHEDULE_JSON = (
    '[{"category": "Thrift Store Consultant", "month": 1, "amount": 100000}, '
    '{"category": "Equipment & Fixtures", "month": 1, "amount": 45000}, '
    '{"category": "Build-out / Renovations / Tenant Improvements", "month": 1, '
    '"amount": 50000}, '
    '{"category": "Legal, Permits, Insurance Setup, Signage", "month": 1, '
    '"amount": 13500}]'
)

# Frozen opening anchor (the project month grand opening lands on; month 1 = no
# pre-opening months, reproducing today's numbers).
FROZEN_OPENING_MONTH_NUMBER = 1


def _sql_str_literal(value: str) -> str:
    """Render ``value`` as a SQL single-quoted string literal, apostrophes doubled.

    The injection-safety the old ``json.dumps``-into-DDL comment merely *claimed*:
    JSON does not escape ``'``, so a category with an apostrophe would terminate the
    literal early. Doubling every ``'`` makes the embedding safe for any future value.
    """
    return "'" + value.replace("'", "''") + "'"


SQL = f"""
ALTER TABLE projections ADD COLUMN target_opening_date TEXT;
ALTER TABLE projections ADD COLUMN opening_month_number INTEGER NOT NULL DEFAULT {FROZEN_OPENING_MONTH_NUMBER};
ALTER TABLE projections ADD COLUMN cost_schedule_json TEXT NOT NULL DEFAULT {_sql_str_literal(FROZEN_DEFAULT_COST_SCHEDULE_JSON)};
"""

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
month 1, NOT a special engine mode). The default schedule JSON is derived from
``engine.model.default_cost_schedule`` so the migration backfill and the engine
default can never drift.
"""
import json

from engine.model import DEFAULT_OPENING_MONTH_NUMBER, default_cost_schedule

# json.dumps emits only double-quoted strings, so embedding the result inside a
# single-quoted SQL string literal is injection-safe and additive-scan-safe.
_DEFAULT_SCHEDULE_JSON = json.dumps(default_cost_schedule())

SQL = f"""
ALTER TABLE projections ADD COLUMN target_opening_date TEXT;
ALTER TABLE projections ADD COLUMN opening_month_number INTEGER NOT NULL DEFAULT {DEFAULT_OPENING_MONTH_NUMBER};
ALTER TABLE projections ADD COLUMN cost_schedule_json TEXT NOT NULL DEFAULT '{_DEFAULT_SCHEDULE_JSON}';
"""

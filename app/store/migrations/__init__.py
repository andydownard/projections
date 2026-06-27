"""Versioned, additive-only migrations (DATA_MODEL.md §8).

NEVER DROP TABLE / DROP COLUMN. CREATE TABLE IF NOT EXISTS always; ALTER TABLE ADD
COLUMN wrapped to tolerate "duplicate column" (idempotent). Migrations run BEFORE
the app serves (SECURITY.md §11.3) and are recorded in schema_migrations.
"""
from app.store.migrations import (
    m0001_init,
    m0002_narrative_snapshot,
    m0003_intent,
    m0004_narrative_edit_origin,
    m0005_cost_schedule,
)

# Ordered list of (name, ddl) migrations. Append-only.
MIGRATIONS = [
    ("0001_init", m0001_init.SQL),
    ("0002_narrative_snapshot", m0002_narrative_snapshot.SQL),
    ("0003_intent", m0003_intent.SQL),
    ("0004_narrative_edit_origin", m0004_narrative_edit_origin.SQL),
    ("0005_cost_schedule", m0005_cost_schedule.SQL),
]

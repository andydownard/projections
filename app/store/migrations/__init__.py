"""Versioned, additive-only migrations (DATA_MODEL.md §8).

NEVER DROP TABLE / DROP COLUMN. CREATE TABLE IF NOT EXISTS always; ALTER TABLE ADD
COLUMN wrapped to tolerate "duplicate column" (idempotent). Migrations run BEFORE
the app serves (SECURITY.md §11.3) and are recorded in schema_migrations.
"""
from app.store.migrations import m0001_init

# Ordered list of (name, ddl) migrations. Append-only.
MIGRATIONS = [
    ("0001_init", m0001_init.SQL),
]

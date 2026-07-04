"""Versioned, additive-only migrations (DATA_MODEL.md §8).

NEVER DROP TABLE / DROP COLUMN. ``CREATE TABLE/INDEX IF NOT EXISTS`` always. Each
migration is applied atomically (DDL + ledger INSERT in ONE transaction) and
idempotently (a re-run after a crash swallows "duplicate column name" on a bare
``ALTER ADD COLUMN``) by the runner in ``SqliteStore._apply_migration`` (#185) — so
an interrupted apply recovers on the next boot instead of boot-crash-looping the
single durable volume. Migrations run BEFORE the app serves (SECURITY.md §11.3) and
are recorded in ``schema_migrations``.
"""
from app.store.migrations import (
    m0001_init,
    m0002_narrative_snapshot,
    m0003_intent,
    m0004_narrative_edit_origin,
    m0005_cost_schedule,
    m0006_penny_transcripts,
    m0007_revision_seq_unique,
    m0008_card_summary,
    m0009_role_links,
    m0010_clerk_owner,
    m0011_feedback_creator,
    m0012_recover_longview,
    m0013_rebind_longview_clerk_sub,
    m0014_share_grants,
)

# Ordered list of (name, ddl) migrations. Append-only.
MIGRATIONS = [
    ("0001_init", m0001_init.SQL),
    ("0002_narrative_snapshot", m0002_narrative_snapshot.SQL),
    ("0003_intent", m0003_intent.SQL),
    ("0004_narrative_edit_origin", m0004_narrative_edit_origin.SQL),
    ("0005_cost_schedule", m0005_cost_schedule.SQL),
    ("0006_penny_transcripts", m0006_penny_transcripts.SQL),
    ("0007_revision_seq_unique", m0007_revision_seq_unique.SQL),
    ("0008_card_summary", m0008_card_summary.SQL),
    ("0009_role_links", m0009_role_links.SQL),
    ("0010_clerk_owner", m0010_clerk_owner.SQL),
    ("0011_feedback_creator", m0011_feedback_creator.SQL),
    ("0012_recover_longview", m0012_recover_longview.SQL),
    ("0013_rebind_longview_clerk_sub", m0013_rebind_longview_clerk_sub.SQL),
    ("0014_share_grants", m0014_share_grants.SQL),
]

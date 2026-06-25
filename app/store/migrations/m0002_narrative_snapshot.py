"""m0002 — narrative computed_json snapshot for figure-level stale diffs (M5).

Additive-only (DATA_MODEL.md §8): adds ``narratives.snapshot_json`` holding the
computed_json view-model as it was at generation/save time. GET …/narrative uses
it to produce a figure-level ``stale_diff`` ("was $262,400 → now $277,990") without
re-deriving anything, and crucially WITHOUT clobbering the user's edited prose.
"""
SQL = """
ALTER TABLE narratives ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
"""

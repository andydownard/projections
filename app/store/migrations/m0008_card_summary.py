"""m0008 — owner-list card summary column (issue #178).

Additive-only (CLAUDE.md DB discipline / DATA_MODEL §8): one ``ALTER TABLE ADD
COLUMN`` carrying the compact, denormalized owner-list card summary so the home-page
list no longer ``SELECT *`` + ``json.loads`` the full ~10KB ``computed_json`` per row
to read ~6 display fields.

- ``summary_json`` — small ``{location, basis, y1_revenue, y1_net, capital_required,
  reco_tag, coords}`` blob (see ``app/store/card_summary.py``), refreshed at every
  write from ``computed_json`` by ``SqliteStore``. ``list_card_summaries`` SELECTs
  only this + the small identity columns, never the heavy JSON blobs.

Frozen ``DEFAULT '{}'`` (empty) for legacy rows; ``SqliteStore`` runs a ONE-TIME
backfill (``_backfill_card_summaries``) on the boot that applies this migration so
existing projections get a correct card without a re-save. NEVER DROP/RENAME.
"""

SQL = """
ALTER TABLE projections ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}';
"""

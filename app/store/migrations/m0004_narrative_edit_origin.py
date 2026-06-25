"""m0004 — narrative edit_origin classification (epic-N N4).

Additive-only (DATA_MODEL.md §8): adds ``narratives.edit_origin`` recording how
the stored prose was last produced — ``'ai'`` (regenerated from computed_json),
``'human'`` (hand-edited via PUT), or NULL (none yet). The confirm-before-discard
regenerate gate (N6) and the client's "edited by you" badge both read it, and it
is part of the GET …/narrative payload.
"""
SQL = """
ALTER TABLE narratives ADD COLUMN edit_origin TEXT;
"""

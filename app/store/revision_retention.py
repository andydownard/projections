"""app/store/revision_retention.py — bounded revisions + no write-only snapshot (#179).

Two pure policies applied above the Store interface (so SQLite and Postgres behave
identically), mirroring ``penny_retention``:

1. **Drop the recomputable, never-read compute snapshot.** Every revision stored the
   full ~10KB ``computed_json`` (plus an empty ``monthly_json``) that is **never read
   back** — ``restore_revision`` recomputes the view-model from
   inputs/assumptions/overrides + ``model_version`` and never reads
   ``rev['computed_json']``; ``list_revisions`` returns metadata only. So the snapshot
   was pure durable-volume bloat that Litestream then replicated. ``strip_recomputable``
   blanks it to ``'{}'`` (the columns stay ``NOT NULL``; additive-only — we never drop
   them) while preserving the recoverable inputs the restore path actually reads.

2. **Cap revisions per projection.** Autosave settles append unboundedly. The store
   prunes the oldest beyond ``MAX_REVISIONS_PER_PROJECTION`` on each insert, preserving
   (a) the most-recent window and (b) **protected** revisions — model upgrades
   (pre-upgrade restore point, DATA_MODEL §5.3) and token rotations (security audit,
   §6.1) — so the audit/restore contract survives compaction.
"""
from __future__ import annotations

from typing import Any

# Hard cap on retained revisions per projection (bounds autosave write-amplification).
# Generous vs. a normal editing session; protects against runaway append volume.
MAX_REVISIONS_PER_PROJECTION = 100

# Change-summary substrings whose revisions are NEVER pruned: a model upgrade is the
# pre-upgrade restore point (never silently lost), a rotation is a security-audit event.
_PROTECTED_MARKERS = ("upgrade", "rotate")

# The recomputable, write-only snapshot columns dropped from every stored revision.
# They are reconstructable from inputs/assumptions/overrides + model_version on restore
# and are never read from a revision row.
_RECOMPUTABLE_FIELDS = ("computed_json", "monthly_json")


def strip_recomputable(rev: dict[str, Any]) -> dict[str, Any]:
    """Return ``rev`` with the recomputable compute snapshot blanked to ``'{}'``.

    Does not mutate the input. The recoverable inputs (inputs/assumptions/overrides/
    model_version + metadata) are preserved — that is all the restore path reads.
    """
    out = dict(rev)
    for field in _RECOMPUTABLE_FIELDS:
        if field in out:
            out[field] = "{}"
    return out


def is_protected(change_summary: str | None) -> bool:
    """True if a revision's ``change_summary`` marks it as never-pruned (audit/restore)."""
    s = (change_summary or "").lower()
    return any(marker in s for marker in _PROTECTED_MARKERS)

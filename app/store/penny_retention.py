"""app/store/penny_retention.py — Penny transcript retention/size cap (Spec §7).

A pure, backend-agnostic policy applied on every append before persisting, so the
stored transcript stays bounded:

1. **Cap stored turns per projection** — keep only the most recent ``MAX_TURNS``
   (the oldest turns fall off; the active conversation window is preserved).
2. **Truncate oldest tool payloads, keep the human-readable summary** — for
   ``role == "tool"`` turns older than the most-recent ``TOOL_PAYLOAD_RETENTION``
   window, drop the heavy machine payload fields (``tool_args``,
   ``tool_result_ref``) but keep ``content`` (the narrated summary) so the
   transcript still reads coherently and audit links survive.

No financial leakage beyond what the projection already contains for that owner
(Spec §7): this only prunes the transcript's own turns, never reaches outside it.
Lives above the Store interface so both SQLite and Postgres apply identical policy.
"""
from __future__ import annotations

# Hard cap on stored turns per projection (bounds append-heavy conversations).
MAX_TURNS = 200

# Keep full tool payloads only for the most-recent N turns; older tool turns are
# truncated to their summary so the stored blob does not grow without bound.
TOOL_PAYLOAD_RETENTION = 40

# Heavy machine-payload fields dropped when an old tool turn is truncated. The
# human-readable ``content`` summary and provenance ``revision_id`` are preserved.
_HEAVY_TOOL_FIELDS = ("tool_args", "tool_result_ref")


def _truncate_tool_payload(turn: dict) -> dict:
    pruned = dict(turn)
    for field in _HEAVY_TOOL_FIELDS:
        if field in pruned:
            pruned[field] = None
    pruned["truncated"] = True
    return pruned


def apply_retention(turns: list[dict]) -> list[dict]:
    """Return ``turns`` bounded by the §7 retention policy (does not mutate input)."""
    # 1. Cap total turns: keep the most-recent MAX_TURNS.
    capped = turns[-MAX_TURNS:] if len(turns) > MAX_TURNS else list(turns)

    # 2. Truncate old tool payloads (keep the human-readable summary).
    cutoff = len(capped) - TOOL_PAYLOAD_RETENTION
    result: list[dict] = []
    for i, turn in enumerate(capped):
        if i < cutoff and turn.get("role") == "tool":
            result.append(_truncate_tool_payload(turn))
        else:
            result.append(turn)
    return result

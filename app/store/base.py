"""app/store/base.py — the Store Protocol (DATA_MODEL.md §9, ARCHITECTURE §6).

All persistence goes through this single interface. SqliteStore ships in v1;
PostgresStore is a documented drop-in stub. NO SQLite-isms leak above this
interface (no INSERT OR REPLACE, no rowid, no last_insert_rowid, no JSON1).

Portability rules (DATA_MODEL.md §9) are enforced by a conformance suite that runs
the SAME tests against both backends. This project has no authentication (owner
decision, 2026-09-13) — every list below is global, not owner-scoped.
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Store(Protocol):
    # --- lifecycle ---
    def migrate(self) -> None: ...
    def ping(self) -> bool: ...

    # --- projections (root aggregate) ---
    def get_projection_by_slug(self, view_slug: str) -> dict | None: ...
    # global list: small card columns only, never the heavy JSON blobs (#178)
    def list_card_summaries(self, *, include_trashed: bool = False) -> list[dict]: ...
    def create_projection(self, p: dict) -> dict: ...
    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int: ...  # rows-affected; 0 -> HTTP 409
    def update_with_version_check_and_revision(
        self, id: str, expected_version: int, patch: dict[str, Any], revision: dict
    ) -> int: ...  # version bump + revision snapshot in ONE txn; 0 -> 409 (no revision)
    def set_status(
        self, id: str, status: str, expected_version: int
    ) -> int: ...  # trash/restore; 0 -> HTTP 409
    def soft_delete(self, id: str, expected_version: int) -> int: ...  # recoverable soft-delete
    def purge_projection(
        self, id: str, expected_version: int
    ) -> int: ...  # hard DELETE + cascade to all children (#202); 0 -> HTTP 409

    # --- revisions ---
    def insert_revision(self, rev: dict) -> None: ...
    def list_revisions(self, projection_id: str, limit: int = 50) -> list[dict]: ...
    def get_revision(self, revision_id: str) -> dict | None: ...

    # --- role links (M5 / §4.3) ---
    def get_projection_by_role_slug(self, role_slug: str) -> dict | None: ...

    # --- narratives (M5 / §6.1) ---
    def get_narrative(self, projection_id: str) -> dict | None: ...
    def upsert_narrative(self, projection_id: str, narrative: dict[str, Any]) -> dict: ...

    # --- feedback (M6 / §8.1) ---
    def create_feedback(self, fb: dict) -> dict: ...

    # --- intent (M6 / §8.2) ---
    def create_intent(self, intent: dict) -> dict: ...

    # --- penny transcripts (Penny / §7) ---
    # Per-project conversation store. projection_id is required on every write:
    # ephemeral wizard-draft transcripts are NEVER persisted (Spec §7). These key
    # on the already-resolved projection_id (the router resolves the slug first).
    def create_transcript(self, t: dict) -> dict: ...
    def append_transcript_turn(self, projection_id: str, turn: dict) -> dict: ...
    def get_transcript_by_projection(self, projection_id: str) -> dict | None: ...

    # --- terms gate (M0.6 / §21) ---
    def get_terms_accepted_at(self, id: str) -> str | None: ...

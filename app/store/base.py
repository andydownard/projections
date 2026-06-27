"""app/store/base.py — the Store Protocol (DATA_MODEL.md §9, ARCHITECTURE §6).

All persistence goes through this single interface. SqliteStore ships in v1;
PostgresStore is a documented drop-in stub. NO SQLite-isms leak above this
interface (no INSERT OR REPLACE, no rowid, no last_insert_rowid, no JSON1).

Portability rules (DATA_MODEL.md §9) are enforced by a conformance suite that runs
the SAME tests against both backends. v1 scope here is the M0 surface: migrate +
ping + the projection create/read/owner-list/version-checked-update primitives
needed by the Mutation Safety quad. The full method set lands with its milestone.
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
    def list_by_owner(
        self, owner_token_hash: str, *, include_trashed: bool = False
    ) -> list[dict]: ...
    # owner list: small card columns only, never the heavy JSON blobs (#178)
    def list_card_summaries(
        self, owner_token_hash: str, *, include_trashed: bool = False
    ) -> list[dict]: ...
    def create_projection(self, p: dict) -> dict: ...
    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int: ...  # rows-affected; 0 -> HTTP 409
    def update_with_version_check_and_revision(
        self, id: str, expected_version: int, patch: dict[str, Any], revision: dict
    ) -> int: ...  # version bump + revision snapshot in ONE txn; 0 -> 409 (no revision)
    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int: ...  # atomic owner/edit/view_slug/role rotation; 0 -> HTTP 409
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
    # ephemeral wizard-draft transcripts are NEVER persisted (Spec §7). Owner
    # scoping is enforced at the router (the slug resolves to projection_id under
    # an owner/edit Bearer); these key on the already-resolved projection_id.
    def create_transcript(self, t: dict) -> dict: ...
    def append_transcript_turn(self, projection_id: str, turn: dict) -> dict: ...
    def get_transcript_by_projection(self, projection_id: str) -> dict | None: ...

    # --- terms gate (M0.6 / §21) ---
    def get_terms_accepted_at(self, id: str) -> str | None: ...

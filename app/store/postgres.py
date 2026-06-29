"""app/store/postgres.py — PostgresStore drop-in STUB (DATA_MODEL.md §10).

The Postgres path is for when single-writer SQLite concurrency is exceeded. Because
the portability rules (app-generated ULID PKs, no INSERT OR REPLACE, opaque
JSON/jsonb, identical version-check SQL) are honored above the interface, the move
is a backend swap, not a redesign. This stub raises until implemented; the
conformance suite (DATA_MODEL.md §9) will run the SAME tests against it.
"""
from __future__ import annotations

from typing import Any, NoReturn


class PostgresStore:
    """Documented drop-in stub. Methods raise NotImplementedError in v1."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def _stub(self, name: str) -> NoReturn:
        raise NotImplementedError(
            f"PostgresStore.{name} is a documented v1 stub. The SQL is identical to "
            "SqliteStore (see DATA_MODEL.md §10 cutover); wire psycopg here when the "
            "concurrency trigger fires."
        )

    def migrate(self) -> None:
        self._stub("migrate")

    def ping(self) -> bool:
        self._stub("ping")

    def get_projection_by_slug(self, view_slug: str) -> dict | None:
        self._stub("get_projection_by_slug")

    def list_by_owner(self, owner_token_hash: str, *, include_trashed: bool = False) -> list[dict]:
        self._stub("list_by_owner")

    def list_card_summaries(
        self, owner_token_hash: str, *, include_trashed: bool = False
    ) -> list[dict]:
        self._stub("list_card_summaries")

    def list_by_clerk_owner(
        self, clerk_user_id: str, *, include_trashed: bool = False
    ) -> list[dict]:
        self._stub("list_by_clerk_owner")

    def list_card_summaries_by_clerk_owner(
        self, clerk_user_id: str, *, include_trashed: bool = False
    ) -> list[dict]:
        self._stub("list_card_summaries_by_clerk_owner")

    def claim_projections_to_clerk_owner(
        self, owner_token_hash: str, clerk_user_id: str, org_id: str | None = None
    ) -> int:
        self._stub("claim_projections_to_clerk_owner")

    def create_projection(self, p: dict) -> dict:
        self._stub("create_projection")

    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int:
        self._stub("update_with_version_check")

    def update_with_version_check_and_revision(
        self, id: str, expected_version: int, patch: dict[str, Any], revision: dict
    ) -> int:
        self._stub("update_with_version_check_and_revision")

    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int:
        self._stub("rotate_tokens")

    def set_status(self, id: str, status: str, expected_version: int) -> int:
        self._stub("set_status")

    def soft_delete(self, id: str, expected_version: int) -> int:
        self._stub("soft_delete")

    def purge_projection(self, id: str, expected_version: int) -> int:
        self._stub("purge_projection")

    def insert_revision(self, rev: dict) -> None:
        self._stub("insert_revision")

    def list_revisions(self, projection_id: str, limit: int = 50) -> list[dict]:
        self._stub("list_revisions")

    def get_revision(self, revision_id: str) -> dict | None:
        self._stub("get_revision")

    def get_projection_by_role_slug(self, role_slug: str) -> dict | None:
        self._stub("get_projection_by_role_slug")

    def get_narrative(self, projection_id: str) -> dict | None:
        self._stub("get_narrative")

    def upsert_narrative(self, projection_id: str, narrative: dict[str, Any]) -> dict:
        self._stub("upsert_narrative")

    def create_feedback(self, fb: dict) -> dict:
        self._stub("create_feedback")

    def create_intent(self, intent: dict) -> dict:
        self._stub("create_intent")

    # --- penny transcripts (§7) ---
    def create_transcript(self, t: dict) -> dict:
        self._stub("create_transcript")

    def append_transcript_turn(self, projection_id: str, turn: dict) -> dict:
        self._stub("append_transcript_turn")

    def get_transcript_by_projection(self, projection_id: str) -> dict | None:
        self._stub("get_transcript_by_projection")

    def get_terms_accepted_at(self, id: str) -> str | None:
        self._stub("get_terms_accepted_at")

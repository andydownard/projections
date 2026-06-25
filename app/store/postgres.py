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

    def create_projection(self, p: dict) -> dict:
        self._stub("create_projection")

    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int:
        self._stub("update_with_version_check")

    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int:
        self._stub("rotate_tokens")

    def set_status(self, id: str, status: str, expected_version: int) -> int:
        self._stub("set_status")

    def soft_delete(self, id: str, expected_version: int) -> int:
        self._stub("soft_delete")

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

    def get_terms_accepted_at(self, id: str) -> str | None:
        self._stub("get_terms_accepted_at")

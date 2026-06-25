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
    def create_projection(self, p: dict) -> dict: ...
    def update_with_version_check(
        self, id: str, expected_version: int, patch: dict[str, Any]
    ) -> int: ...  # rows-affected; 0 -> HTTP 409
    def rotate_tokens(
        self, id: str, expected_version: int, new_hashes: dict[str, Any]
    ) -> int: ...  # atomic owner/edit/view_slug/role rotation; 0 -> HTTP 409
    def set_status(
        self, id: str, status: str, expected_version: int
    ) -> int: ...  # trash/restore; 0 -> HTTP 409
    def soft_delete(self, id: str, expected_version: int) -> int: ...  # hard purge marker

    # --- revisions ---
    def insert_revision(self, rev: dict) -> None: ...
    def list_revisions(self, projection_id: str, limit: int = 50) -> list[dict]: ...

    # --- role links (M5 / §4.3) ---
    def get_projection_by_role_slug(self, role_slug: str) -> dict | None: ...

    # --- feedback (M6 / §8.1) ---
    def create_feedback(self, fb: dict) -> dict: ...

    # --- terms gate (M0.6 / §21) ---
    def get_terms_accepted_at(self, id: str) -> str | None: ...

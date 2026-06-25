"""app/store — persistence behind the Store Protocol.

get_store() selects the backend by DB_BACKEND (explicit; never ambiguous —
DATA_MODEL.md §8). Defaults to an in-memory SQLite DB in dev/test so the app boots
and migrates without a configured volume.
"""
from __future__ import annotations

import os
import threading

from app.store.base import Store
from app.store.postgres import PostgresStore
from app.store.sqlite import SqliteStore

_store: Store | None = None
_lock = threading.Lock()


def build_store(env: dict[str, str] | None = None) -> Store:
    resolved = dict(os.environ) if env is None else env
    backend = resolved.get("DB_BACKEND", "sqlite")
    env = resolved
    if backend == "postgres":
        return PostgresStore(env["DATABASE_URL"])
    # sqlite (default). In dev/test, an unset DB_PATH uses an in-memory DB.
    db_path = env.get("DB_PATH") or ":memory:"
    store = SqliteStore(db_path)
    store.migrate()
    return store


def get_store() -> Store:
    global _store
    if _store is None:
        with _lock:
            if _store is None:
                _store = build_store()
    return _store


def reset_store_for_tests() -> None:
    """Test hook: drop the cached singleton so each test gets a fresh DB."""
    global _store
    with _lock:
        _store = None


__all__ = ["Store", "get_store", "build_store", "reset_store_for_tests"]

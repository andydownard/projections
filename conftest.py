"""Root conftest — make `app` and `engine` importable and isolate the DB per test."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))


@pytest.fixture(autouse=True)
def _fresh_store():
    """Each test gets a fresh in-memory store singleton."""
    from app.store import reset_store_for_tests

    reset_store_for_tests()
    yield
    reset_store_for_tests()

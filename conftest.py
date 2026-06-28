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


@pytest.fixture(autouse=True)
def _no_real_github(monkeypatch):
    """Never touch real GitHub in tests.

    ``file_github_issue()`` now makes a LIVE GitHub call when GITHUB_TOKEN/GH_PAT
    + a repo are configured (Epic F, #265). Clear those creds for every test by
    default so a dev/CI shell that happens to export them can never file a real
    issue; the filing tests set them explicitly and inject a MockTransport client.
    """
    for var in ("GITHUB_TOKEN", "GH_PAT", "GITHUB_REPO", "GITHUB_ORG"):
        monkeypatch.delenv(var, raising=False)
    yield

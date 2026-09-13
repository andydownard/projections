"""E2E support — the deterministic `example` seed + role-link read (API_SPEC §4.3).

The Playwright flows drive a fixed projection at view_slug `example` (terms
accepted; this project has no authentication, owner decision 2026-09-13) and a
board role link `board-slug`. seed_example() makes those deterministic so the
gate is reproducible. RED-first.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import EXAMPLE_SLUG, ROLE_SLUG, seed_example
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    seed_example(store)
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def test_example_projection_is_readable_with_decision(client):
    r = client.get(f"/api/projections/{EXAMPLE_SLUG}")
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay",
        "do_not_proceed"}
    assert vm["metrics"]["capital"]["display"].startswith("$")


def test_example_can_be_patched_with_no_auth(client):
    get = client.get(f"/api/projections/{EXAMPLE_SLUG}")
    version = get.json()["version"]
    r = client.patch(
        f"/api/projections/{EXAMPLE_SLUG}",
        headers={"If-Match": str(version)},
        json={"name": "Edited by A"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Edited by A"


def test_example_terms_accepted_allows_xlsx(client):
    r = client.get(f"/api/projections/{EXAMPLE_SLUG}/xlsx")
    assert r.status_code == 200, r.text


def test_role_link_returns_verdict_and_role(client):
    r = client.get(f"/api/r/{ROLE_SLUG}")
    assert r.status_code == 200, r.text
    vm = r.json()
    assert vm["reco"]["tag"]
    assert vm["role"] == "board"
    assert vm["metrics"]["capital"]["display"].startswith("$")


def test_unknown_role_link_404(client):
    r = client.get("/api/r/nope-nope")
    assert r.status_code == 404

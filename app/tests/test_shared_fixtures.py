"""RED first: the shared fixtures in app/tests/conftest.py work end-to-end.

New tests in the refactor plan lean on `client` / `client_store` /
`create_projection` from conftest instead of re-copying the SqliteStore +
create_app boilerplate (the pattern in test_projections_api.py). The 49
existing files keep their local fixtures (migration is a separate ticket);
local fixtures shadow conftest's, so nothing existing changes behavior.
"""
from app.tests.conftest import CANONICAL_BODY, create_projection


def test_shared_client_serves_health(client):
    assert client.get("/api/health").status_code == 200


def test_shared_client_store_is_client_plus_store(client_store):
    client, store = client_store
    slug, owner_token, version, body = create_projection(client)
    # The row landed in THIS client's store (same in-memory SqliteStore).
    assert store.get_projection_by_slug(slug) is not None


def test_create_projection_returns_slug_token_version_body(client):
    slug, owner_token, version, body = create_projection(client)
    assert slug and slug == body["view_slug"]
    assert owner_token == body["owner_token"]
    assert version == 1 == body["version"]
    assert body["reco"]["tag"] in {
        "proceed", "revise", "find_cheaper_rent", "raise_cash", "delay",
        "do_not_proceed"}


def test_create_projection_overrides_replace_top_level_keys(client):
    slug, owner_token, version, body = create_projection(
        client, name="Override Name")
    assert body["name"] == "Override Name"
    # The canonical template must not be mutated by per-call overrides.
    assert CANONICAL_BODY["name"] == "House of Hope"


def test_two_creates_are_isolated_per_client(client):
    slug_a, *_ = create_projection(client)
    slug_b, *_ = create_projection(client)
    assert slug_a != slug_b

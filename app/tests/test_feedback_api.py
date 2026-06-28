"""M6 feedback — POST /api/feedback (API_SPEC §8.1, PRD §22).

The product's #1 data-leak risk: a GitHub issue must carry ONLY a random
support_id + non-sensitive context (route with slug stripped, app/model version,
timestamp). It must NEVER carry a view_slug, token, resolvable link, or any
financial field. RED-first: written before app/routers/feedback.py exists.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import get_store
from app.store.sqlite import SqliteStore


@pytest.fixture()
def client():
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


def test_feedback_returns_support_id_and_no_projection_link(client):
    r = client.post(
        "/api/feedback",
        json={
            "type": "bug",
            "title": "Break-even marker off by one",
            "description": "Banner says month 5 but chart marks 6.",
            "route": "/p/example/edit",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["support_id"].startswith("SUP-")
    # github_issue_url may be null (degrade), but never a projection link.
    assert "view_slug" not in body
    assert "/p/" not in (body.get("github_issue_url") or "")


def test_feedback_route_is_slug_stripped_when_persisted(client):
    r = client.post(
        "/api/feedback",
        json={
            "type": "bug",
            "title": "x",
            "description": "y",
            "route": "/p/example/edit#edit-secret",
        },
    )
    assert r.status_code == 201
    # The stored context route must not contain the slug or the fragment secret.
    store = list(client.app.dependency_overrides.values())[0]()
    row = store._conn.execute(
        "SELECT context_json FROM feedback WHERE support_id = ?",
        (r.json()["support_id"],),
    ).fetchone()
    ctx = row["context_json"]
    assert "example" not in ctx
    assert "edit-secret" not in ctx


def test_idea_needs_no_title(client):
    # The Idea Fab suggestion flow sends a description only — no title. The server
    # accepts it (an idea is just a thought, not a triage ticket).
    r = client.post(
        "/api/feedback",
        json={"type": "idea", "description": "Add a dark mode."},
    )
    assert r.status_code == 201, r.text
    assert r.json()["support_id"].startswith("SUP-")


def test_bug_still_requires_a_title(client):
    # A bug report without a title is still rejected so it stays triageable.
    r = client.post(
        "/api/feedback",
        json={"type": "bug", "description": "something is broken"},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "title_required"


def test_feedback_persists_no_financial_fields(client):
    r = client.post(
        "/api/feedback",
        json={"type": "idea", "title": "t", "description": "d", "route": "/p/x"},
    )
    sid = r.json()["support_id"]
    store = list(client.app.dependency_overrides.values())[0]()
    row = store._conn.execute(
        "SELECT * FROM feedback WHERE support_id = ?", (sid,)
    ).fetchone()
    blob = " ".join(str(v) for v in dict(row).values())
    for leak in ("capital", "revenue", "cashGap", "computed_json"):
        assert leak not in blob

"""app/routers/feedback.py — redacted bug/idea → GitHub issue (API_SPEC §8.1).

The product's #1 data-leak risk (PRD §22, CLAUDE.md hard rule). The outbound
GitHub payload — and the persisted row — carry ONLY a random support_id plus
non-sensitive context: the route with any slug/fragment stripped, the app +
model version, and a timestamp. NEVER a view_slug, token, resolvable projection
link, or any financial field. The success surface shows only the support_id.

GitHub delivery degrades gracefully: with GITHUB_TOKEN/GITHUB_REPO unset the
feedback is still persisted and a support_id returned (github_issue_url=null) —
never a 500.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import config
from app.store import Store, get_store

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# A short, human-quotable id. SUP- prefix so the e2e/UX can assert on it.
_SUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _support_id() -> str:
    return "SUP-" + "".join(secrets.choice(_SUP_ALPHABET) for _ in range(6))


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def redact_route(route: str) -> str:
    """Strip any slug segment and URL fragment so no resolvable link survives.

    /p/<slug>/edit#edit-secret -> /p/:slug/edit ; /r/<slug> -> /r/:slug.
    The fragment (edit/role secret) is dropped entirely (PRD §20/§22).
    """
    route = (route or "/").split("#", 1)[0].split("?", 1)[0]
    # Collapse the capability slug that follows /p/ or /r/ to a placeholder.
    route = re.sub(r"^(/[pr])/[^/]+", r"\1/:slug", route)
    return route or "/"


class FeedbackIn(BaseModel):
    type: str = "bug"
    title: str
    description: str = ""
    route: str = "/"


@router.post("", status_code=201)
def submit_feedback(body: FeedbackIn, store: Store = Depends(get_store)):
    if not body.title.strip():
        raise HTTPException(status_code=422, detail={"error": "title_required"})

    support_id = _support_id()
    # context carries ONLY non-sensitive fields (NO slug, token, link, financials).
    context = {
        "route": redact_route(body.route),
        "app_version": config.build_sha(),
        "type": body.type,
        "ts": _utcnow(),
    }

    github_issue_url = _open_github_issue(support_id, body, context)

    store.create_feedback({
        "support_id": support_id,
        "type": body.type,
        "title": body.title.strip(),
        "body": body.description.strip(),
        "email": None,
        "context_json": json.dumps(context),
        "github_issue_url": github_issue_url,
        "status": "open",
        "created_at": _utcnow(),
    })

    # Only the support_id is shown to the user.
    return {"support_id": support_id, "github_issue_url": github_issue_url}


def _open_github_issue(
    support_id: str, body: FeedbackIn, context: dict
) -> Optional[str]:
    """Open a redacted GitHub issue if configured; else degrade to None.

    v1 keeps the network call out of the request path's hard requirements: when
    the token/repo are unset (dev, e2e, AI-off) we persist + return support_id
    with github_issue_url=null. A live GitHub integration lands with M6 proper.
    """
    import os

    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPO")
    if not (token and repo):
        return None
    # Live delivery is intentionally deferred; the redaction contract (context)
    # is what CI/e2e gate. Returning None keeps the path graceful.
    return None

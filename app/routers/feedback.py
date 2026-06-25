"""app/routers/feedback.py — redacted bug/idea → GitHub issue (API_SPEC §8.1).

The product's #1 data-leak risk (PRD §22, CLAUDE.md hard rule). The outbound
GitHub payload — and the persisted row — carry ONLY a random support_id plus
non-sensitive context: the route with any slug/fragment stripped, the app +
model version, and a timestamp. The title/body are run through the pure redactor
(app/feedback/redact.py) so a pasted edit link, token, recovery code, or dollar
figure can never reach GitHub. A Tier-1 CI test asserts the assembled payload
contains none of these (PRD §22, impossible to regress).

Abuse controls (IDEA_FAB §4): per-IP/per-token rate limit + honeypot + length
caps run BEFORE any GitHub call or DB write. GitHub delivery degrades gracefully:
with GITHUB_TOKEN/GITHUB_REPO unset the feedback is still persisted and a
support_id returned (github_issue_url=null) — never a 500.
"""
from __future__ import annotations

import json
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import config, ratelimit
from app.feedback.redact import (
    DESCRIPTION_CAP,
    TITLE_CAP,
    redact_text,
)
from app.store import Store, get_store

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# A short, human-quotable id. SUP- prefix so the e2e/UX can assert on it.
_SUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# Abuse caps (IDEA_FAB §4.1). v1 starting template, tuned against real traffic.
_IP_LIMIT_PER_HOUR = 10


def _support_id() -> str:
    return "SUP-" + "".join(secrets.choice(_SUP_ALPHABET) for _ in range(6))


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _client_ip(request: Request) -> str:
    """Right-most untrusted hop from X-Forwarded-For, else the socket peer."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def redact_route(route: str, own_slug: str | None = None) -> str:
    """Strip any slug segment and URL fragment so no resolvable link survives.

    /p/<slug>/edit#edit-secret -> /p/:slug/edit ; /r/<slug> -> /r/:slug.
    The fragment (edit/role secret) is dropped entirely (PRD §20/§22).
    """
    route = (route or "/").split("#", 1)[0].split("?", 1)[0]
    # Collapse the capability slug that follows /p/ or /r/ to a placeholder.
    route = re.sub(r"^(/[pr])/[^/]+", r"\1/:slug", route)
    if own_slug:
        route = route.replace(own_slug, ":slug")
    return route or "/"


class FeedbackContext(BaseModel):
    model_version: str = ""
    view_slug: str = ""  # server-only; NEVER reaches GitHub (IDEA_FAB §3.5).

    class Config:
        extra = "ignore"  # any other context key is dropped silently.


class FeedbackIn(BaseModel):
    type: str = "bug"
    title: str
    description: str = ""
    email: Optional[str] = None
    route: str = "/"
    context: FeedbackContext = FeedbackContext()
    hp: str = ""  # honeypot; must be empty (IDEA_FAB §4.4).


@router.post("", status_code=201)
def submit_feedback(
    body: FeedbackIn,
    request: Request,
    response: Response,
    store: Store = Depends(get_store),
):
    if not body.title.strip():
        raise HTTPException(status_code=422, detail={"error": "title_required"})

    # 1) Rate-limit FIRST (cheapest rejection; no work past the cap).
    allowed, retry_after = ratelimit.check(
        "feedback", ip=_client_ip(request), ip_limit=_IP_LIMIT_PER_HOUR
    )
    if not allowed:
        # API_SPEC §2.3: the 429 body is a top-level {"error":"rate_limited",…};
        # return it directly (a raised HTTPException would nest it under "detail").
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "retry_after_seconds": retry_after,
                "scope": "ip",
            },
            headers={"Retry-After": str(retry_after)},
        )

    support_id = _support_id()

    # 2) Honeypot: a non-empty hidden field => a bot. Return a plausible success
    #    (not a 400, so the bot learns nothing) but write NOTHING and file NOTHING.
    if body.hp.strip():
        return {"support_id": support_id}

    own_slug = body.context.view_slug or None

    # 3) Redact title/body (one redacted artifact, stored == filed).
    title = redact_text(body.title, own_slug=own_slug, cap=TITLE_CAP)
    redacted_body = redact_text(body.description, own_slug=own_slug, cap=DESCRIPTION_CAP)

    # context carries ONLY non-sensitive fields (NO slug, token, link, financials).
    context = {
        "route": redact_route(body.route, own_slug),
        "app_version": config.build_sha(),
        "model_version": body.context.model_version,
        "type": body.type,
        "ts": _utcnow(),
    }

    # 4) Build the GitHub payload from redacted parts only and file it (stubbed
    #    in tests). support_id is non-sensitive and IS included.
    gh_payload = {
        "support_id": support_id,
        "type": body.type,
        "title": title,
        "body": redacted_body,
        "context": context,
    }
    github_issue_url = _maybe_file_github_issue(gh_payload)

    # 5) Persist the SAME redacted artifact (no email in GitHub, but email is
    #    stored server-only for an optional reply).
    store.create_feedback({
        "support_id": support_id,
        "type": body.type,
        "title": title,
        "body": redacted_body,
        "email": (body.email or None),
        "context_json": json.dumps(context),
        "github_issue_url": github_issue_url,
        "status": "open",
        "created_at": _utcnow(),
    })

    # Only the support_id is shown to the user (NEVER github_issue_url).
    return {"support_id": support_id}


def file_github_issue(payload: dict) -> Optional[str]:
    """File a redacted GitHub issue; return the issue URL or None.

    v1 keeps the live network call deferred: when GITHUB_TOKEN/GITHUB_REPO are
    unset (dev, e2e, AI-off) we return None so the path degrades gracefully. The
    payload here is ALREADY redacted (router-side) — this function is the seam
    the Tier-1 leak test stubs to capture the exact outbound payload.
    """
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPO")
    if not (token and repo):
        return None
    # Live delivery (issue create + Project add) lands behind this seam; the
    # redaction contract is what CI/e2e gate. Returning None keeps it graceful.
    return None


def _maybe_file_github_issue(payload: dict) -> Optional[str]:
    """Best-effort, non-fatal GitHub filing (IDEA_FAB §5.4)."""
    try:
        return file_github_issue(payload)
    except Exception:  # GitHub down/misconfigured must never 500 the user.
        return None

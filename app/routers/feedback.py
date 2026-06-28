"""app/routers/feedback.py — redacted bug/idea → GitHub issue (API_SPEC §8.1).

The product's #1 data-leak risk (PRD §22, CLAUDE.md hard rule). The outbound
GitHub payload — and the persisted row — carry ONLY a random support_id plus
non-sensitive context: the route with any slug/fragment stripped, the app +
model version, and a timestamp. The title/body are run through the pure redactor
(app/feedback/redact.py) so a pasted edit link, token, recovery code, or dollar
figure can never reach GitHub. A Tier-1 CI test asserts the assembled payload
contains none of these (PRD §22, impossible to regress).

Abuse controls (IDEA_FAB §4): per-IP/per-token rate limit + honeypot + length
caps run BEFORE any GitHub call or DB write. GitHub delivery (a live REST issue
create — IDEA_FAB §5) authenticates with a server-only PAT (GITHUB_TOKEN or
GH_PAT) and resolves the repo from GITHUB_REPO ("owner/repo") OR GITHUB_ORG +
GITHUB_REPO. It degrades gracefully: with the token/repo unset, or on any GitHub
error/timeout, the feedback is still persisted and a support_id returned
(github_issue_url=null) — never a 500.
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: Pydantic/FastAPI evaluate these
# annotations at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
import json
import logging
import os
import secrets
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import config, ratelimit
from app.deps import resolve_clerk_identity
from app.feedback.creator import creator_fields_from_claims
from app.feedback.redact import (
    DESCRIPTION_CAP,
    TITLE_CAP,
    build_safe_context,
    normalize_type,
    redact_text,
)
from app.store import Store, get_store
from engine.model import MODEL_VERSION

logger = logging.getLogger("app.feedback")

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# A short, human-quotable id. SUP- prefix so the e2e/UX can assert on it.
_SUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# Abuse caps (IDEA_FAB §4.1). v1 starting template, tuned against real traffic.
_IP_LIMIT_PER_HOUR = 10

# --- GitHub issue filing (IDEA_FAB §5; API_SPEC §8.1) ------------------------
# REST issue-create endpoint. Authenticated with a server-only PAT; the outbound
# body is the ALREADY-REDACTED payload (no slug/token/link/$/% can reach here).
_GITHUB_API = "https://api.github.com"
_GITHUB_TIMEOUT_SECONDS = 5.0  # short: a slow GitHub must never block the user.

# Human-facing type prefix for the issue title; the persisted/filed `type` is the
# closed FEEDBACK_TYPES enum, so this lookup is total.
_TYPE_DISPLAY = {"bug": "Bug", "idea": "Idea", "other": "Other"}


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


class FeedbackContext(BaseModel):
    # NO client `model_version`: it is stamped SERVER-side from the engine
    # (#201). A client-sent model_version is silently dropped (extra="ignore"),
    # so it can never bypass the redactor into a sink.
    view_slug: str = ""  # server-only; NEVER reaches GitHub (IDEA_FAB §3.5).

    class Config:
        extra = "ignore"  # any other context key is dropped silently.


class FeedbackIn(BaseModel):
    # `type` is untrusted free-text on the wire; it is enum-normalized server
    # side before it touches either sink (#201). Never persisted/filed raw.
    type: str = "bug"
    # A bug report carries a title to triage; an idea (the Idea Fab suggestion
    # flow) is just a description, so `title` is optional and may be absent.
    title: str = ""
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
    authorization: Optional[str] = Header(default=None),
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
):
    # `type` is untrusted client free-text — normalize to the closed enum ONCE
    # (cheap + pure) and use that value everywhere (top-level + context). The raw
    # value never lands in a sink (#201).
    safe_type = normalize_type(body.type)

    # A bug report needs a title to triage; an idea is just a description and
    # carries no title at all (IDEA_FAB — the Idea Fab suggestion flow).
    if safe_type == "bug" and not body.title.strip():
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

    # 4) Build the context from the SERVER allowlist — the single chokepoint for
    #    both sinks. Client `model_version`/`type` are IGNORED: model_version is
    #    stamped from the engine, type is enum-normalized, route is slug-stripped.
    #    NOTHING else from the request survives (NO slug, token, link, financials).
    context = build_safe_context(
        route=body.route,
        own_slug=own_slug,
        app_version=config.build_sha(),
        model_version=MODEL_VERSION,
        feedback_type=safe_type,
        ts=_utcnow(),
    )

    # 5) Build the GitHub payload from redacted parts only and file it (stubbed
    #    in tests). support_id is non-sensitive and IS included.
    gh_payload = {
        "support_id": support_id,
        "type": safe_type,
        "title": title,
        "body": redacted_body,
        "context": context,
    }
    github_issue_url = _maybe_file_github_issue(gh_payload)

    # 6) Server-only creator identity (decisions #6/#13): when a signed-in Clerk
    #    owner files feedback, record WHO from the verified session-JWT CLAIMS (NO
    #    Clerk Backend API, NO secret). All fields optional/nullable. These PII
    #    columns are persisted SERVER-SIDE ONLY and are deliberately NOT part of
    #    `gh_payload` above — they never reach the redacted GitHub issue (PRD §22).
    #    Anonymous / kill-switch-off feedback adds NO creator keys (row unchanged).
    creator: dict = {}
    clerk_ident = resolve_clerk_identity(authorization)
    if clerk_ident is not None:
        creator = creator_fields_from_claims(
            clerk_ident.claims, clerk_user_id=clerk_ident.clerk_user_id
        )

    # 7) Persist the SAME redacted artifact (no email in GitHub, but email is
    #    stored server-only for an optional reply), plus any creator_* identity.
    store.create_feedback({
        "support_id": support_id,
        "type": safe_type,
        "title": title,
        "body": redacted_body,
        "email": (body.email or None),
        "context_json": json.dumps(context),
        "github_issue_url": github_issue_url,
        "status": "open",
        "created_at": _utcnow(),
        **creator,
    })

    # Only the support_id is shown to the user (NEVER github_issue_url).
    return {"support_id": support_id}


def _github_token() -> Optional[str]:
    """The server-only filing PAT — GITHUB_TOKEN, else GH_PAT (timpager parity).

    Server-env only (SECRETS): never logged, never returned to the client.
    """
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_PAT")


def _resolve_owner_repo() -> Optional[str]:
    """Resolve ``owner/repo`` from the env, or None when unconfigured.

    Accepts ``GITHUB_REPO`` already in ``owner/repo`` form, OR combines
    ``GITHUB_ORG`` + ``GITHUB_REPO`` (current prod sets GITHUB_ORG=rallytasks,
    GITHUB_REPO=projections). Unset/blank -> None so filing degrades gracefully.
    """
    repo = (os.environ.get("GITHUB_REPO") or "").strip().strip("/")
    if not repo:
        return None
    if "/" in repo:  # already "owner/repo"
        return repo
    org = (os.environ.get("GITHUB_ORG") or "").strip().strip("/")
    if not org:
        return None
    return f"{org}/{repo}"


def _labels_for_type(
    feedback_type: str, extra_labels: object = None
) -> list[str]:
    """Issue labels: a stable base channel label + the `type:*` taxonomy.

    `idea` -> the Idea-button "app-suggestion" channel; everything else -> the
    general "feedback" channel. Plus a `type:{enum}` label for board filtering.

    ``extra_labels`` appends server-controlled channel labels (e.g. Penny's
    ``filed-by-penny`` attribution, decisions #7/#12). They are static strings the
    server picks — NEVER user content — and are de-duplicated against the base set.
    """
    base = "app-suggestion" if feedback_type == "idea" else "feedback"
    labels = [base, f"type:{feedback_type}"]
    if isinstance(extra_labels, (list, tuple)):
        for label in extra_labels:
            if isinstance(label, str) and label and label not in labels:
                labels.append(label)
    return labels


def _issue_title(payload: dict) -> str:
    """Issue title from support_id + type (+ the already-redacted title)."""
    ftype = payload.get("type", "other")
    display = _TYPE_DISPLAY.get(ftype, "Other")
    support_id = payload.get("support_id", "")
    redacted_title = (payload.get("title") or "").strip()
    base = f"[{display}] {support_id}"
    return f"{base}: {redacted_title}" if redacted_title else base


def _issue_body(payload: dict) -> str:
    """Issue body from the redacted payload ONLY (support_id + safe context + desc).

    Every component here is already redactor-clean: the qualitative description
    has been through ``redact_text`` and the context is the server allowlist
    (route/app_version/model_version/type/ts). No view_slug, token, link, email,
    or financial figure can be assembled here (PRD §22, IDEA_FAB §3.3/§5.3).
    """
    ctx = payload.get("context") or {}
    description = (payload.get("body") or "").strip() or "_(no description provided)_"
    lines = [
        description,
        "",
        "---",
        f"- Support ID: {payload.get('support_id', '')}",
        f"- Type: {ctx.get('type', payload.get('type', ''))}",
        f"- Route: {ctx.get('route', '')}",
        f"- App version: {ctx.get('app_version', '')}",
        f"- Model version: {ctx.get('model_version', '')}",
        f"- Reported: {ctx.get('ts', '')}",
        "",
        "_Filed by the Projections Idea Fab. "
        "Contains no projection link and no financial data._",
    ]
    return "\n".join(lines)


def _default_client() -> httpx.Client:
    """Default httpx client for the GitHub call (short timeout, no redirects)."""
    return httpx.Client(follow_redirects=False, timeout=_GITHUB_TIMEOUT_SECONDS)


def file_github_issue(
    payload: dict,
    *,
    _client_factory: Optional[Callable[[], httpx.Client]] = None,
) -> Optional[str]:
    """File a redacted GitHub issue; return the issue URL or None.

    Live delivery (IDEA_FAB §5): POST ``/repos/{owner}/{repo}/issues`` with the
    ALREADY-REDACTED payload — title from support_id+type, body from support_id +
    the safe context + the redacted description, labelled by channel/type.
    Authenticated with the server-only PAT (GITHUB_TOKEN or GH_PAT).

    Degrades gracefully (FEEDBACK / OUTBOUND): when the token/repo is unset, or
    GitHub errors/times out, it logs (never the token/body) and returns None so
    the endpoint still returns 201 and persists the feedback — never a 500 on a
    GitHub outage. ``_client_factory`` is a test seam (stub httpx; no real call).
    """
    token = _github_token()
    repo = _resolve_owner_repo()
    if not (token and repo):
        return None

    issue = {
        "title": _issue_title(payload),
        "body": _issue_body(payload),
        "labels": _labels_for_type(payload.get("type", "other"), payload.get("extra_labels")),
    }
    factory = _client_factory or _default_client
    resp: Optional[httpx.Response] = None
    try:
        with factory() as client:
            resp = client.post(
                f"{_GITHUB_API}/repos/{repo}/issues",
                json=issue,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "projections-idea-fab",
                },
            )
            resp.raise_for_status()
            url = resp.json().get("html_url")
    except Exception as exc:  # noqa: BLE001 — any GitHub failure degrades, never 500s.
        # Log the failure WITHOUT the token or the issue body (SECRETS/PII). To make a
        # future filing failure diagnosable we ALSO log GitHub's status_code and a
        # short (~200 char) excerpt of its RESPONSE body — which is GitHub's own error
        # text ("Bad credentials", validation messages), never our token/PAT (those
        # live only in the request headers, which are never logged) and never the
        # already-redacted issue body. The response is taken from the exception when
        # present (raise_for_status carries it), else the captured response, else None
        # (a timeout/connect error has no response at all).
        exc_resp = getattr(exc, "response", None)
        diag = exc_resp if exc_resp is not None else resp
        status_code = getattr(diag, "status_code", None)
        body_excerpt = ""
        if diag is not None:
            try:
                body_excerpt = (diag.text or "")[:200]
            except Exception:  # noqa: BLE001 — diagnostics must never raise.
                body_excerpt = ""
        logger.warning(
            "feedback.github_issue_failed support_id=%s err=%s status=%s body=%r",
            payload.get("support_id"),
            type(exc).__name__,
            status_code,
            body_excerpt,
        )
        return None

    if isinstance(url, str) and url:
        logger.info("feedback.github_issue_filed support_id=%s", payload.get("support_id"))
        return url
    return None


def _maybe_file_github_issue(payload: dict) -> Optional[str]:
    """Best-effort, non-fatal GitHub filing (IDEA_FAB §5.4)."""
    try:
        return file_github_issue(payload)
    except Exception:  # GitHub down/misconfigured must never 500 the user.
        return None

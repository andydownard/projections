"""app/routers/intent.py — customer intent → CRM (API_SPEC §8.2, PRD §6.1).

Intent is DISTINCT from feedback (IDEA_FAB §0): a separate endpoint, a separate
store, a separate destination (a private CRM). It carries an email + explicit
consent (role, reason, opening timeline, expert-review request, follow-up
consent) but NEVER the projection's financial detail and NO projection link.

CRM delivery is best-effort and graceful-degrades when CRM_API_KEY is unset
(persisted, not sent) — never a 500. Rate-limited per IP (CRM spam brake).
"""
from __future__ import annotations

import re as _re
import secrets

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, field_validator

from app import ratelimit
from app.routers.common import client_ip as _client_ip
from app.routers.common import utcnow as _utcnow
from app.store import Store, get_store

_EMAIL_RE = _re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

router = APIRouter(prefix="/api/intent", tags=["intent"])

_IP_LIMIT_PER_HOUR = 10


class IntentIn(BaseModel):
    email: str
    role: str = ""
    reason: str = ""
    opening_timeline: str = ""
    request_expert_review: bool = False
    follow_up_consent: bool = False

    # never accept a financial field or a slug.
    model_config = ConfigDict(extra="ignore")

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        if not _EMAIL_RE.match(v or ""):
            raise ValueError("invalid email")
        return v


@router.post("", status_code=201)
def submit_intent(
    body: IntentIn,
    request: Request,
    response: Response,
    store: Store = Depends(get_store),  # noqa: B008  FastAPI dependency default (accepted pattern)
):
    allowed, retry_after = ratelimit.check(
        "intent", ip=_client_ip(request), ip_limit=_IP_LIMIT_PER_HOUR
    )
    if not allowed:
        # API_SPEC §2.3 top-level error body (mirrors the feedback path).
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "retry_after_seconds": retry_after,
                "scope": "ip",
            },
            headers={"Retry-After": str(retry_after)},
        )

    crm_payload = {
        "email": str(body.email),
        "role": body.role,
        "reason": body.reason,
        "opening_timeline": body.opening_timeline,
        "request_expert_review": body.request_expert_review,
        "follow_up_consent": body.follow_up_consent,
    }
    crm_status = "sent" if _maybe_send_to_crm(crm_payload) else "pending"

    store.create_intent({
        "id": "int_" + secrets.token_urlsafe(12),
        "email": str(body.email),
        "role": body.role,
        "reason": body.reason,
        "opening_timeline": body.opening_timeline,
        "request_expert_review": int(body.request_expert_review),
        "follow_up_consent": int(body.follow_up_consent),
        "crm_status": crm_status,
        "created_at": _utcnow(),
    })

    return {"received": True}


def send_to_crm(payload: dict):
    """Route an intent to the CRM; degrade to None when CRM_API_KEY is unset.

    The seam the tests stub. Live delivery lands behind this function; v1
    persists locally and returns None when unconfigured (graceful-degrade,
    SECURITY.md §4.2). NO financial field is ever in ``payload``.
    """
    import os

    if not os.environ.get("CRM_API_KEY"):
        return None
    # Live CRM push lands here; persistence already happened router-side.
    return None


def _maybe_send_to_crm(payload: dict):
    try:
        return send_to_crm(payload)
    except Exception:
        return None

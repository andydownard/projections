"""app/routers/gate.py — GET /api/config (CTA seam) + the gated expert-review stub.

``GET /api/config`` exposes the ``{gate_mode, price_usd}`` flag (PRD §3, #85) so
the SPA renders the correct CTA — "Download free" vs "Request expert review — $X"
— with NO client-side price math. The ``POST /api/expert-review`` stub is the ONLY
surface mounted behind the gate dependency; the real expert-review intent endpoint
lands in M6.3 / M2-INTENT (this only exposes the enforcement seam).
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates these annotations at
# runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
from typing import Optional

from fastapi import APIRouter, Depends, Query

from app import config
from app.gate import expert_review_gate

router = APIRouter(prefix="/api", tags=["gate"])


@router.get("/config")
def read_config(cohort: Optional[str] = Query(default=None)) -> dict:
    """Public, unauthenticated read of the price/gate flag for the SPA CTA.

    Resolved per request (no-deploy flip). No auth/secrets (mirrors /api/health).
    ``price_usd`` is non-null only in paid mode — the client renders, never math.
    """
    cfg = config.gate_config(cohort=cohort)
    return {"gate_mode": cfg["gate_mode"], "price_usd": cfg["price_usd"]}


@router.post("/expert-review", status_code=201)
def request_expert_review(gate: dict = Depends(expert_review_gate)) -> dict:  # noqa: B008  FastAPI dependency default (accepted pattern)
    """STUB expert-review / sign-off surface — the ONLY gated surface.

    In ``free`` the gate is open and this acks the request, emitting the gate
    state (mode + cohort + price) for conversion attribution (the A/B seam). In
    ``paid_review`` the dependency raises 402 before this body runs. Real intake
    (CRM, projection link) lands in M6.3 / M2-INTENT.
    """
    return {
        "status": "received",
        "gate": {
            "gate_mode": gate["gate_mode"],
            "price_usd": gate["price_usd"],
            "cohort": gate["cohort"],
        },
    }

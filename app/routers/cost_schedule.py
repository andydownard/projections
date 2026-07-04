"""app/routers/cost_schedule.py — POST /api/cost-schedule/preview (decision #15).

Keeps the formatting + summing authority server-side for the pre-Generate
startup-costs grid (feature #263). The client sends the flat cost-schedule rows it
is editing (``{category, month, amount}``) and renders the server's totals
verbatim — it NEVER sums (NO-CLIENT-MATH / SERVER). The engine sums
(``engine.compute.cost_schedule_totals`` — the one cost-aggregation authority) and
the server formats every aggregate as ``{raw, display}`` via ``engine.money`` (the
one format authority): per-category row totals, per-month column totals, and a
grand total.

Read-only + dormant: no persistence, no projection touched, no ``If-Match`` (it
never mutates), no auth required (the wizard previews this BEFORE a projection
exists). Per-IP rate-limited as the abuse brake. No client wires it yet.
"""
from __future__ import annotations

# ruff: noqa: UP007,UP045 -- keep typing.Optional/Union: Pydantic/FastAPI evaluate
# these annotations at runtime, and PEP 604 (`X | Y`) unions are unsupported on the
# project's Python 3.9 floor (mirrors app/routers/research.py's UP045 suppression).
# `list[CostRow]` is fine — PEP 585 builtin generics work at runtime on 3.9.
from typing import Optional, Union

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import ratelimit
from app.routers.common import client_ip as _client_ip
from engine import compute, model
from engine.money import money_view

router = APIRouter(prefix="/api/cost-schedule", tags=["cost-schedule"])

# Read-only compute (no upstream cost), but called as the user edits the grid, so
# the cap is a coarse per-IP abuse brake on the general-read cadence, not a tight
# cost/spam gate (cf. API_SPEC §2.3 "All other GET" 600 / 5 min).
_IP_LIMIT = 600
_WINDOW_SECONDS = 300


class CostRow(BaseModel):
    category: str = ""
    month: int = 1
    # Accept a JSON number or a numeric string; the engine coerces via D(str(...))
    # so exact Decimal text is preserved (no float poisoning).
    amount: Union[str, float, int] = 0

    class Config:
        extra = "ignore"


class CostSchedulePreviewIn(BaseModel):
    cost_schedule: list[CostRow] = []
    # Optional; ONLY scales the seeded default fallback when no rows are sent.
    building_sqft: Optional[str] = None

    class Config:
        extra = "ignore"


@router.post("/preview")
def preview_cost_schedule(body: CostSchedulePreviewIn, request: Request):
    # Per-IP cap BEFORE any work (Mutation Quad (d) abuse path).
    allowed, retry_after = ratelimit.check(
        "cost_schedule_preview",
        ip=_client_ip(request),
        ip_limit=_IP_LIMIT,
        window_seconds=_WINDOW_SECONDS,
    )
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "retry_after_seconds": retry_after,
                "scope": "ip",
            },
            headers={"Retry-After": str(retry_after)},
        )

    rows = [
        {"category": r.category, "month": r.month, "amount": r.amount}
        for r in body.cost_schedule
    ]
    totals = compute.cost_schedule_totals(rows, building_sqft=body.building_sqft)

    return {
        "rowTotals": [
            {"category": category, "total": money_view(amount)}
            for category, amount in totals["by_category"].items()
        ],
        "columnTotals": [
            {"month": month, "total": money_view(amount)}
            for month, amount in totals["by_month"].items()
        ],
        "grandTotal": money_view(totals["grand_total"]),
        "modelVersion": model.MODEL_VERSION,
        "computeSchemaVersion": model.COMPUTE_SCHEMA_VERSION,
    }

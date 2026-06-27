"""app/gate.py — the business-model gate dependency (PRD §3, issue #85).

A REUSABLE FastAPI dependency that governs ONLY the expert-review / sign-off
surface. In ``free`` mode the gate is OPEN (the request proceeds); in
``paid_review`` mode it is CLOSED — the dependency raises ``402 payment_required``
carrying ``price_usd`` so the SPA renders "Request expert review — $X". Payment
collection (Stripe) is out of scope (#85 / M6.3); flipping ``GATE_MODE`` back to
``free`` removes the gate with no deploy.

The gate is ORTHOGONAL to the terms-acceptance gate (``app/terms.py``): it never
bypasses terms, and terms stay required before export/share in EVERY mode. The
basic ``.xlsx`` + basic packet are NEVER routed through this dependency — they
stay free and ungated (GTM decision; SECURITY.md §3).
"""
from __future__ import annotations

# ruff: noqa: UP045 -- keep typing.Optional: FastAPI evaluates this dependency's
# annotation at runtime, and PEP 604 `X | None` is unsupported on Python 3.9.
from collections.abc import Mapping
from typing import Optional

from fastapi import HTTPException, Query

from app import config


def gate_state(
    cohort: Optional[str] = None, env: Optional[Mapping[str, str]] = None
) -> dict:
    """Resolve the flag into a self-describing state for the SPA + analytics.

    Adds ``gated`` (True iff the expert-review surface is closed) and the
    ``cohort`` to the ``{gate_mode, price_usd}`` flag, so a CTA can render and a
    conversion can be attributed to a mode/cohort (the M-1 A/B seam).
    """
    cfg = config.gate_config(env, cohort=cohort)
    return {
        "gate_mode": cfg["gate_mode"],
        "price_usd": cfg["price_usd"],
        "gated": cfg["gate_mode"] == config.GATE_MODE_PAID,
        "cohort": cohort,
    }


def expert_review_gate(cohort: Optional[str] = Query(default=None)) -> dict:
    """FastAPI dependency for the expert-review / sign-off surface ONLY.

    Returns the open gate state in ``free``; raises ``402 payment_required``
    (carrying ``price_usd`` for the CTA) in ``paid_review``. NEVER applied to the
    basic export surface, which stays free and ungated in every mode.
    """
    state = gate_state(cohort=cohort)
    if state["gated"]:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "payment_required",
                "gate_mode": state["gate_mode"],
                "price_usd": state["price_usd"],
                "cohort": cohort,
            },
        )
    return state

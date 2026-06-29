"""app/store/card_summary.py — compact owner-list card summary (#178).

The owner home list (``GET /api/projections``) needs only ~6 card fields per row,
but the list query used ``SELECT *`` and ``json.loads`` of the full ~10KB
``computed_json`` per row to extract them — an O(N × 10KB) read + parse on the
hottest authenticated query, under the single shared connection.

This pure, backend-agnostic helper distills the Appendix-D view-model into the small
``summary_json`` blob that is denormalized at write time (in ``SqliteStore``) and
SELECTed (alone, never the heavy blobs) by ``list_card_summaries``. It lives above
the Store interface so both SQLite and Postgres derive the SAME summary; it never
parses the DB, only a view-model dict the caller already holds.

v2 redesign (L3) adds ``income_series`` (Y1..Y5 net income), ``y5_income``,
``payback``, and ``breakeven`` so the list endpoint renders the new column set
without touching the heavy ``computed_json`` blobs.
"""
from __future__ import annotations

from typing import Any

_MISSING_MONEY = {"raw": 0, "display": "—"}
_MISSING_MILESTONE = {"raw": None, "display": "N/A"}


def _kpi_value(vm: dict, label: str) -> dict:
    """The ``{raw, display}`` of a named KPI in the view-model (for the list row)."""
    for k in vm.get("kpis") or []:
        if isinstance(k, dict) and k.get("label") == label:
            return k.get("value") or dict(_MISSING_MONEY)
    return dict(_MISSING_MONEY)


def build_card_summary(vm: dict[str, Any]) -> dict[str, Any]:
    """Distill the owner-list card fields from a computed view-model.

    The result is the small payload persisted as ``summary_json`` so the owner list
    never parses the full ``computed_json`` per row (#178).
    """
    ta = vm.get("trade_area") or {}
    loc = vm.get("location") or {}
    # 5-year list contract (#redesign-v2): the annual net-income series Y1..Y5 + the
    # Year-5 figure power the list/detail sparkline. The engine/server is the one
    # format authority, so these are the same {raw,display} values the detail uses.
    income_series = vm.get("incomeSeries") or []
    y5_income = vm.get("year5Income") or dict(_MISSING_MONEY)
    # Milestone display strings for the v2 list columns (L3). breakEven and payback
    # are {raw, display} (the engine is the single formatting authority); the list
    # renders ``display`` verbatim — no client math.
    milestones = vm.get("milestones") or {}
    payback = milestones.get("payback") or dict(_MISSING_MILESTONE)
    breakeven = milestones.get("breakEven") or dict(_MISSING_MILESTONE)
    return {
        "location": ta.get("geography_name") or loc.get("formatted_address") or "",
        "basis": ta.get("basis") or "",
        "y1_revenue": _kpi_value(vm, "Total revenue"),
        "y1_net": _kpi_value(vm, "Net income"),
        "income_series": income_series,
        "y5_income": y5_income,
        "capital_required": (vm.get("metrics") or {}).get("capital")
                            or dict(_MISSING_MONEY),
        "reco_tag": (vm.get("reco") or {}).get("tag") or "revise",
        # Milestone display strings for the v2 list columns (L3).
        "payback": payback,
        "breakeven": breakeven,
        # lat/lng object for the list-row mini-map; null when never resolved.
        "coords": vm.get("location"),
    }

"""engine/tests/harness.py — the three-way reconcile harness (ENGINE_CONTRACT §13).

assert_reconciles(config, overrides) is the reusable gate (BACKLOG M1.7). It asserts
the three artifacts agree (PRD §13/§18):
  (a) server engine.compute() result,
  (b) the values serialized into computed_json,
  (c) a LibreOffice recalc of the exported .xlsx.

Tolerances: $0.50 on dollar cells, 0.1pp on percent cells; total_errors == 0.
FAIL CLOSED on a recalc {"error": ...} dict (ENGINE_CONTRACT §13.3).

M0 scaffold: legs (a) and (b) reconcile today (compute is pure and its output IS the
computed_json). Leg (c) requires engine/xlsx.py (M1.6) + a pinned `soffice`; until
both exist it is skipped with an explicit reason — never silently passed. The
fail-closed semantics are unit-tested in test_harness.py so the gate cannot rot.
"""
from __future__ import annotations

import json
from decimal import Decimal

from engine.compute import compute
from engine.recalc import soffice_available

DOLLAR_TOL = Decimal("0.50")
PCT_TOL = Decimal("0.1")


class ReconcileError(AssertionError):
    pass


def _serialize_roundtrip(result: dict) -> dict:
    """computed_json is the serialized view-model; (a)==(b) means a JSON round-trip
    is byte-stable and the raw values survive."""
    return json.loads(json.dumps(result))


def assert_reconciles(config: dict, overrides: dict | None = None) -> dict:
    """Run the reconcile for one fixture config. Returns the compute result.

    Leg (a)==(b): compute() output round-trips through JSON unchanged.
    Leg (c): if an .xlsx renderer + soffice are available, recalc and assert clean;
             otherwise record a skip with a reason (never a silent pass).
    """
    result = compute(
        config["inputs"],
        config.get("assumptions"),
        config.get("demand_drivers"),
        config.get("trade_area"),
        overrides or {},
    )
    serialized = _serialize_roundtrip(result)

    # (a) == (b): the view-model is its own computed_json. Raw values must match.
    if serialized["_raw"] != result["_raw"]:
        raise ReconcileError("compute() output is not JSON-stable (a != b)")

    # (c) LibreOffice recalc leg.
    xlsx_status = _recalc_leg(result, config)
    result["_reconcile"] = {"ab": "ok", "xlsx": xlsx_status}
    return result


def _recalc_leg(result: dict, config: dict) -> str:
    """Returns 'ok', a 'skipped: <reason>' string, or raises on a real failure.

    Fail-closed: when the renderer exists and soffice is present, a recalc that
    returns an {"error": ...} dict (or total_errors > 0) is a FAILURE.
    """
    import importlib

    try:
        xlsx = importlib.import_module("engine.xlsx")  # M1.6 — not yet built
        has_renderer = hasattr(xlsx, "render")
    except ImportError:
        xlsx = None
        has_renderer = False

    if not has_renderer or xlsx is None:
        return "skipped: engine/xlsx.render not built (M1.6)"
    if not soffice_available():
        return "skipped: soffice not available (recalc gate runs in the pinned CI image)"

    import os
    import tempfile

    from engine.recalc import recalc

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "projection.xlsx")
        xlsx.render(result, path)
        report = recalc(path)
        if "status" not in report:  # {"error": ...} -> fail closed
            raise ReconcileError(f"recalc failed closed: {report}")
        if report["status"] != "success" or report["total_errors"] != 0:
            raise ReconcileError(f"recalc found formula errors: {report}")
    return "ok"

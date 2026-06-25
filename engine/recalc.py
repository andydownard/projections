"""engine/recalc.py — LibreOffice recalc + formula-error gate (ENGINE_CONTRACT §13).

Thin re-export of the pinned reference recalc primitive (the correct gate
primitive per BUILD_PLAN §3 row 23). The golden harness shells out to `soffice`
via this; the CI image pins the LibreOffice version (OPS_RUNBOOK). FAIL CLOSED:
a runner without `soffice` returns {"error": ...} (no "status") and the harness
treats that as a FAILURE, never a pass (ENGINE_CONTRACT §13.3).

This module imports openpyxl/soffice and is therefore NOT imported by compute.py
(the pure core). It belongs to the renderer/gate layer.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

EXCEL_ERRORS = (
    "#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A",
)


def soffice_available() -> bool:
    return shutil.which("soffice") is not None or shutil.which("libreoffice") is not None


def recalc(filename: str, timeout: int = 60) -> dict:
    """Recalculate a workbook with LibreOffice and count formula errors.

    Returns {"status": "success"|"errors_found", "total_errors": int, ...} on a
    successful recalc, or {"error": ...} when soffice is missing / fails. The
    harness MUST assert status=="success" AND total_errors==0, failing closed on
    any {"error": ...}.
    """
    path = Path(filename)
    if not path.exists():
        return {"error": f"File {filename} does not exist"}
    if not soffice_available():
        return {"error": "soffice not available — recalc gate cannot run (fail closed)"}

    soffice = shutil.which("soffice") or shutil.which("libreoffice") or "soffice"
    cmd = [
        soffice, "--headless", "--norestore",
        "--convert-to", "xlsx", "--outdir", str(path.parent), str(path),
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return {"error": "soffice recalc timed out"}

    try:
        from openpyxl import load_workbook
    except ImportError:
        return {"error": "openpyxl not available"}

    wb = load_workbook(filename, data_only=True)
    total_errors = 0
    summary: dict[str, int] = {}
    for sheet in wb.sheetnames:
        ws = wb[sheet]
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str):
                    for err in EXCEL_ERRORS:
                        if err in cell.value:
                            total_errors += 1
                            summary[err] = summary.get(err, 0) + 1
                            break
    wb.close()
    return {
        "status": "success" if total_errors == 0 else "errors_found",
        "total_errors": total_errors,
        "error_summary": summary,
    }

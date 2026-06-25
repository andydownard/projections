"""Import-guard + harness fail-closed tests (M1-IMPORTGUARD, ENGINE_CONTRACT §13.3).

Mechanical proof of the single-math-surface invariant: engine/compute.py imports
NEITHER openpyxl NOR python-docx (ARCHITECTURE §4). And the reconcile harness fails
CLOSED on a recalc error dict.
"""
import ast
from pathlib import Path

import pytest

from engine.tests.harness import ReconcileError, _recalc_leg

COMPUTE = Path(__file__).parents[1] / "compute.py"
MODEL = Path(__file__).parents[1] / "model.py"

FORBIDDEN = {"openpyxl", "docx", "python_docx"}


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    mods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mods.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            mods.add(node.module.split(".")[0])
    return mods


def test_compute_imports_no_excel_or_word():
    mods = _imported_modules(COMPUTE)
    assert FORBIDDEN.isdisjoint(mods), f"forbidden import in compute.py: {mods & FORBIDDEN}"


def test_compute_imports_no_network_or_fs_or_clock():
    mods = _imported_modules(COMPUTE)
    for forbidden in ("requests", "httpx", "socket", "urllib", "datetime", "time", "random"):
        assert forbidden not in mods, f"impure import in compute.py: {forbidden}"


def test_model_is_pure():
    mods = _imported_modules(MODEL)
    assert FORBIDDEN.isdisjoint(mods)


def test_recalc_leg_skips_when_no_renderer():
    # No engine/xlsx.render yet -> explicit skip reason, never a silent pass.
    status = _recalc_leg({"_raw": {}}, {"inputs": {}})
    assert status.startswith("skipped:")


def test_harness_fails_closed_on_error_dict(monkeypatch):
    # Simulate a renderer + soffice present but recalc returning {"error": ...}.
    import engine.tests.harness as h

    class FakeXlsx:
        @staticmethod
        def render(result, path):
            Path(path).write_text("x")

    monkeypatch.setitem(__import__("sys").modules, "engine.xlsx", FakeXlsx)
    monkeypatch.setattr(h, "soffice_available", lambda: True)
    monkeypatch.setattr(h, "recalc", lambda path: {"error": "soffice missing"}, raising=False)
    # Patch the recalc symbol used inside _recalc_leg's local import.
    import engine.recalc as recalc_mod

    monkeypatch.setattr(recalc_mod, "recalc", lambda path: {"error": "soffice missing"})
    with pytest.raises(ReconcileError):
        h._recalc_leg({"_raw": {}}, {"inputs": {}})

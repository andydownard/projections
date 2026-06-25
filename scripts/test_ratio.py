"""Ratio-meter self-test (QA-0). Written RED first.

scripts/ratio.py is the HARD GATE (DEFINITION_OF_DONE.md Tier-2): cloc-based
test-LOC / code-LOC over the DEFINITION_OF_DONE path map. These tests pin the
path-map classification and the gate arithmetic so the meter itself cannot rot.

The self-test builds a throwaway fake repo tree and asserts ratio.py classifies
each file correctly and computes diff + repo-wide ratios with the >1.3 gate.
"""
import json
import subprocess
import sys
from pathlib import Path

RATIO = Path(__file__).resolve().parent / "ratio.py"


def _run(repo_root, *args):
    proc = subprocess.run(
        [sys.executable, str(RATIO), "--root", str(repo_root), "--json", *args],
        capture_output=True,
        text=True,
    )
    return proc


def _make_repo(tmp_path):
    """A minimal fake repo exercising every path-map branch."""
    # CODE (engine/** + app/** minus tests, minus __init__)
    (tmp_path / "engine").mkdir()
    (tmp_path / "engine" / "compute.py").write_text("\n".join(f"a = {i}" for i in range(10)) + "\n")
    (tmp_path / "engine" / "__init__.py").write_text("# excluded: __init__\n")
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "main.py").write_text("\n".join(f"b = {i}" for i in range(5)) + "\n")
    (tmp_path / "app" / "store").mkdir()
    (tmp_path / "app" / "store" / "migrations").mkdir()
    # EXCLUDED: migrations
    (tmp_path / "app" / "store" / "migrations" / "0001_init.py").write_text(
        "\n".join(f"m = {i}" for i in range(99)) + "\n"
    )
    # TEST (engine/tests/**, app/tests/**)
    (tmp_path / "engine" / "tests").mkdir()
    (tmp_path / "engine" / "tests" / "test_compute.py").write_text(
        "\n".join(f"assert {i} == {i}" for i in range(40)) + "\n"
    )
    # EXCLUDED: golden fixtures / .xlsx blobs under tests/golden
    (tmp_path / "engine" / "tests" / "golden").mkdir()
    (tmp_path / "engine" / "tests" / "golden" / "house_of_hope.json").write_text("{}\n")
    (tmp_path / "app" / "tests").mkdir()
    (tmp_path / "app" / "tests" / "test_api.py").write_text(
        "\n".join(f"assert {i}" for i in range(20)) + "\n"
    )
    # TEST (frontend specs) — support both web/ and frontend/
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "src").mkdir()
    (tmp_path / "web" / "src" / "App.test.tsx").write_text(
        "\n".join(f"expect({i}).toBe({i});" for i in range(15)) + "\n"
    )
    # CODE on the frontend is NOT counted as code by the path map (code = engine+app);
    # a non-spec tsx file should be ignored entirely.
    (tmp_path / "web" / "src" / "App.tsx").write_text(
        "\n".join(f"const x{i} = {i};" for i in range(30)) + "\n"
    )
    # TEST (e2e/**)
    (tmp_path / "e2e").mkdir()
    (tmp_path / "e2e" / "happy.spec.ts").write_text(
        "\n".join(f"test('{i}', () => {{}});" for i in range(12)) + "\n"
    )
    return tmp_path


def test_path_map_classification(tmp_path):
    repo = _make_repo(tmp_path)
    proc = _run(repo)
    assert proc.returncode in (0, 1), proc.stderr
    data = json.loads(proc.stdout)
    # code = engine/compute.py (10) + app/main.py (5) = 15
    # __init__.py excluded, migrations excluded, golden excluded,
    # web/App.tsx NOT code (frontend code is not in the code path map).
    assert data["repo"]["code_loc"] == 15, data
    # test = engine tests (40) + app tests (20) + web spec (15) + e2e (12) = 87
    assert data["repo"]["test_loc"] == 87, data
    assert abs(data["repo"]["ratio"] - (87 / 15)) < 1e-6


def test_gate_passes_above_threshold(tmp_path):
    repo = _make_repo(tmp_path)
    proc = _run(repo)
    data = json.loads(proc.stdout)
    assert data["repo"]["ratio"] > 1.3
    assert data["repo"]["pass"] is True
    assert proc.returncode == 0


def test_gate_fails_below_threshold(tmp_path):
    repo = tmp_path
    (repo / "engine").mkdir()
    (repo / "engine" / "compute.py").write_text(
        "\n".join(f"a = {i}" for i in range(100)) + "\n"
    )
    (repo / "engine" / "tests").mkdir()
    (repo / "engine" / "tests" / "test_thin.py").write_text("assert True\n")
    proc = _run(repo)
    data = json.loads(proc.stdout)
    assert data["repo"]["ratio"] < 1.3
    assert data["repo"]["pass"] is False
    assert proc.returncode == 1  # non-zero exit blocks CI


def test_excludes_migrations_and_golden_and_init(tmp_path):
    repo = _make_repo(tmp_path)
    proc = _run(repo)
    data = json.loads(proc.stdout)
    files = {f["path"] for f in data["files"]}
    assert not any("migrations" in p for p in files)
    assert not any("golden" in p for p in files)
    assert not any(p.endswith("__init__.py") for p in files)

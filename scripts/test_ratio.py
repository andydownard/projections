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


def test_excludes_node_modules_and_build_and_report_artifacts(tmp_path):
    """The gate must not be fooled by vendored deps, build output, coverage
    caches, or Playwright's binary report/screenshot artifacts. Each of these
    contains files whose suffix/path would otherwise be misclassified as a
    frontend/e2e *spec* and inflate the test numerator dishonestly.
    """
    repo = _make_repo(tmp_path)

    # Vendored dep specs under e2e/node_modules — must NOT count as tests.
    nm = repo / "e2e" / "node_modules" / "some-lib"
    nm.mkdir(parents=True)
    (nm / "index.test.js").write_text(
        "\n".join(f"it('{i}', () => {{}});" for i in range(500)) + "\n"
    )
    nm2 = repo / "web" / "node_modules" / "dep"
    nm2.mkdir(parents=True)
    (nm2 / "thing.spec.ts").write_text(
        "\n".join(f"expect({i}).toBe({i});" for i in range(500)) + "\n"
    )

    # Build output under web/dist — must NOT count.
    dist = repo / "web" / "dist" / "assets"
    dist.mkdir(parents=True)
    (dist / "bundle.spec.js").write_text(
        "\n".join(f"x={i}" for i in range(500)) + "\n"
    )

    # Coverage / property cache — must NOT count.
    hyp = repo / "engine" / "tests" / ".hypothesis" / "examples"
    hyp.mkdir(parents=True)
    (hyp / "deadbeef.test.py").write_text(
        "\n".join(f"a={i}" for i in range(500)) + "\n"
    )

    # Playwright binary report + screenshot artifacts — must NOT count.
    tr = repo / "e2e" / "test-results" / "run-1"
    tr.mkdir(parents=True)
    # A PNG screenshot (binary) cloc would otherwise tally as "code" lines.
    (tr / "shot-desktop-1440.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50000)
    pr = repo / "e2e" / "playwright-report" / "data"
    pr.mkdir(parents=True)
    (pr / "trace.spec.js").write_text(
        "\n".join(f"y={i}" for i in range(500)) + "\n"
    )

    proc = _run(repo)
    data = json.loads(proc.stdout)
    files = {f["path"] for f in data["files"]}

    assert not any("node_modules" in p for p in files), sorted(files)
    assert not any(("/dist/" in p or p.startswith("dist/") or "/dist" in p)
                   for p in files), sorted(files)
    assert not any(".hypothesis" in p for p in files), sorted(files)
    assert not any("test-results" in p for p in files), sorted(files)
    assert not any("playwright-report" in p for p in files), sorted(files)
    assert not any(p.endswith(".png") for p in files), sorted(files)

    # The honest counts are unchanged from the clean fixture: the dishonest
    # 2500+ artifact lines must have been fully excluded.
    assert data["repo"]["code_loc"] == 15, data
    assert data["repo"]["test_loc"] == 87, data


def test_excludes_venv(tmp_path):
    """A vendored .venv with a thousand 'test' lines must not move the gate."""
    repo = _make_repo(tmp_path)
    venv = repo / "app" / ".venv" / "lib"
    venv.mkdir(parents=True)
    (venv / "test_vendored.py").write_text(
        "\n".join(f"assert {i}" for i in range(1000)) + "\n"
    )
    proc = _run(repo)
    data = json.loads(proc.stdout)
    files = {f["path"] for f in data["files"]}
    assert not any(".venv" in p for p in files), sorted(files)
    assert data["repo"]["test_loc"] == 87, data


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)


def _commit_base(repo):
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True
    )
    return head.stdout.strip()


def test_diff_gate_counts_added_lines_not_whole_files(tmp_path):
    # The diff gate scores LINES ADDED, not whole-file LOC: a behavior-preserving
    # deletion adds no code and must pass (was a false failure under whole-file).
    repo = _make_repo(tmp_path)
    base = _commit_base(repo)
    (repo / "engine" / "compute.py").unlink()  # delete 10 code lines, add nothing
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "delete code")
    data = json.loads(_run(repo, "--diff", base).stdout)
    assert data["diff"]["code_added"] == 0
    assert data["diff"]["pass"] is True


def test_diff_gate_fails_on_untested_added_code(tmp_path):
    # Adding code with no test still fails the diff gate (the gate's real purpose).
    repo = _make_repo(tmp_path)
    base = _commit_base(repo)
    (repo / "engine" / "feature.py").write_text("\n".join(f"z = {i}" for i in range(100)) + "\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "untested code")
    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_added"] == 100
    assert data["diff"]["test_added"] == 0
    assert data["diff"]["pass"] is False
    assert proc.returncode == 1

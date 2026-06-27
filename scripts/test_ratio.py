"""Ratio-meter self-test (QA-0). Written RED first.

scripts/ratio.py is the HARD GATE (DEFINITION_OF_DONE.md Tier-2): cloc-based
test-LOC / code-LOC over the DEFINITION_OF_DONE path map. These tests pin the
path-map classification and the gate arithmetic so the meter itself cannot rot.

The self-test builds a throwaway fake repo tree and asserts ratio.py classifies
each file correctly and computes diff + repo-wide ratios with the >1.3 gate.
"""
import json
import os
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


# ---------------------------------------------------------------------------
# PR-diff leg — measures the ACTUAL added/changed lines, NOT whole-file LOC.
#
# Regression context: the old --diff leg ran cloc over the WHOLE of every
# changed file, so a 15-line edit to the ~1200-line app/routers/projections.py
# scored test/whole-file << 1.3 even with plenty of genuine added tests. That
# false-positive forced #155 and #158 to merge with the gate red. These tests
# build a real throwaway git repo (base commit -> PR commit) and assert the
# diff leg buckets only the ADDED lines of the diff via the same path map.
# ---------------------------------------------------------------------------

_GIT_ENV = {
    "GIT_AUTHOR_NAME": "ratio-test",
    "GIT_AUTHOR_EMAIL": "ratio@example.com",
    "GIT_COMMITTER_NAME": "ratio-test",
    "GIT_COMMITTER_EMAIL": "ratio@example.com",
    # Hermetic: ignore the developer's / CI host's git config entirely.
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def _git(repo, *args):
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        env={**os.environ, **_GIT_ENV},
    )
    assert proc.returncode == 0, (args, proc.stderr)
    return proc


def _lines(n, prefix="x"):
    return "\n".join(f"{prefix}{i} = {i}" for i in range(n)) + "\n"


def _write(repo, rel, n, prefix="x"):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_lines(n, prefix))


def _append(repo, rel, n, prefix="zz"):
    """Append n brand-new lines (distinct prefix) so they are pure additions."""
    p = repo / rel
    p.write_text(p.read_text() + _lines(n, prefix))


def _commit(repo, msg):
    _git(repo, "add", "-A")
    _git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _new_repo(tmp_path):
    _git(tmp_path, "init", "-q")
    return tmp_path


def test_diff_small_edit_to_large_file_with_tests_passes(tmp_path):
    """A 15-line edit to a 1200-line file + 30 added test lines now PASSES.

    Under the old whole-file behavior the 1200-line file dominated the
    denominator and this honest, test-heavy diff failed.
    """
    repo = _new_repo(tmp_path)
    # Large existing code file + generous existing tests keep the repo-wide leg
    # green so the assertion isolates the DIFF leg.
    _write(repo, "engine/big.py", 1200, "a")
    _write(repo, "engine/tests/test_seed.py", 2000, "assert_")
    base = _commit(repo, "base")
    _append(repo, "engine/big.py", 15)               # 15 changed code lines
    _write(repo, "engine/tests/test_new.py", 30, "assert_")  # 30 added test lines
    _commit(repo, "pr")

    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_loc"] == 15, data
    assert data["diff"]["test_loc"] == 30, data
    assert data["diff"]["ratio"] == 30 / 15
    assert data["diff"]["pass"] is True
    assert proc.returncode == 0, proc.stdout


def test_diff_counts_changed_lines_not_whole_file(tmp_path):
    """The diff leg must score the 5 changed lines of a ~1000-line router,
    never the whole 1000-line file (the exact #155/#158 false-positive)."""
    repo = _new_repo(tmp_path)
    _write(repo, "app/routers/projections.py", 1000, "c")
    _write(repo, "app/tests/test_router.py", 2000, "assert_")
    base = _commit(repo, "base")
    _append(repo, "app/routers/projections.py", 5)   # 5 changed code lines
    _write(repo, "app/tests/test_feature.py", 10, "assert_")
    _commit(repo, "pr")

    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_loc"] == 5, data        # NOT 1000
    assert data["diff"]["code_loc"] < 1000
    assert data["diff"]["test_loc"] == 10, data
    assert data["diff"]["ratio"] == 10 / 5
    assert data["diff"]["pass"] is True
    assert proc.returncode == 0, proc.stdout


def test_diff_large_code_addition_without_tests_fails(tmp_path):
    """The gate stays MEANINGFUL: lots of new code, no tests, still FAILS —
    and it is the DIFF leg (not the repo-wide leg) that fails it."""
    repo = _new_repo(tmp_path)
    _write(repo, "engine/seed.py", 10, "a")
    _write(repo, "engine/tests/test_seed.py", 400, "assert_")
    base = _commit(repo, "base")
    _write(repo, "engine/new_feature.py", 100, "b")   # 100 new code lines, 0 tests
    _commit(repo, "pr")

    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_loc"] == 100, data
    assert data["diff"]["test_loc"] == 0, data
    assert data["diff"]["ratio"] < 1.3
    assert data["diff"]["pass"] is False
    assert data["repo"]["pass"] is True, data         # repo-wide is fine
    assert proc.returncode == 1                        # the diff leg blocks CI


def test_diff_ignores_excluded_paths(tmp_path):
    """Migrations, golden fixtures, __init__.py, and non-path-map files (.md)
    contribute ZERO added lines to either bucket."""
    repo = _new_repo(tmp_path)
    _write(repo, "engine/lib.py", 10, "a")
    _write(repo, "engine/tests/test_lib.py", 400, "assert_")
    base = _commit(repo, "base")
    # Genuine small change ...
    _write(repo, "engine/feature.py", 10, "b")
    _write(repo, "engine/tests/test_feature.py", 20, "assert_")
    # ... plus large EXCLUDED churn that must be ignored.
    _write(repo, "app/store/migrations/0002_add.py", 500, "m")  # migrations
    _write(repo, "engine/tests/golden/fixture.json", 500, "g")  # golden + .json
    _write(repo, "engine/__init__.py", 40, "i")                 # __init__
    _write(repo, "README.md", 80, "d")                          # not in path map
    _commit(repo, "pr")

    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_loc"] == 10, data
    assert data["diff"]["test_loc"] == 20, data
    counted = {f["path"] for f in data["diff_files"]}
    assert not any("migrations" in p for p in counted), counted
    assert not any("golden" in p for p in counted), counted
    assert not any(p.endswith("__init__.py") for p in counted), counted
    assert not any(p.endswith(".md") for p in counted), counted
    assert data["diff"]["pass"] is True
    assert proc.returncode == 0, proc.stdout


def test_diff_deletions_and_excluded_only_do_not_fail(tmp_path):
    """A docs-only / pure-deletion diff adds no code lines, so it is not gated
    (no spurious failure when code_loc == 0)."""
    repo = _new_repo(tmp_path)
    _write(repo, "engine/big.py", 200, "a")
    _write(repo, "engine/tests/test_seed.py", 400, "assert_")
    base = _commit(repo, "base")
    # Delete 50 code lines (no additions) and touch only an excluded doc.
    f = repo / "engine" / "big.py"
    f.write_text("\n".join(f.read_text().splitlines()[:150]) + "\n")
    _write(repo, "README.md", 30, "d")
    _commit(repo, "pr")

    proc = _run(repo, "--diff", base)
    data = json.loads(proc.stdout)
    assert data["diff"]["code_loc"] == 0, data
    assert data["diff"]["test_loc"] == 0, data
    assert data["diff"]["pass"] is True
    assert proc.returncode == 0, proc.stdout

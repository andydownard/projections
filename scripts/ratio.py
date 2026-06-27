#!/usr/bin/env python3
"""ratio.py — the HARD test:code ratio gate (DEFINITION_OF_DONE.md Tier-2, QA-0).

test-LOC / code-LOC meter over the DEFINITION_OF_DONE path map. Two independent
legs, both gated at >1.3, paired with engine/** branch coverage >=90% (CI) so the
ratio cannot be gamed by trivial assertions:

  * repo-wide non-regression — cloc over every file in the tree (whole-file LOC),
    so the aggregate test:code density may never fall to/below 1.3.
  * per-PR DIFF — measures the ACTUAL added lines of `git diff <base>...HEAD`
    (numstat), bucketed by the SAME path map. It counts the lines the PR changed,
    NOT the whole LOC of every touched file: a 15-line edit to the ~1200-line
    app/routers/projections.py contributes 15 code lines, not 1200. (The old leg
    measured whole-file LOC and so structurally false-failed small, focused edits
    to large files — forcing #155/#158 to merge red. DECISIONS.md QA-0 always
    intended a per-PR DIFF ratio, i.e. the diff, not whole files.)

Path map (DEFINITION_OF_DONE.md Tier-2 / BACKLOG QA-0):
  code  = engine/** + app/** , minus tests
  test  = engine/tests/**, app/tests/**, {web,frontend}/**/*.{test,spec}.*, e2e/**
  excluded = migrations, generated/golden fixtures (tests/golden/**), golden .xlsx,
             vendored, __init__.py

Repo-wide LOC counting is cloc-based: if the `cloc` binary is present it is used
(per-file, code lines only — comments/blanks excluded). When cloc is unavailable
the meter falls back to an equivalent non-blank, non-pure-comment line counter so
the gate still runs in any CI image. The DIFF leg uses git numstat added-line
counts. The classification (code vs test vs excluded) is identical for both legs.

Usage:
  python scripts/ratio.py                 # repo-wide gate, human output
  python scripts/ratio.py --json          # machine output
  python scripts/ratio.py --diff <base>   # also gate the PR diff vs <base> ref
  python scripts/ratio.py --root <dir>    # operate on a different tree (self-test)
Exit code: 0 if all gated ratios > THRESHOLD, else 1 (CI-blocking).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

THRESHOLD = 1.3

# Frontend spec suffixes (TEST). Frontend roots: web/ (this repo) and frontend/.
FRONTEND_ROOTS = ("web", "frontend")
SPEC_SUFFIXES = (".test.ts", ".test.tsx", ".test.js", ".test.jsx",
                 ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx")
CODE_ROOTS = ("engine", "app")
CODE_SUFFIXES = (".py",)


# Vendored / generated / build / report / cache trees. ANY path component
# matching one of these is excluded — these never contain hand-authored
# test or product code, and several of them (test-results, playwright-report)
# hold binary blobs (.png/.zip/.webm) that cloc would otherwise tally as
# thousands of phantom "code" lines and dishonestly inflate the gate.
_EXCLUDED_DIR_PARTS = frozenset(
    {
        "node_modules",
        "vendor",
        ".venv",
        "venv",
        "dist",
        "build",
        ".hypothesis",
        ".mypy_cache",
        ".pytest_cache",
        "__pycache__",
        ".git",
        "coverage",
        "htmlcov",
        "test-results",
        "playwright-report",
    }
)

# Non-source suffixes that may live under e2e/web roots (screenshots, traces,
# fixtures, lockfiles). Never counted as test or code.
_EXCLUDED_SUFFIXES = frozenset(
    {
        ".xlsx", ".json", ".csv",
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
        ".webm", ".zip", ".gz", ".map", ".lock", ".log", ".txt", ".md",
        ".html", ".css", ".woff", ".woff2", ".ttf",
    }
)


def _is_excluded(rel: Path) -> bool:
    parts = rel.parts
    if rel.name == "__init__.py":
        return True
    if "migrations" in parts:
        return True
    # generated/golden fixtures and golden .xlsx blobs
    if "golden" in parts:
        return True
    if rel.suffix in _EXCLUDED_SUFFIXES:
        return True
    if _EXCLUDED_DIR_PARTS.intersection(parts):
        return True
    return False


def _classify(rel: Path) -> str | None:
    """Return 'code', 'test', or None (ignored) for a repo-relative path."""
    if _is_excluded(rel):
        return None
    parts = rel.parts
    top = parts[0] if parts else ""

    # TEST: e2e/**
    if top == "e2e":
        return "test"
    # TEST: frontend specs
    if top in FRONTEND_ROOTS:
        if rel.name.endswith(SPEC_SUFFIXES):
            return "test"
        return None  # frontend non-spec code is not in the code path map
    # engine/** and app/**
    if top in CODE_ROOTS:
        if rel.suffix not in CODE_SUFFIXES:
            return None
        # tests live under <root>/tests/**
        if "tests" in parts:
            return "test"
        return "code"
    return None


def _cloc_available() -> bool:
    return shutil.which("cloc") is not None


def _count_with_cloc(paths: list[Path]) -> dict[str, int]:
    """Return {abs_path: code_loc} using cloc's per-file JSON report."""
    if not paths:
        return {}
    out: dict[str, int] = {}
    # cloc --by-file --json over the explicit file list.
    proc = subprocess.run(
        ["cloc", "--by-file", "--json", "--quiet", *[str(p) for p in paths]],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        # Fall back if cloc errors on this input.
        return {str(p): _count_lines(p) for p in paths}
    data = json.loads(proc.stdout)
    for key, val in data.items():
        if key in ("header", "SUM"):
            continue
        # cloc keys are file paths (may be prefixed); match by suffix.
        loc = val.get("code", 0)
        out[key] = loc
    # Map cloc's reported keys back to our absolute paths.
    resolved: dict[str, int] = {}
    for p in paths:
        sp = str(p)
        if sp in out:
            resolved[sp] = out[sp]
        else:
            # cloc may report a normalized/relative key; match by name+parent.
            match = next(
                (v for k, v in out.items() if Path(k).name == p.name and k.endswith(p.name)),
                None,
            )
            resolved[sp] = match if match is not None else _count_lines(p)
    return resolved


def _count_lines(path: Path) -> int:
    """cloc-equivalent fallback: non-blank, non-pure-comment lines."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0
    count = 0
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#") or s.startswith("//"):
            continue
        count += 1
    return count


def _gather(root: Path) -> list[tuple[Path, str]]:
    """Walk the tree, returning [(abs_path, 'code'|'test')]."""
    results: list[tuple[Path, str]] = []
    for top in (*CODE_ROOTS, *FRONTEND_ROOTS, "e2e"):
        base = root / top
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            kind = _classify(rel)
            if kind:
                results.append((p, kind))
    return results


def _measure(root: Path, paths: list[tuple[Path, str]]) -> dict:
    code_files = [p for p, k in paths if k == "code"]
    test_files = [p for p, k in paths if k == "test"]
    if _cloc_available():
        counts = _count_with_cloc(code_files + test_files)
    else:
        counts = {str(p): _count_lines(p) for p, _ in paths}
    code_loc = sum(counts.get(str(p), 0) for p in code_files)
    test_loc = sum(counts.get(str(p), 0) for p in test_files)
    ratio = (test_loc / code_loc) if code_loc else float("inf")
    files = [
        {"path": str(p.relative_to(root)), "kind": k, "loc": counts.get(str(p), 0)}
        for p, k in sorted(paths, key=lambda t: str(t[0]))
    ]
    return {
        "code_loc": code_loc,
        "test_loc": test_loc,
        "ratio": ratio,
        "pass": code_loc == 0 or ratio > THRESHOLD,
        "files": files,
    }


def _strip_rename(path: str) -> str:
    """Normalize a git-numstat path that encodes a rename to its NEW path.

    numstat renders a rename as ``old => new`` — optionally with a ``{a => b}``
    brace group inside a shared prefix/suffix (``dir/{old => new}/f.py``). We
    classify the destination path.
    """
    if " => " not in path:
        return path
    if "{" in path and "}" in path:
        pre, rest = path.split("{", 1)
        mid, post = rest.split("}", 1)
        new = mid.split(" => ", 1)[1]
        return f"{pre}{new}{post}"
    return path.split(" => ", 1)[1]


def _diff_measure(root: Path, base_ref: str) -> dict:
    """Measure ONLY the added/changed lines of the diff vs base_ref.

    Uses ``git diff --numstat <base>...HEAD`` (added lines per changed file) and
    buckets the added lines into test / code / excluded via the SAME path map as
    the repo-wide leg. Whole-file LOC is deliberately ignored: a 15-line edit to
    a 1200-line file contributes 15 lines, not 1200 — the per-PR DIFF ratio that
    DECISIONS.md (QA-0) intends. diff_ratio = added_test / max(added_code, 1).
    """
    proc = subprocess.run(
        ["git", "-C", str(root), "diff", "--numstat", f"{base_ref}...HEAD"],
        capture_output=True,
        text=True,
    )
    code_loc = 0
    test_loc = 0
    files: list[dict] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added_s, _deleted_s, raw_path = parts[0], parts[1], "\t".join(parts[2:])
        if added_s == "-":
            continue  # binary file (numstat reports '-'): never test/code LOC
        try:
            added = int(added_s)
        except ValueError:
            continue
        rel = Path(_strip_rename(raw_path))
        kind = _classify(rel)
        if kind == "code":
            code_loc += added
        elif kind == "test":
            test_loc += added
        else:
            continue  # excluded / not in the path map
        files.append({"path": str(rel), "kind": kind, "added": added})
    ratio = test_loc / max(code_loc, 1)
    return {
        "code_loc": code_loc,
        "test_loc": test_loc,
        "ratio": ratio,
        # A diff that adds no code (docs-only, pure deletion, excluded-only) is
        # never a failure — the gate only bites when new code lands.
        "pass": code_loc == 0 or ratio > THRESHOLD,
        "files": files,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=f"test:code ratio gate (>{THRESHOLD:.1f})"
    )
    ap.add_argument("--root", default=".", help="repo root to measure")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--diff", metavar="BASE_REF", help="also gate the diff vs BASE_REF")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    all_paths = _gather(root)
    repo = _measure(root, all_paths)

    overall_pass = repo["pass"]
    result: dict = {"threshold": THRESHOLD, "repo": {k: v for k, v in repo.items() if k != "files"},
                    "files": repo["files"]}

    if args.diff:
        diff = _diff_measure(root, args.diff)
        result["diff"] = {k: v for k, v in diff.items() if k != "files"}
        result["diff_files"] = diff["files"]
        # An empty/excluded-only diff (no code added) does not gate.
        if diff["code_loc"] > 0:
            overall_pass = overall_pass and diff["pass"]

    result["pass"] = overall_pass

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        r = repo["ratio"]
        rr = "inf" if r == float("inf") else f"{r:.3f}"
        print(f"test:code ratio (repo-wide): {rr}  "
              f"[test={repo['test_loc']} / code={repo['code_loc']}]  "
              f"threshold>{THRESHOLD}  -> {'PASS' if repo['pass'] else 'FAIL'}")
        if "diff" in result:
            d = result["diff"]
            print(f"test:code ratio (PR diff):   {d['ratio']:.3f}  "
                  f"[+test={d['test_loc']} / +code={d['code_loc']} lines]  "
                  f"threshold>{THRESHOLD}  -> {'PASS' if d['pass'] else 'FAIL'}")
        print(f"cloc: {'binary' if _cloc_available() else 'fallback line-counter'}")

    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())

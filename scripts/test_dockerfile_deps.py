"""CI guard: the Dockerfile's runtime pip-install list must cover EVERY runtime
dependency declared in pyproject [project.dependencies].

The prod image installs a hardcoded list (it does not `pip install .`), so a new
runtime dep added to pyproject but not to the Dockerfile ships an image that
crashes on `import` at boot — exactly what happened when `bleach` was added to
pyproject (#77) but not to the Dockerfile, crash-looping a prod deploy. CI never
builds the Docker image, so this static check is the thing that catches the drift.
"""
from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent


def _norm(dep: str) -> str:
    """'fastapi>=0.110' -> 'fastapi'; 'uvicorn[standard]' -> 'uvicorn'."""
    name = re.split(r"[<>=!~;\[\(\s]", dep.strip().strip('"').strip("'"), maxsplit=1)[0]
    return name.strip().lower().replace("_", "-")


def _pyproject_runtime_deps() -> set[str]:
    text = (_ROOT / "pyproject.toml").read_text()
    # match to the closing ']' on its OWN line, so the ']' inside "uvicorn[standard]"
    # (mid-line) does not terminate the block early.
    block = re.search(r"^dependencies\s*=\s*\[(.*?)^\]", text, re.S | re.M)
    assert block, "pyproject.toml [project.dependencies] not found"
    deps = re.findall(r'"([^"]+)"', block.group(1))
    assert "bleach" in {_norm(d) for d in deps}, (
        "sanity: parser should see bleach in pyproject deps"
    )
    return {_norm(d) for d in deps if d.strip()}


def _dockerfile_pip_installs() -> set[str]:
    lines = (_ROOT / "Dockerfile").read_text().splitlines()
    # find the runtime python `pip install` RUN, joining '\'-continued lines.
    collected = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        if "pip install" in line and "--no-cache-dir" in line:
            buf = line
            while buf.rstrip().endswith("\\") and i + 1 < len(lines):
                i += 1
                buf = buf.rstrip()[:-1] + " " + lines[i]
            collected = buf
            break
        i += 1
    assert collected, "Dockerfile runtime `pip install --no-cache-dir` line not found"
    out = set()
    for t in re.findall(r'"[^"]+"|\S+', collected):
        n = _norm(t)
        if n and n not in {"run", "pip", "install", "--no-cache-dir"}:
            out.add(n)
    return out


def test_dockerfile_installs_all_pyproject_runtime_deps():
    pyproject = _pyproject_runtime_deps()
    docker = _dockerfile_pip_installs()
    missing = pyproject - docker
    assert not missing, (
        f"Dockerfile is missing runtime deps declared in pyproject: {sorted(missing)}. "
        f"Add them to the `RUN pip install` line in the Dockerfile so the prod image "
        f"doesn't crash on import at boot. pyproject runtime={sorted(pyproject)} "
        f"dockerfile={sorted(docker)}"
    )

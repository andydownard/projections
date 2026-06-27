"""scripts/promote.py — fail-closed deploy promotion gate (OPS_RUNBOOK §7.1 / DoD).

A deploy is NOT done until ``GET <base>/api/health`` proves the NEW build is live.
This gate polls the health endpoint and accepts the promote ONLY when the response
shows ALL of:

  - HTTP 200 with a JSON object body,
  - ``build_sha`` == the expected (just-pushed) SHA — a bare 200 from the OLD build
    is refused (timpager regressions #15/#52/#87),
  - ``db`` == ``"connected"``,
  - ``litestream`` == ``"replicating"``.

It polls until the new SHA appears or the attempt budget is exhausted, then exits
non-zero. Fail-closed: any ambiguity (missing field, wrong SHA, db down, replication
off, non-JSON, non-200, fetch error) refuses the promote.

    python -m scripts.promote --base-url $STAGING_URL --sha $GIT_SHA
    python -m scripts.promote --base-url $PROD_URL --sha $GIT_SHA --attempts 60 --delay 10
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

# A health response that promote will accept must match all of these.
_REQUIRED_DB = "connected"
_REQUIRED_LITESTREAM = "replicating"


def evaluate_health(payload: Any, expected_sha: str) -> tuple[bool, str]:
    """Return (accept, reason). Fail-closed on anything other than a clean new build."""
    if not isinstance(payload, dict):
        return False, "health body was not a JSON object"
    sha = payload.get("build_sha")
    if not sha:
        return False, "health response has no build_sha (a bare 200 is not acceptance)"
    if sha != expected_sha:
        return False, (
            f"old build still live: build_sha={sha!r} != expected {expected_sha!r}"
        )
    db = payload.get("db")
    if db != _REQUIRED_DB:
        return False, f"db not ready: db={db!r} (want {_REQUIRED_DB!r})"
    litestream = payload.get("litestream")
    if litestream != _REQUIRED_LITESTREAM:
        return False, (
            f"litestream not replicating: litestream={litestream!r} "
            f"(want {_REQUIRED_LITESTREAM!r})"
        )
    return True, (
        f"new build live: build_sha={sha} db={_REQUIRED_DB} "
        f"litestream={_REQUIRED_LITESTREAM}"
    )


def fetch_health(base_url: str, *, timeout: float = 5.0) -> tuple[int, Any]:
    """GET <base>/api/health -> (status_code, parsed_json_or_None). Never raises HTTPError."""
    url = base_url.rstrip("/") + "/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, None
    try:
        return status, json.loads(raw)
    except (json.JSONDecodeError, ValueError, TypeError):
        return status, None


def promote(
    base_url: str,
    expected_sha: str,
    *,
    fetch: Callable[[str], tuple[int, Any]] | None = None,
    attempts: int = 30,
    delay: float = 10.0,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[bool, str]:
    """Poll health until the NEW build is proven live, else refuse (fail-closed)."""
    # Resolve the module-level fetcher at call time so it stays monkeypatchable.
    if fetch is None:
        fetch = fetch_health
    last = "no health attempt made"
    for attempt in range(attempts):
        try:
            status, payload = fetch(base_url)
        except Exception as exc:  # network/DNS/timeout: keep polling, refuse at the end
            last = f"health fetch error: {exc}"
        else:
            if status != 200:
                last = f"health returned HTTP {status} (old instance or not ready)"
            else:
                ok, reason = evaluate_health(payload, expected_sha)
                if ok:
                    return True, reason
                last = reason
        if attempt < attempts - 1:
            sleep(delay)
    return False, f"PROMOTE REFUSED after {attempts} attempt(s): {last}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail-closed promote gate: verify /api/health shows the NEW build SHA."
    )
    parser.add_argument("--base-url", required=True,
                        help="base URL of the environment to verify (e.g. https://staging...)")
    parser.add_argument("--sha", required=True,
                        help="expected NEW build SHA (the just-pushed commit)")
    parser.add_argument("--attempts", type=int, default=30,
                        help="max health polls before refusing (default 30)")
    parser.add_argument("--delay", type=float, default=10.0,
                        help="seconds between polls (default 10)")
    args = parser.parse_args(argv)
    ok, reason = promote(
        args.base_url, args.sha, attempts=args.attempts, delay=args.delay
    )
    print(("PROMOTE OK: " if ok else "") + reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

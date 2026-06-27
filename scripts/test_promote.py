"""Tests for scripts/promote.py — the fail-closed promote gate.

OPS_RUNBOOK §7.1 / DEFINITION_OF_DONE: a deploy is NOT done until ``GET /api/health``
returns the NEW build SHA (plus db connected + litestream replicating). A bare 200
from the OLD instance is not acceptance (timpager regressions #15/#52/#87). The gate
is fail-closed: any ambiguity (wrong/missing SHA, db down, replication off, non-JSON,
non-200, fetch error) refuses the promote.
"""
from __future__ import annotations

import pytest

import scripts.promote as promote

# ---- evaluate_health: the acceptance predicate (matrix) ----

def _health(sha="newsha", db="connected", litestream="replicating"):
    body = {"status": "ok", "model_version": "2.1.0"}
    if sha is not None:
        body["build_sha"] = sha
    if db is not None:
        body["db"] = db
    if litestream is not None:
        body["litestream"] = litestream
    return body


def test_accept_when_new_sha_db_ok_replicating():
    ok, reason = promote.evaluate_health(_health(sha="newsha"), "newsha")
    assert ok is True
    assert "newsha" in reason


def test_reject_old_sha():
    ok, reason = promote.evaluate_health(_health(sha="oldsha"), "newsha")
    assert ok is False
    assert "old build" in reason.lower()


def test_reject_missing_sha_bare_200():
    ok, reason = promote.evaluate_health(_health(sha=None), "newsha")
    assert ok is False
    assert "build_sha" in reason


def test_reject_db_not_connected():
    ok, reason = promote.evaluate_health(_health(db="unavailable"), "newsha")
    assert ok is False
    assert "db" in reason.lower()


def test_reject_litestream_not_replicating():
    ok, reason = promote.evaluate_health(_health(litestream="disabled"), "newsha")
    assert ok is False
    assert "litestream" in reason.lower()


@pytest.mark.parametrize("payload", [None, [], "ok", 200])
def test_reject_non_object_payload(payload):
    ok, reason = promote.evaluate_health(payload, "newsha")
    assert ok is False


# ---- promote(): polling + fail-closed retry ----

def test_promote_succeeds_immediately_on_new_sha():
    def fetch(_url):
        return 200, _health(sha="newsha")

    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=3, delay=0, sleep=lambda _d: None)
    assert ok is True
    assert "newsha" in reason


def test_promote_polls_until_new_sha_appears():
    seq = [(200, _health(sha="oldsha")),
           (200, _health(sha="oldsha")),
           (200, _health(sha="newsha"))]
    calls = {"i": 0}

    def fetch(_url):
        r = seq[calls["i"]]
        calls["i"] += 1
        return r

    slept: list = []
    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=5, delay=2, sleep=lambda d: slept.append(d))
    assert ok is True
    assert calls["i"] == 3          # stopped as soon as the new SHA showed
    assert slept == [2, 2]          # slept between the two failed polls only


def test_promote_refuses_when_old_sha_never_flips():
    def fetch(_url):
        return 200, _health(sha="oldsha")

    slept: list = []
    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=3, delay=1, sleep=lambda d: slept.append(d))
    assert ok is False
    assert "REFUSED" in reason
    assert "old build" in reason.lower()
    # slept between attempts but not after the final one
    assert slept == [1, 1]


def test_promote_refuses_on_non_200():
    def fetch(_url):
        return 503, None

    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=2, delay=0, sleep=lambda _d: None)
    assert ok is False
    assert "503" in reason


def test_promote_fails_closed_on_fetch_exception():
    def fetch(_url):
        raise OSError("connection refused")

    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=2, delay=0, sleep=lambda _d: None)
    assert ok is False
    assert "REFUSED" in reason


def test_promote_refuses_when_db_down_even_with_new_sha():
    def fetch(_url):
        return 200, _health(sha="newsha", db="unavailable")

    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=2, delay=0, sleep=lambda _d: None)
    assert ok is False
    assert "db" in reason.lower()


def test_promote_refuses_when_replication_off_even_with_new_sha():
    def fetch(_url):
        return 200, _health(sha="newsha", litestream="disabled")

    ok, reason = promote.promote("http://x", "newsha", fetch=fetch,
                                 attempts=2, delay=0, sleep=lambda _d: None)
    assert ok is False
    assert "litestream" in reason.lower()


# ---- main(): exit codes ----

def test_main_exit_zero_on_accept(monkeypatch, capsys):
    monkeypatch.setattr(promote, "fetch_health",
                        lambda _u, **_k: (200, _health(sha="abc123")))
    rc = promote.main(["--base-url", "http://x", "--sha", "abc123",
                       "--attempts", "1", "--delay", "0"])
    assert rc == 0
    assert "PROMOTE OK" in capsys.readouterr().out


def test_main_exit_one_on_refuse(monkeypatch, capsys):
    monkeypatch.setattr(promote, "fetch_health",
                        lambda _u, **_k: (200, _health(sha="oldsha")))
    rc = promote.main(["--base-url", "http://x", "--sha", "newsha",
                       "--attempts", "1", "--delay", "0"])
    assert rc == 1
    out = capsys.readouterr().out
    assert "REFUSED" in out


def test_fetch_health_parses_json(monkeypatch):
    # fetch_health uses a urlopen-like callable; assert it returns (status, dict).
    class FakeResp:
        status = 200

        def read(self):
            return b'{"build_sha": "z", "db": "connected", "litestream": "replicating"}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(promote.urllib.request, "urlopen", lambda _u, timeout=0: FakeResp())
    status, payload = promote.fetch_health("http://x")
    assert status == 200
    assert payload["build_sha"] == "z"


def test_fetch_health_returns_none_on_non_json(monkeypatch):
    class FakeResp:
        status = 200

        def read(self):
            return b"<html>not json</html>"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(promote.urllib.request, "urlopen", lambda _u, timeout=0: FakeResp())
    status, payload = promote.fetch_health("http://x")
    assert status == 200
    assert payload is None

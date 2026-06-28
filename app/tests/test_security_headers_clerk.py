"""CLERK_ENABLED-gated CSP widening for the Clerk satellite FAPI (SECURITY.md §8.2).

projections ships an enforcing, ``'self'``-only, no-inline CSP (SECURITY.md §8.1).
Turning the Clerk satellite on requires widening ``script-src``/``connect-src``/
``img-src``/``frame-src``/``worker-src`` to the Clerk Frontend-API origins so
clerk-js can load and run — a named, signed-off relaxation that is **gated on the
``CLERK_ENABLED`` kill switch**. With Clerk OFF (the default) the CSP must stay
**byte-for-byte** the strict baseline it is today (no relaxation, no new surface).

These tests assert BOTH states: the strict baseline when off, the Clerk origins
when on, at the ``build_csp`` unit level AND on the live response header.
"""
from fastapi.testclient import TestClient

from app.middleware import CSP, build_csp

# The exact Clerk origins the widening must allow (SECURITY.md §8.2, plan §2A.3).
SATELLITE_FAPI = "https://clerk.thriftly.com"
CLERK_ACCOUNTS_DEV = "https://*.clerk.accounts.dev"
CLERK_JS_CDN = "https://*.clerk.com"
TURNSTILE = "https://challenges.cloudflare.com"
IMG_CLERK = "https://img.clerk.com"
IMG_CLERK_DEV = "https://images.clerk.dev"

# Every Clerk/Turnstile origin token — none may appear when the switch is off.
ALL_CLERK_ORIGINS = (
    "clerk.thriftly.com",
    "clerk.accounts.dev",
    "*.clerk.com",
    "img.clerk.com",
    "images.clerk.dev",
    "challenges.cloudflare.com",
)


def _directives(csp: str) -> dict:
    """Parse a CSP header string into ``{directive: [source, ...]}``."""
    out: dict = {}
    for clause in csp.split(";"):
        clause = clause.strip()
        if not clause:
            continue
        name, _, rest = clause.partition(" ")
        out[name] = rest.split()
    return out


def _client(monkeypatch, **env) -> TestClient:
    monkeypatch.setenv("APP_ENV", "test")
    for key, val in env.items():
        monkeypatch.setenv(key, val)
    from app.main import create_app

    return TestClient(create_app())


# --- build_csp unit: OFF is byte-identical to today's strict baseline ----------
def test_build_csp_off_is_byte_identical_to_strict_baseline():
    # No env, explicit off, and unknown values all collapse to the strict CSP.
    assert build_csp({}) == CSP
    assert build_csp({"CLERK_ENABLED": ""}) == CSP
    assert build_csp({"CLERK_ENABLED": "0"}) == CSP
    assert build_csp({"CLERK_ENABLED": "false"}) == CSP
    assert build_csp({"CLERK_ENABLED": "maybe"}) == CSP


def test_build_csp_off_leaks_no_clerk_origin():
    off = build_csp({})
    for origin in ALL_CLERK_ORIGINS:
        assert origin not in off, f"{origin} leaked into the strict (off) CSP"


# --- build_csp unit: ON widens exactly the right directives --------------------
def test_build_csp_on_keeps_the_hardening_baseline():
    on = build_csp({"CLERK_ENABLED": "1"})
    d = _directives(on)
    # The default-deny posture and clickjacking/abuse hardening are preserved.
    assert d["default-src"] == ["'self'"]
    assert d["object-src"] == ["'none'"]
    assert d["base-uri"] == ["'self'"]
    assert d["frame-ancestors"] == ["'none'"]
    assert d["form-action"] == ["'self'"]
    # No blanket inline-script relaxation — the XSS posture is unchanged.
    assert "'unsafe-inline'" not in on


def test_build_csp_on_widens_script_src_for_clerk_js():
    d = _directives(build_csp({"CLERK_ENABLED": "1"}))
    script = d["script-src"]
    assert "'self'" in script
    assert SATELLITE_FAPI in script
    assert CLERK_ACCOUNTS_DEV in script
    assert CLERK_JS_CDN in script
    assert TURNSTILE in script  # Turnstile bot-check script


def test_build_csp_on_widens_connect_src_for_fapi():
    d = _directives(build_csp({"CLERK_ENABLED": "1"}))
    connect = d["connect-src"]
    assert "'self'" in connect  # our own API is still same-origin
    assert SATELLITE_FAPI in connect
    assert CLERK_ACCOUNTS_DEV in connect
    assert CLERK_JS_CDN in connect


def test_build_csp_on_widens_img_src_for_avatars():
    d = _directives(build_csp({"CLERK_ENABLED": "1"}))
    img = d["img-src"]
    assert "'self'" in img
    assert "data:" in img
    assert IMG_CLERK in img
    assert IMG_CLERK_DEV in img


def test_build_csp_on_adds_frame_src_for_fapi_and_turnstile():
    d = _directives(build_csp({"CLERK_ENABLED": "1"}))
    assert "frame-src" in d
    frame = d["frame-src"]
    assert SATELLITE_FAPI in frame
    assert TURNSTILE in frame


def test_build_csp_on_adds_worker_src_blob():
    d = _directives(build_csp({"CLERK_ENABLED": "1"}))
    assert "worker-src" in d
    assert "'self'" in d["worker-src"]
    assert "blob:" in d["worker-src"]


# --- live response header: both states on a real response ----------------------
def test_response_header_off_is_strict_baseline(monkeypatch):
    client = _client(monkeypatch)  # Clerk unset => off (today's behavior)
    csp = client.get("/api/health").headers.get("content-security-policy", "")
    assert csp == CSP
    assert "connect-src 'self'" in csp
    for origin in ALL_CLERK_ORIGINS:
        assert origin not in csp


def test_response_header_on_includes_clerk_origins(monkeypatch):
    client = _client(monkeypatch, CLERK_ENABLED="1")
    csp = client.get("/api/health").headers.get("content-security-policy", "")
    assert csp != CSP  # it really did widen
    assert SATELLITE_FAPI in csp
    assert CLERK_ACCOUNTS_DEV in csp
    assert CLERK_JS_CDN in csp
    assert IMG_CLERK in csp
    assert IMG_CLERK_DEV in csp
    assert TURNSTILE in csp
    # The hardening baseline rides along unchanged.
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "'unsafe-inline'" not in csp


def test_kill_switch_flips_without_restart(monkeypatch):
    # The CSP is read at request time (kill-switch contract), so flipping
    # CLERK_ENABLED takes effect on the next request with no app rebuild.
    client = _client(monkeypatch)
    off = client.get("/api/health").headers["content-security-policy"]
    assert off == CSP
    monkeypatch.setenv("CLERK_ENABLED", "1")
    on = client.get("/api/health").headers["content-security-policy"]
    assert SATELLITE_FAPI in on
    monkeypatch.setenv("CLERK_ENABLED", "0")
    back = client.get("/api/health").headers["content-security-policy"]
    assert back == CSP

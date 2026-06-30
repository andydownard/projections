"""app/middleware.py — enforcing CSP / noindex / HSTS on EVERY response.

SECURITY.md §8. Greenfield SPA, no inline-script debt => enforcing CSP from day
one (not Report-Only), no 'unsafe-inline' in script-src. The browser talks ONLY to
our own API (same origin) — all AI is server-proxied (hard rule 7; the browser
calls /penny, never a provider), and Places/Census/GitHub/CRM are server-to-server
only — so connect-src is locked to 'self'. The provider origins were dropped
(issue #167): listing api.anthropic.com / api.openai.com only widened the post-XSS
exfil / SSRF-pivot surface for no functional reason (no client-side provider call
exists). If a genuine client-side provider call is ever added, re-add it then.
"""
from __future__ import annotations

from collections.abc import Mapping

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.config import clerk_enabled

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)

# --- Clerk satellite CSP widening (SECURITY.md §8.2, gated on CLERK_ENABLED) ----
# When the Clerk satellite is ON, clerk-js must load from and talk to the satellite
# Frontend API (`https://clerk.thriftly.com`, the registered `clerk.thriftly.com`
# CNAME), Clerk dev instances (`*.clerk.accounts.dev`), Clerk's clerk-js host
# (`*.clerk.com`), and — when bot-protection is on — Cloudflare Turnstile. Avatars
# come from img.clerk.com / images.clerk.dev; the cross-domain session-sync iframe is
# framed from the FAPI; clerk-js spins a `blob:` worker. jsdelivr is intentionally
# NOT allowlisted: @clerk/clerk-react v5 is Vite-bundled and loads clerk-js from the
# FAPI host, not a public CDN; the cross-apex handshake to the primary (rallytasks.com)
# is a top-level navigation, not a subresource, so the primary's origins are not
# needed in script/connect/frame-src either.
_CLERK_FAPI = "https://clerk.thriftly.com"  # the registered satellite FAPI CNAME
_CLERK_ACCOUNTS_DEV = "https://*.clerk.accounts.dev"  # Clerk dev instances
_CLERK_JS = "https://*.clerk.com"  # clerk-js host
_TURNSTILE = "https://challenges.cloudflare.com"  # Clerk bot-check (Turnstile)
_CLERK_IMG_A = "https://img.clerk.com"  # avatars
_CLERK_IMG_B = "https://images.clerk.dev"  # avatars (legacy host)

# The widened CSP used ONLY when CLERK_ENABLED is truthy. Every hardening directive
# from the strict baseline is preserved verbatim; the Clerk origins are added to
# script/connect/img and the two directives clerk-js needs (frame-src, worker-src).
# style-src also gains 'unsafe-inline': Clerk's prebuilt components (the <UserProfile>
# opened by clerk.openUserProfile() — the account "Manage" modal) inject runtime
# CSS-in-JS, which a 'self'-only style-src blocks, leaving the modal a broken,
# interaction-trapping overlay (the "Manage freezes the app" bug). Clerk's CSP guide
# REQUIRES 'unsafe-inline' here. This relaxes inline *styles* only — script-src stays
# inline-free, so the XSS/exfil posture is unchanged — and it is gated on CLERK_ENABLED
# (SECURITY.md §8.2); the strict off-baseline keeps style-src locked to 'self'.
CLERK_CSP = (
    "default-src 'self'; "
    f"script-src 'self' {_CLERK_FAPI} {_CLERK_ACCOUNTS_DEV} {_CLERK_JS} {_TURNSTILE}; "
    "style-src 'self' 'unsafe-inline'; "
    f"img-src 'self' data: {_CLERK_IMG_A} {_CLERK_IMG_B}; "
    "font-src 'self'; "
    f"connect-src 'self' {_CLERK_FAPI} {_CLERK_ACCOUNTS_DEV} {_CLERK_JS}; "
    "object-src 'none'; "
    "base-uri 'self'; "
    f"frame-src 'self' {_CLERK_FAPI} {_CLERK_ACCOUNTS_DEV} {_TURNSTILE}; "
    "worker-src 'self' blob:; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)


def build_csp(env: Mapping[str, str] | None = None) -> str:
    """The CSP for this deployment, gated on the CLERK_ENABLED kill switch.

    Off/unset (the default) ⇒ the strict ``'self'``-only baseline, byte-for-byte
    identical to the app today. On ⇒ the Clerk-widened policy. Read at call time so
    flipping ``CLERK_ENABLED`` takes effect on the next request with no restart.
    """
    return CLERK_CSP if clerk_enabled(env) else CSP


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = build_csp()
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
        return response

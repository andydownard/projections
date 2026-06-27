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

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

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


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
        return response

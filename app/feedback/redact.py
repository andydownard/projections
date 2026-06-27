"""app/feedback/redact.py — the pure feedback redactor (IDEA_FAB §3.3, PRD §22).

The product's #1 data-leak risk. Every string that will reach GitHub passes
through here BEFORE it is persisted or filed (one redacted artifact). The
function is pure and deterministic so it is unit-tested in isolation; the
router-level Tier-1 leak test then proves the assembled payload is clean.

Pipeline (in order):
  1. Strip injection markers (`ignore previous instructions`, `system:`).
  2. Strip raw HTML / Markdown that could be active in a rendered issue.
  3. Strip secrets-shaped tokens (Bearer prefixes, high-entropy urlsafe blobs,
     recovery-code patterns).
  4. Strip resolvable projection links and any occurrence of the request's own
     view_slug (belt-and-suspenders even if a client bug puts it there).
  5. Strip financial figures ($-amounts and bare percentages).
  6. Truncate to the §3.2 caps.

The redactor is ALSO the single chokepoint that assembles the auto-context dict
(`build_safe_context`). The context that reaches GitHub and the persisted row is
built from a strict server-side ALLOWLIST: client-supplied `model_version` and
`type` are IGNORED (model_version is stamped from the server; `type` is coerced
to a closed enum); `route` is slug/fragment-stripped; nothing else survives
(#201 — client free-text must never bypass redaction into either sink).
"""
from __future__ import annotations

import re

# §3.2 caps.
TITLE_CAP = 120
DESCRIPTION_CAP = 4000

# §9 redaction allowlist: the ONLY context keys that may ever leave the server
# (into the GitHub issue) or be persisted in `feedback.context_json`. Anything
# not on this list is dropped — there is no client-context passthrough.
SAFE_CONTEXT_KEYS = ("route", "app_version", "model_version", "type", "ts")

# Feedback `type` is a closed, server-controlled enum — NEVER client free-text.
# A client may suggest a category, but the value that lands in either sink is
# always one of these literals (unknown/garbage -> DEFAULT_FEEDBACK_TYPE).
FEEDBACK_TYPES = ("bug", "idea", "other")
DEFAULT_FEEDBACK_TYPE = "other"

# Injection markers neutralized before the text is ever rendered in an issue.
_INJECTION_MARKERS = (
    r"ignore\s+previous\s+instructions",
    r"ignore\s+all\s+previous\s+instructions",
    r"disregard\s+(?:all\s+)?previous\s+instructions",
    r"system\s*:",
    r"assistant\s*:",
    r"<\|im_start\|>",
    r"<\|im_end\|>",
)
_INJECTION_RE = re.compile("|".join(_INJECTION_MARKERS), re.IGNORECASE)

# A Bearer/recovery prefix followed by a high-entropy blob.
_BEARER_RE = re.compile(r"\bBearer\s+\S+", re.IGNORECASE)
_RECOVERY_RE = re.compile(r"\bREC-[A-Za-z0-9]{6,}\b")
# A standalone high-entropy urlsafe string (>=22 base64url chars), the
# token_urlsafe shape used app-wide. Bounded by word edges. We additionally
# require BOTH a letter and a digit in the run so a long monotonous benign
# string (e.g. a pasted "xxxxxxxx…" or a sentence) is not mistaken for a secret
# — real `secrets.token_urlsafe` output reliably mixes letters and digits.
_HIENTROPY_RE = re.compile(r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{22,}\b")
# Any URL (http/https). Resolvable links never survive.
_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
# Email addresses are PII; the GitHub issue is safe-if-public so a pasted email
# in the body/title must not survive (the reply-to address has its own
# server-only `feedback.email` column and never reaches the payload).
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Dollar amounts ($1, $9.00, $277,990) and bare percentages (6%, 6.0%).
_MONEY_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?")
_PERCENT_RE = re.compile(r"\b\d+(?:\.\d+)?\s?%")
# Raw HTML tags (defense-in-depth; GitHub renders Markdown).
_HTML_RE = re.compile(r"<[^>]+>")


def strip_injection_markers(text: str) -> str:
    """Remove prompt-injection markers (untrusted-data hardening, SECURITY §6.3)."""
    return _INJECTION_RE.sub("[removed]", text or "")


def redact_text(
    text: str | None,
    *,
    own_slug: str | None = None,
    cap: int | None = None,
) -> str:
    """Return a redacted, capped copy of ``text`` safe for a public issue."""
    s = text or ""
    s = strip_injection_markers(s)
    s = _HTML_RE.sub("", s)
    s = _BEARER_RE.sub("[redacted]", s)
    s = _RECOVERY_RE.sub("[redacted]", s)
    s = _URL_RE.sub("[link removed]", s)
    s = _EMAIL_RE.sub("[redacted]", s)
    if own_slug:
        s = s.replace(own_slug, "[redacted]")
    s = _MONEY_RE.sub("[redacted]", s)
    s = _PERCENT_RE.sub("[redacted]", s)
    # High-entropy blobs last so we do not chew up benign words; the >=22 floor
    # keeps ordinary prose intact (English words are far shorter).
    s = _HIENTROPY_RE.sub("[redacted]", s)
    if cap is not None:
        s = _truncate(s, cap)
    return s


def _truncate(s: str, cap: int) -> str:
    if len(s) <= cap:
        return s
    if cap == TITLE_CAP:
        return s[:cap] + "…"
    return s[:cap] + "\n\n[truncated]"


def normalize_type(value: str | None) -> str:
    """Coerce a client ``type`` to the closed FEEDBACK_TYPES enum.

    The client may *suggest* a category, but the value that reaches the GitHub
    payload and the persisted row is ALWAYS one of FEEDBACK_TYPES — an attacker
    cannot smuggle a link/token/financial/markdown string through ``type``
    (#201). Unknown/garbage input collapses to DEFAULT_FEEDBACK_TYPE.
    """
    v = (value or "").strip().lower()
    return v if v in FEEDBACK_TYPES else DEFAULT_FEEDBACK_TYPE


def redact_route(route: str | None, own_slug: str | None = None) -> str:
    """Strip any slug segment and URL fragment so no resolvable link survives.

    /p/<slug>/edit#edit-secret -> /p/:slug/edit ; /r/<slug> -> /r/:slug.
    The fragment (edit/role secret) is dropped entirely (PRD §20/§22). As a
    belt-and-suspenders, the residual path is then run through ``redact_text`` so
    a client cannot smuggle a token/link/financial through a non-/p path segment
    (the route is client-supplied free-text — it must clear the same chokepoint).
    """
    route = (route or "/").split("#", 1)[0].split("?", 1)[0]
    # Collapse the capability slug that follows /p/ or /r/ to a placeholder.
    route = re.sub(r"^(/[pr])/[^/]+", r"\1/:slug", route)
    if own_slug:
        route = route.replace(own_slug, ":slug")
    # Scrub any residual secret/financial/link the client stuffed elsewhere.
    route = redact_text(route, own_slug=own_slug)
    return route or "/"


def build_safe_context(
    *,
    route: str | None,
    own_slug: str | None,
    app_version: str,
    model_version: str,
    feedback_type: str | None,
    ts: str,
) -> dict[str, str]:
    """Assemble the ONLY context dict allowed to leave the server (PRD §22, §9).

    This is the single chokepoint for BOTH sinks (the GitHub-bound payload and
    the persisted ``feedback.context_json``). It is built from a strict
    server-side ALLOWLIST (SAFE_CONTEXT_KEYS); client-supplied ``model_version``
    and ``type`` are IGNORED:

      * ``model_version`` is stamped from the server (the caller passes the
        engine's version) — the client value never appears.
      * ``feedback_type`` is coerced to the closed FEEDBACK_TYPES enum.
      * ``route`` is slug/fragment-stripped via ``redact_route``.

    NOTHING else from the request survives. The returned dict's keys are exactly
    SAFE_CONTEXT_KEYS — there is no passthrough for arbitrary client context
    (#201: free-text/context fields must never bypass redaction into a sink).
    """
    return {
        "route": redact_route(route, own_slug),
        "app_version": app_version,
        "model_version": model_version,
        "type": normalize_type(feedback_type),
        "ts": ts,
    }

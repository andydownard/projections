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
"""
from __future__ import annotations

import re

# §3.2 caps.
TITLE_CAP = 120
DESCRIPTION_CAP = 4000

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

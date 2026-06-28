"""app/research/rent.py — market-rent snippet builder (M3.3; PRD §16.1).

Given the already-resolved Places/Census location, builds candidate market-rent
source URLs (city/county + "retail lease $/sq ft"), fetches each through the
SSRF-hardened ``fetch.py`` (private/link-local/loopback/metadata ranges blocked,
every redirect hop re-validated, the validated IP pinned to defeat DNS-rebinding),
and returns a ``list[Snippet]``.

**No model runs here.** This only produces the grounding set ``extract.py`` extracts
from: a citation ``extract_rent`` later returns that is not one of THESE fetched
URLs is rejected. A blocked / oversized / unreachable / empty candidate is dropped;
**zero snippets is a valid (empty) result** (→ the labeled benchmark downstream).
The raw provider payload and API keys never leave the server.
"""
from __future__ import annotations

import datetime
import re

from app.research.fetch import BlockedURLError, fetch_url
from app.research.snippets import Snippet

# Public commercial-lease source templates; ``{slug}`` is the location path slug.
# These are fetched through the SSRF-hardened fetcher like any other candidate URL.
_SOURCE_TEMPLATES: tuple[tuple[str, str], ...] = (
    ("https://www.loopnet.com/search/commercial-real-estate/{slug}/for-lease/", "listing"),
    ("https://www.crexi.com/properties/retail/{slug}", "listing"),
    ("https://www.commercialsearch.com/commercial-real-estate/{slug}/retail/", "aggregator"),
)

# Cap stored snippet text (cost + injection surface); extract.py re-caps + sanitizes.
_MAX_SNIPPET_CHARS = 4000


def _slug(text: str) -> str:
    """Lowercase, hyphenate a location label into a URL path slug."""
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def location_label(location) -> str:
    """Best human label for the resolved location (dict from the geo derivation or str)."""
    if isinstance(location, dict):
        return (
            location.get("geography_name")
            or location.get("formatted_address")
            or location.get("city")
            or location.get("label")
            or ""
        )
    return str(location or "")


def candidate_rent_urls(location) -> list[str]:
    """Candidate market-rent source URLs for the resolved location (empty if no label)."""
    slug = _slug(location_label(location))
    if not slug:
        return []
    return [tpl.format(slug=slug) for tpl, _tier in _SOURCE_TEMPLATES]


def _tier_for(url: str) -> str:
    for tpl, tier in _SOURCE_TEMPLATES:
        if url.startswith(tpl.split("{slug}")[0]):
            return tier
    return "unknown"


def build_rent_snippets(
    location,
    building_sqft,
    *,
    basis: str = "nnn",
    fetch=None,
    candidate_urls=None,
) -> list:
    """Fetch candidate market-rent sources through the SSRF fetcher → ``list[Snippet]``.

    ``location`` is the resolved geo dict (or a plain label string); ``building_sqft``
    and ``basis`` are carried for query context. ``fetch`` (defaults to
    ``fetch_url``) and ``candidate_urls`` are injectable seams so the suite runs
    hermetically. Every returned snippet came through the SSRF fetcher; a candidate
    that is blocked, oversized, unreachable, or empty is silently dropped (research
    must never 500 the wizard).
    """
    fetch = fetch or fetch_url
    urls = candidate_urls if candidate_urls is not None else candidate_rent_urls(location)
    fetch_date = datetime.date.today().isoformat()
    label = location_label(location)

    snippets: list[Snippet] = []
    for url in urls:
        try:
            body = fetch(url)
        except BlockedURLError:
            # SSRF block / over-cap body / too-many-redirects -> drop this candidate.
            continue
        except Exception:
            # Any upstream hiccup -> drop (degrade to fewer/zero snippets, never raise).
            continue
        text = (body or "").strip()
        if not text:
            continue
        snippets.append(
            Snippet(
                url=url,
                title=label or url,
                text=text[:_MAX_SNIPPET_CHARS],
                fetch_date=fetch_date,
                source_tier=_tier_for(url),
            )
        )
    return snippets

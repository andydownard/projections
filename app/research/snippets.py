"""app/research/snippets.py — the server-fetched snippet record (PRD §16.1).

A Snippet is the unit of grounding: it is what the SSRF-hardened fetcher produced
for one candidate source. The LLM extract step (extract.py) is handed ONLY these
snippets, and any citation it returns that is not in this fetched set is rejected.
Storing `url/title/fetch_date/source_date/source_tier` alongside the extracted
text is what makes "no unfetched citations" enforceable rather than aspirational.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Snippet:
    url: str
    title: str
    text: str
    fetch_date: str
    source_date: str = ""
    source_tier: str = "unknown"

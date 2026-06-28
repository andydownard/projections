"""Snippet-builder for location market-rent research (app/research/rent.py, M3.3).

The builder produces the grounding set ``extract_rent`` extracts from. The hard
invariants (stubbed transport — no network):
  - every returned snippet came through the SSRF-hardened fetcher;
  - a blocked / oversized / unreachable / empty candidate is dropped;
  - zero snippets is a valid (empty) result;
  - no candidate is built (and nothing fetched) without a resolvable location label.
"""
from __future__ import annotations

from functools import partial

from app.research import fetch as fetch_mod
from app.research import rent as rent_mod
from app.research.fetch import BlockedURLError
from app.research.snippets import Snippet

LOCATION = {
    "geography_name": "Longview city",
    "formatted_address": "Longview, TX, USA",
}


def test_candidate_urls_built_from_location():
    urls = rent_mod.candidate_rent_urls(LOCATION)
    assert urls  # non-empty
    assert all(u.startswith("https://") for u in urls)
    assert all("longview" in u.lower() for u in urls)


def test_no_label_yields_no_candidates():
    # Without a resolvable location there is nothing to fetch (empty, not an error).
    assert rent_mod.candidate_rent_urls({}) == []
    assert rent_mod.candidate_rent_urls("") == []
    assert rent_mod.build_rent_snippets({}, "10000") == []


def test_build_returns_only_safe_fetched_snippets():
    urls = ["https://a.example/x", "https://b.example/y", "https://c.example/z"]

    def fake_fetch(url):
        if url.endswith("/x"):
            return "NNN retail lease rate $9.00/sq ft in Longview, TX."
        if url.endswith("/y"):
            raise BlockedURLError("redirect into a private range")  # SSRF / oversized
        return ""  # empty body -> dropped

    snippets = rent_mod.build_rent_snippets(
        LOCATION, "10000", fetch=fake_fetch, candidate_urls=urls)
    assert len(snippets) == 1
    s = snippets[0]
    assert isinstance(s, Snippet)
    assert s.url == "https://a.example/x"
    assert "$9.00/sq ft" in s.text
    assert s.source_tier  # tier is set (provenance)
    assert s.fetch_date  # fetched-on date recorded


def test_zero_snippets_when_all_candidates_blocked():
    def fake_fetch(url):
        raise BlockedURLError("blocked")

    snippets = rent_mod.build_rent_snippets(
        LOCATION, "10000", fetch=fake_fetch, candidate_urls=["https://x/1", "https://y/2"])
    assert snippets == []


def test_default_fetch_is_the_ssrf_hardened_fetcher():
    # The default fetch seam is the real SSRF fetcher: a candidate that resolves into
    # the cloud-metadata range is dropped before any body is read (never returned).
    blocked = partial(fetch_mod.fetch_url, resolver=lambda host: ["169.254.169.254"])
    snippets = rent_mod.build_rent_snippets(
        LOCATION, "10000", fetch=blocked, candidate_urls=["https://metadata.example/x"])
    assert snippets == []


def test_build_uses_fetch_url_when_no_seam_injected(monkeypatch):
    called = {}

    def fake(url):
        called[url] = called.get(url, 0) + 1
        return "asking rent $10.50/sq ft NNN"

    monkeypatch.setattr(rent_mod, "fetch_url", fake)
    snippets = rent_mod.build_rent_snippets(
        LOCATION, "10000", candidate_urls=["https://x/1"])
    assert called == {"https://x/1": 1}
    assert len(snippets) == 1
    assert "$10.50/sq ft" in snippets[0].text


def test_location_label_prefers_geography_then_address_then_string():
    assert rent_mod.location_label(LOCATION) == "Longview city"
    assert rent_mod.location_label({"formatted_address": "Tyler, TX, USA"}) == "Tyler, TX, USA"
    assert rent_mod.location_label("Marshall, TX") == "Marshall, TX"
    assert rent_mod.location_label(None) == ""


def test_candidate_urls_slugify_county_with_spaces_and_commas():
    urls = rent_mod.candidate_rent_urls({"geography_name": "Gregg County, TX"})
    assert urls
    assert all("gregg-county-tx" in u for u in urls)
    assert not any(" " in u or "," in u for u in urls)


def test_returned_snippet_tier_matches_source_template():
    # A fetched snippet carries the source_tier of the template its URL came from,
    # so the evidence panel can label provenance.
    urls = rent_mod.candidate_rent_urls(LOCATION)
    tiers = {rent_mod._tier_for(u) for u in urls}
    assert "listing" in tiers
    assert "unknown" not in tiers  # every templated URL is classified


def test_snippet_text_is_capped():
    big = "rent $9/sq ft " + ("x" * 10000)
    snippets = rent_mod.build_rent_snippets(
        LOCATION, "10000", fetch=lambda u: big, candidate_urls=["https://x/1"])
    assert len(snippets) == 1
    assert len(snippets[0].text) <= rent_mod._MAX_SNIPPET_CHARS


def test_building_sqft_and_basis_are_accepted_without_error():
    # The contract signature carries size + basis for query context; passing them
    # (incl. a gross basis) must not raise.
    snippets = rent_mod.build_rent_snippets(
        LOCATION, "20000", basis="gross",
        fetch=lambda u: "asking $8/sq ft gross", candidate_urls=["https://x/1"])
    assert len(snippets) == 1

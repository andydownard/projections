"""SSRF-hardening tests for the research fetcher (SECURITY.md §7).

The research subsystem fetches attacker-influenceable URLs server-side; an
unguarded fetcher can be steered at Railway's private network or the cloud
metadata endpoint. These tests assert the block-list, scheme allowlist, and
redirect re-validation BEFORE any socket is opened.
"""
from __future__ import annotations

import pytest

from app.research.fetch import (
    BlockedURLError,
    is_blocked_ip,
    validate_url_scheme_host,
)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",        # loopback
        "127.5.5.5",        # loopback /8
        "::1",              # ipv6 loopback
        "169.254.169.254",  # cloud metadata
        "169.254.0.1",      # link-local
        "10.0.0.1",         # private
        "10.255.255.255",
        "172.16.0.1",       # private /12
        "172.31.255.255",
        "192.168.1.1",      # private
        "fc00::1",          # ipv6 unique-local
        "fd00::abcd",
        "0.0.0.0",          # unspecified
    ],
)
def test_blocked_ip_ranges(ip):
    assert is_blocked_ip(ip) is True


@pytest.mark.parametrize(
    "ip",
    ["8.8.8.8", "1.1.1.1", "151.101.1.69", "2606:4700:4700::1111"],
)
def test_public_ip_allowed(ip):
    assert is_blocked_ip(ip) is False


def test_scheme_allowlist_rejects_file_and_gopher():
    for url in ("file:///etc/passwd", "gopher://x", "ftp://h/x", "data:text/x"):
        with pytest.raises(BlockedURLError):
            validate_url_scheme_host(url, resolver=lambda h: ["8.8.8.8"])


def test_railway_internal_host_blocked():
    with pytest.raises(BlockedURLError):
        validate_url_scheme_host(
            "http://db.railway.internal/x", resolver=lambda h: ["8.8.8.8"]
        )


def test_metadata_host_blocked_even_if_dns_lies():
    # A hostname that resolves to the metadata IP must be blocked.
    with pytest.raises(BlockedURLError):
        validate_url_scheme_host(
            "http://evil.example.com/x",
            resolver=lambda h: ["169.254.169.254"],
        )


def test_public_url_passes_validation():
    ip = validate_url_scheme_host(
        "https://www.loopnet.com/listing", resolver=lambda h: ["151.101.1.69"]
    )
    assert ip == "151.101.1.69"


def test_fetch_blocks_redirect_to_private_range():
    # Every redirect hop is re-validated; a 302 -> metadata must raise.
    from app.research.fetch import fetch_url

    hops = {
        "https://public.example.com/a": (302, "http://169.254.169.254/latest", ""),
    }

    def fake_transport(url):
        status, location, body = hops[url]
        return status, location, body

    with pytest.raises(BlockedURLError):
        fetch_url(
            "https://public.example.com/a",
            resolver=lambda h: ["151.101.1.69"]
            if "public" in h
            else ["169.254.169.254"],
            transport=fake_transport,
        )

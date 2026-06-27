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

    def fake_transport(url, ip):
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


# --------------------------------------------------------------------------- #
# TOCTOU / DNS-rebinding (issue #163): the fetcher must pin the connection to
# the IP it validated and MUST NOT re-resolve the hostname at connect time.
# --------------------------------------------------------------------------- #


def test_fetch_passes_validated_ip_to_transport():
    """fetch_url hands the transport the validated IP (the pin), not just the URL."""
    from app.research.fetch import fetch_url

    seen = {}

    def fake_transport(url, ip):
        seen["url"] = url
        seen["ip"] = ip
        return 200, "", "body-text"

    out = fetch_url(
        "https://pub.example.com/x",
        resolver=lambda h: ["151.101.1.69"],
        transport=fake_transport,
    )
    assert out == "body-text"
    assert seen["url"] == "https://pub.example.com/x"
    assert seen["ip"] == "151.101.1.69"


def test_fetch_does_not_reresolve_on_rebinding_resolver():
    """A rebinding resolver (public on validate, private later) is defeated:

    the host is resolved exactly once, the transport is pinned to the validated
    public IP, and the attacker's later private answer is never consulted.
    """
    from app.research.fetch import fetch_url

    calls = {"n": 0}

    def rebinding_resolver(host):
        calls["n"] += 1
        # First answer (validation) public; any later answer would be metadata.
        return ["151.101.1.69"] if calls["n"] == 1 else ["169.254.169.254"]

    seen = {}

    def fake_transport(url, ip):
        seen["ip"] = ip
        return 200, "", "ok"

    out = fetch_url(
        "https://pub.example.com/x",
        resolver=rebinding_resolver,
        transport=fake_transport,
    )
    assert out == "ok"
    assert seen["ip"] == "151.101.1.69"  # pinned to the validated public IP
    assert calls["n"] == 1  # NOT re-resolved at connect time (TOCTOU closed)


def test_fetch_revalidates_ip_each_hop_and_repins():
    """Each redirect hop is resolved + validated again, and the transport for
    that hop is pinned to that hop's validated IP."""
    from app.research.fetch import fetch_url

    hops = {
        "https://a.example.com/1": (302, "https://b.example.com/2", ""),
        "https://b.example.com/2": (200, "", "final"),
    }
    ips = {"a.example.com": "151.101.1.69", "b.example.com": "8.8.8.8"}
    pinned = []

    def resolver(host):
        return [ips[host]]

    def fake_transport(url, ip):
        pinned.append((url, ip))
        return hops[url]

    out = fetch_url(
        "https://a.example.com/1", resolver=resolver, transport=fake_transport
    )
    assert out == "final"
    assert pinned == [
        ("https://a.example.com/1", "151.101.1.69"),
        ("https://b.example.com/2", "8.8.8.8"),
    ]


def test_fetch_blocks_multi_hop_redirect_to_private():
    from app.research.fetch import fetch_url

    hops = {
        "https://a.example.com/1": (302, "https://b.example.com/2", ""),
        "https://b.example.com/2": (302, "http://169.254.169.254/latest", ""),
    }

    def resolver(host):
        return ["8.8.8.8"] if host.endswith("example.com") else ["169.254.169.254"]

    def fake_transport(url, ip):
        return hops[url]

    with pytest.raises(BlockedURLError):
        fetch_url("https://a.example.com/1", resolver=resolver, transport=fake_transport)


def test_fetch_resolves_scheme_relative_redirect_then_blocks():
    """A scheme-relative Location ('//host/...') is resolved against the current
    URL (urljoin) and the resulting host is re-validated and blocked."""
    from app.research.fetch import fetch_url

    def fake_transport(url, ip):
        return 302, "//169.254.169.254/latest", ""

    def resolver(host):
        return ["8.8.8.8"] if "pub" in host else ["169.254.169.254"]

    with pytest.raises(BlockedURLError):
        fetch_url(
            "https://pub.example.com/a", resolver=resolver, transport=fake_transport
        )


def test_fetch_enforces_max_redirect_count():
    from app.research.fetch import fetch_url

    def fake_transport(url, ip):
        n = int(url.rsplit("/", 1)[-1])
        return 302, f"https://pub.example.com/{n + 1}", ""

    with pytest.raises(BlockedURLError):
        fetch_url(
            "https://pub.example.com/0",
            resolver=lambda h: ["8.8.8.8"],
            transport=fake_transport,
        )


# --------------------------------------------------------------------------- #
# IP pinning + streamed byte-cap in the DEFAULT httpx transport (issue #163).
# Driven through httpx.MockTransport — deterministic, no live egress.
# --------------------------------------------------------------------------- #


def test_pin_url_to_ip_preserves_port_and_brackets_ipv6():
    from app.research.fetch import _pin_url_to_ip

    assert (
        _pin_url_to_ip("https://h.example.com:8443/p?q=1", "151.101.1.69")
        == "https://151.101.1.69:8443/p?q=1"
    )
    assert (
        _pin_url_to_ip("http://h.example.com/p", "2606:4700:4700::1111")
        == "http://[2606:4700:4700::1111]/p"
    )


def test_httpx_transport_connects_to_validated_ip_not_hostname():
    """The default transport dials the validated IP and keeps the real hostname
    for the Host header + TLS SNI — it never re-resolves the name."""
    import httpx

    from app.research.fetch import _httpx_transport

    seen = {}

    def handler(request):
        seen["host"] = request.url.host
        seen["header_host"] = request.headers.get("host")
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(
            200, headers={"content-type": "text/plain"}, content=b"ok"
        )

    def factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )

    status, location, body = _httpx_transport(
        "https://www.loopnet.com/listing", "151.101.1.69", _client_factory=factory
    )
    assert status == 200
    assert body == "ok"
    assert seen["host"] == "151.101.1.69"  # connected to the validated IP
    assert seen["header_host"] == "www.loopnet.com"  # vhost preserved
    assert seen["sni"] == "www.loopnet.com"  # TLS cert verified vs hostname


def test_httpx_transport_aborts_streamed_body_over_cap():
    """A body larger than MAX_BYTES is aborted mid-stream, not buffered whole."""
    import httpx

    from app.research.fetch import MAX_BYTES, ResponseTooLargeError, _httpx_transport

    consumed = {"chunks": 0}
    chunk = b"a" * 64_000

    def body_iter():
        for _ in range(200):  # ~12.8 MB if fully drained
            consumed["chunks"] += 1
            yield chunk

    def handler(request):
        return httpx.Response(
            200, headers={"content-type": "text/plain"}, content=body_iter()
        )

    def factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )

    with pytest.raises(ResponseTooLargeError):
        _httpx_transport(
            "https://pub.example.com/x", "151.101.1.69", _client_factory=factory
        )
    # Aborted early: never drained the whole multi-MB stream into memory.
    assert consumed["chunks"] < 200
    assert consumed["chunks"] * len(chunk) <= MAX_BYTES + len(chunk)


def test_httpx_transport_rejects_oversize_content_length():
    """An over-cap Content-Length is refused before the body is streamed."""
    import httpx

    from app.research.fetch import MAX_BYTES, ResponseTooLargeError, _httpx_transport

    drained = {"hit": False}

    def body_iter():
        drained["hit"] = True
        yield b"x"

    def handler(request):
        resp = httpx.Response(200, content=body_iter())
        resp.headers["content-length"] = str(MAX_BYTES + 1)
        return resp

    def factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )

    with pytest.raises(ResponseTooLargeError):
        _httpx_transport(
            "https://pub.example.com/x", "151.101.1.69", _client_factory=factory
        )
    assert drained["hit"] is False  # rejected on the header, body never read


def test_httpx_transport_returns_location_for_redirect_without_reading_body():
    import httpx

    from app.research.fetch import _httpx_transport

    def handler(request):
        return httpx.Response(
            302, headers={"location": "https://next.example.com/y"}, content=b"ignored"
        )

    def factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )

    status, location, body = _httpx_transport(
        "https://pub.example.com/x", "151.101.1.69", _client_factory=factory
    )
    assert status == 302
    assert location == "https://next.example.com/y"
    assert body == ""


def test_httpx_transport_full_fetch_under_cap_returns_text():
    import httpx

    from app.research.fetch import _httpx_transport

    def handler(request):
        return httpx.Response(
            200,
            headers={"content-type": "text/plain; charset=utf-8"},
            content="café résumé".encode(),
        )

    def factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )

    status, location, body = _httpx_transport(
        "https://pub.example.com/x", "151.101.1.69", _client_factory=factory
    )
    assert status == 200
    assert body == "café résumé"

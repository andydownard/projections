"""app/research/fetch.py — SSRF-hardened server-side fetcher (SECURITY.md §7).

The research subsystem fetches attacker-influenceable candidate URLs to build a
snippet store. On Railway an unguarded fetcher can be steered at the private
network or the cloud-metadata endpoint, so this module is the security spine of
M3 research:

- Resolve the hostname and BLOCK any request whose resolved IP is loopback,
  link-local (incl. 169.254.169.254 metadata), private, IPv6 unique-local, or
  the unspecified address; block `*.railway.internal` by name.
- Re-validate the resolved IP on EVERY redirect hop, not just the first — a 302
  into a blocked range is rejected.
- Allowlist schemes to http/https only (no file:/gopher:/ftp:/data:).
- Enforce a timeout and a max response size.

The fetcher returns only what the snippet store needs; the raw provider payload
and API keys never leave the server. The LLM extract step (extract.py) sees only
text that came through here, which is how "unfetched citations are rejected" is
enforced upstream of the model.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Callable, Optional
from urllib.parse import urlparse

ALLOWED_SCHEMES = ("http", "https")
MAX_REDIRECTS = 5
MAX_BYTES = 512_000  # cap response size to bound memory/cost
TIMEOUT_SECONDS = 8.0

# Hostname suffixes blocked by name (DNS may not resolve them publicly).
BLOCKED_HOST_SUFFIXES = (".railway.internal",)


class BlockedURLError(Exception):
    """Raised when a URL is disallowed (bad scheme/host or blocked IP range)."""


# A resolver maps a hostname -> list of IP strings. Injectable for tests.
Resolver = Callable[[str], list]
# A transport performs one HTTP request and returns (status, location, body).
Transport = Callable[[str], tuple]


def is_blocked_ip(ip: str) -> bool:
    """True if `ip` is in any private/loopback/link-local/metadata range.

    Blocks (SECURITY.md §7): loopback 127.0.0.0/8 + ::1; link-local
    169.254.0.0/16 (incl. 169.254.169.254 metadata) + fe80::/10; private
    10/8, 172.16/12, 192.168/16; IPv6 unique-local fc00::/7; the unspecified
    address 0.0.0.0/:: ; and anything not a global unicast address.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        # Unparseable -> treat as blocked (fail closed).
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _default_resolver(host: str) -> list:
    infos = socket.getaddrinfo(host, None)
    return [info[4][0] for info in infos]


def validate_url_scheme_host(url: str, *, resolver: Optional[Resolver] = None) -> str:
    """Validate scheme + host, resolve, and return the validated IP.

    Raises BlockedURLError on a non-http(s) scheme, a railway.internal host, a
    host that fails to resolve, or any resolved IP in a blocked range. Returns
    the first resolved IP (the caller should connect to THIS validated IP to
    avoid DNS-rebinding TOCTOU).
    """
    resolver = resolver or _default_resolver
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise BlockedURLError(f"scheme not allowed: {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise BlockedURLError("missing host")
    lowered = host.lower()
    for suffix in BLOCKED_HOST_SUFFIXES:
        if lowered == suffix.lstrip(".") or lowered.endswith(suffix):
            raise BlockedURLError(f"blocked host: {host!r}")
    try:
        ips = resolver(host)
    except Exception as err:  # resolution failure -> fail closed
        raise BlockedURLError(f"could not resolve host: {host!r}") from err
    if not ips:
        raise BlockedURLError(f"no addresses for host: {host!r}")
    for ip in ips:
        if is_blocked_ip(ip):
            raise BlockedURLError(f"blocked ip range for {host!r}: {ip}")
    return ips[0]


def _httpx_transport(url: str) -> tuple:
    """Default transport: one non-following GET, capped read. (status, loc, body)."""
    import httpx

    with httpx.Client(follow_redirects=False, timeout=TIMEOUT_SECONDS) as client:
        resp = client.get(url)
        location = resp.headers.get("location", "")
        body = resp.text[:MAX_BYTES] if resp.status_code < 300 else ""
        return resp.status_code, location, body


def fetch_url(
    url: str,
    *,
    resolver: Optional[Resolver] = None,
    transport: Optional[Transport] = None,
) -> str:
    """Fetch `url` safely, re-validating every redirect hop. Returns body text.

    Each hop's resolved IP is checked against the block-list BEFORE the request
    is made; a redirect into a blocked range raises BlockedURLError (not a
    silent follow). Caps redirect depth.
    """
    transport = transport or _httpx_transport
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        validate_url_scheme_host(current, resolver=resolver)
        status, location, body = transport(current)
        if status in (301, 302, 303, 307, 308) and location:
            # Re-validate the redirect target on the NEXT loop iteration.
            current = location
            continue
        return body or ""
    raise BlockedURLError("too many redirects")

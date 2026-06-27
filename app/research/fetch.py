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
from typing import Callable
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

ALLOWED_SCHEMES = ("http", "https")
MAX_REDIRECTS = 5
MAX_BYTES = 512_000  # cap response size to bound memory/cost
TIMEOUT_SECONDS = 8.0
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)

# Hostname suffixes blocked by name (DNS may not resolve them publicly).
BLOCKED_HOST_SUFFIXES = (".railway.internal",)


class BlockedURLError(Exception):
    """Raised when a URL is disallowed (bad scheme/host or blocked IP range)."""


class ResponseTooLargeError(BlockedURLError):
    """Raised when a response declares or streams more than MAX_BYTES.

    Subclasses BlockedURLError so the degrade path (all candidates failed ->
    502 research_unavailable) catches it like any other refusal, while callers
    that care can still distinguish an over-cap body from an SSRF block.
    """


# A resolver maps a hostname -> list of IP strings. Injectable for tests.
Resolver = Callable[[str], list]
# A transport performs ONE request and returns (status, location, body). It is
# handed BOTH the request URL (for scheme/host/path) AND the already-validated IP
# it must connect to; it MUST NOT re-resolve the hostname (DNS-rebinding TOCTOU).
Transport = Callable[[str, str], tuple]


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


def validate_url_scheme_host(url: str, *, resolver: Resolver | None = None) -> str:
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


def _pin_url_to_ip(url: str, ip: str) -> str:
    """Return `url` with its host replaced by the literal `ip` (IPv6 bracketed),
    preserving scheme/port/path/query.

    Connecting to the literal IP is what closes the DNS-rebinding TOCTOU: the
    socket targets the address we already validated instead of whatever the
    resolver might now return. The caller restores the real hostname in the
    `Host` header + TLS SNI so vhost routing and certificate verification still
    target the actual site. Any userinfo in the URL is dropped on purpose.
    """
    parsed = urlparse(url)
    try:
        host_literal = f"[{ip}]" if ipaddress.ip_address(ip).version == 6 else ip
    except ValueError:
        host_literal = ip
    netloc = f"{host_literal}:{parsed.port}" if parsed.port is not None else host_literal
    return urlunparse(parsed._replace(netloc=netloc))


def _httpx_transport(
    url: str,
    ip: str,
    *,
    _client_factory: Callable[[], httpx.Client] | None = None,
) -> tuple[int, str, str]:
    """Default transport: one non-following GET, pinned to the validated IP, with
    a hard streamed byte cap. Returns (status, location, body).

    - Dials the literal `ip` (no hostname re-resolution -> no rebinding TOCTOU),
      restoring the real host for the `Host` header and TLS SNI.
    - Refuses an over-cap `Content-Length` before reading the body, and streams
      with `iter_bytes`, aborting the moment the running total exceeds MAX_BYTES
      so a multi-GB / decompression-bomb body can never be buffered whole.
    """
    host = urlparse(url).hostname or ""
    pinned = _pin_url_to_ip(url, ip)

    def _default_factory() -> httpx.Client:
        return httpx.Client(follow_redirects=False, timeout=TIMEOUT_SECONDS)

    factory = _client_factory or _default_factory
    with factory() as client:
        with client.stream(
            "GET",
            pinned,
            headers={"Host": host},
            extensions={"sni_hostname": host},
        ) as resp:
            location = resp.headers.get("location", "")
            if resp.status_code in _REDIRECT_STATUSES:
                # Redirect target is re-validated by fetch_url; body is irrelevant.
                return resp.status_code, location, ""
            declared = resp.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > MAX_BYTES:
                        raise ResponseTooLargeError(
                            f"content-length {declared} exceeds cap {MAX_BYTES}"
                        )
                except ValueError:
                    pass  # malformed header -> fall through to the streamed cap
            chunks = []
            total = 0
            for chunk in resp.iter_bytes():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ResponseTooLargeError(
                        f"response body exceeded cap {MAX_BYTES}"
                    )
                chunks.append(chunk)
            encoding = resp.charset_encoding or "utf-8"
            body = b"".join(chunks).decode(encoding, errors="replace")
            return resp.status_code, location, body


def fetch_url(
    url: str,
    *,
    resolver: Resolver | None = None,
    transport: Transport | None = None,
) -> str:
    """Fetch `url` safely, re-validating + re-pinning every redirect hop.

    Each hop's host is resolved and its IP checked against the block-list BEFORE
    the request is made; the validated IP is handed to the transport as the pin
    target (the transport never re-resolves the hostname, closing the rebinding
    TOCTOU). A redirect into a blocked range raises BlockedURLError rather than
    being silently followed. Relative/scheme-relative redirects are resolved
    against the current URL before re-validation. Redirect depth is capped.
    """
    transport = transport or _httpx_transport
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        ip = validate_url_scheme_host(current, resolver=resolver)
        status, location, body = transport(current, ip)
        if status in _REDIRECT_STATUSES and location:
            # Resolve relative/scheme-relative targets, then re-validate next loop.
            current = urljoin(current, location)
            continue
        return body or ""
    raise BlockedURLError("too many redirects")

"""PE5 — app/penny/proposal.py upload-intake guards (Spec B §9/§12; issue #124).

Unit coverage for the proposal intake seam: the magic-byte type sniff + size cap,
the opaque-ref round-trip (bytes are HELD, never parsed/executed/rendered), and the
SSRF guard that fails closed on any private/loopback/link-local/metadata host so a
future remote-intake path (PE9) can never be steered at the private network.
"""
from __future__ import annotations

import pytest

from app.penny import proposal


@pytest.fixture(autouse=True)
def _clear_proposals():
    proposal.reset_proposals()
    yield
    proposal.reset_proposals()


def _pdf(n_extra=0):
    return b"%PDF-1.4\n" + b"x" * n_extra + b"\n%%EOF\n"


# ----------------------------------------------------------------- type sniff
def test_validate_accepts_real_pdf():
    proposal.validate_pdf(_pdf(32))  # does not raise


def test_validate_rejects_non_pdf_by_magic_bytes():
    # a forgeable filename/content-type is never the authority — the bytes are.
    with pytest.raises(proposal.ProposalBadType):
        proposal.validate_pdf(b"PK\x03\x04 this is a zip, not a pdf")


def test_validate_rejects_empty_body():
    with pytest.raises(proposal.ProposalBadType):
        proposal.validate_pdf(b"")


# ------------------------------------------------------------------ size cap
def test_validate_rejects_oversize(monkeypatch):
    monkeypatch.setattr(proposal, "MAX_PROPOSAL_BYTES", 16)
    with pytest.raises(proposal.ProposalTooLarge):
        proposal.validate_pdf(_pdf(64))


def test_size_is_checked_before_type(monkeypatch):
    # a huge NON-pdf body still trips the size cap (cheap reject before sniff).
    monkeypatch.setattr(proposal, "MAX_PROPOSAL_BYTES", 4)
    with pytest.raises(proposal.ProposalTooLarge):
        proposal.validate_pdf(b"not a pdf and also too long")


# ------------------------------------------------------------- ref round-trip
def test_store_and_get_proposal_round_trip():
    data = _pdf(48)
    ref = proposal.store_proposal(data, filename="plan.pdf", content_type="application/pdf")
    assert ref.startswith("prop_")
    held = proposal.get_proposal(ref)
    assert held is not None
    # the bytes are held verbatim (never parsed) and the metadata is recorded.
    assert held["data"] == data
    assert held["size"] == len(data)
    assert held["filename"] == "plan.pdf"
    assert held["content_type"] == "application/pdf"


def test_each_upload_gets_a_distinct_ref():
    a = proposal.store_proposal(_pdf(8))
    b = proposal.store_proposal(_pdf(8))
    assert a != b
    assert proposal.get_proposal(a)["ref"] == a


def test_get_unknown_ref_is_none():
    assert proposal.get_proposal("prop_nope") is None


def test_store_rejects_non_pdf():
    with pytest.raises(proposal.ProposalBadType):
        proposal.store_proposal(b"<html>not a pdf</html>")


def test_reset_clears_held_uploads():
    ref = proposal.store_proposal(_pdf(8))
    proposal.reset_proposals()
    assert proposal.get_proposal(ref) is None


# --------------------------------------------------------------------- SSRF
@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",  # cloud metadata
    "http://127.0.0.1/x",                          # loopback
    "http://10.0.0.5/x",                           # private 10/8
    "http://192.168.1.1/x",                        # private 192.168/16
    "http://[::1]/x",                              # IPv6 loopback
])
def test_assert_safe_source_url_blocks_internal(url):
    with pytest.raises(proposal.ProposalBlockedSource):
        proposal.assert_safe_source_url(url)


def test_assert_safe_source_url_blocks_bad_scheme():
    with pytest.raises(proposal.ProposalBlockedSource):
        proposal.assert_safe_source_url("file:///etc/passwd")


def test_assert_safe_source_url_allows_public_ip():
    # a public address passes the guard (returns the validated IP); the endpoint
    # still defers the actual fetch to PE9.
    ip = proposal.assert_safe_source_url("http://93.184.216.34/proposal.pdf")
    assert ip == "93.184.216.34"

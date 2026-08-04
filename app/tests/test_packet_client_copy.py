"""RED first: the client-copy packet variant (``?variant=client``, Model v3
Phase 3, Task 3.1).

Uses the REAL Aggressive golden fixture (same fixture `app/tests/test_packet.py`
already uses for the §12.2 guardrail suite) so "an active guardrail flag" is
grounded in the exact view-model the engine produces, never a hand-built stub.

The client-copy variant drops the guardrails section ENTIRELY rather than
rewording it in place — the simplest way to guarantee the pre-existing
``"(§12.2)"`` internal-spec-citation leak (confirmed present in both renderers'
guardrails text) can never reach client-facing copy. It also swaps in the
neutral ``CLIENT_COPY_DISCLAIMER`` (the SAME constant ``engine/xlsx.py`` uses for
the client-copy ``.xlsx``) in place of the internal ``EXPORT_DISCLAIMER``.

The default (no ``variant`` kwarg) call must stay byte-identical to today's
output — proven directly below, not just implied by the rest of the suite
staying green.
"""

from app.packet import build_packet, render_packet_md
from engine.model import CLIENT_COPY_DISCLAIMER, EXPORT_DISCLAIMER
from engine.tests.conftest import build_aggressive_result
from engine.viewmodel import to_view_model


def _aggressive_vm() -> dict:
    return to_view_model(build_aggressive_result())


# ------------------------------------------------------------- internal (default)
def test_internal_variant_is_unchanged_by_default():
    vm = _aggressive_vm()
    # sanity: the fixture really fires a §12.2 guardrail, so the assertions below
    # are meaningfully exercised rather than trivially true.
    assert vm["flags"]["net_margin_y4_out_of_band"]["requires_note"] is True

    md_default = render_packet_md(build_packet(vm, role="board"))
    md_explicit_internal = render_packet_md(build_packet(vm, role="board", variant="internal"))
    assert md_default == md_explicit_internal
    assert "§12.2" in md_default
    assert EXPORT_DISCLAIMER in md_default
    assert CLIENT_COPY_DISCLAIMER not in md_default


# ----------------------------------------------------------------------- client
def test_client_variant_drops_guardrails_section_entirely():
    vm = _aggressive_vm()
    assert vm["flags"]["net_margin_y4_out_of_band"]["requires_note"] is True

    pkt = build_packet(vm, role="board", variant="client")
    assert "guardrails" not in pkt["sections"]

    md = render_packet_md(pkt)
    assert "§12.2" not in md
    assert "## Guardrails" not in md
    # neither the internal flag key nor a hand-authored guardrail label leaks in.
    assert "net_margin_y4_out_of_band" not in md
    assert "Net margin (Year 4)" not in md


def test_client_variant_uses_the_shared_client_copy_disclaimer_verbatim():
    vm = _aggressive_vm()
    md = render_packet_md(build_packet(vm, role="board", variant="client"))
    assert CLIENT_COPY_DISCLAIMER in md
    assert EXPORT_DISCLAIMER not in md


def test_client_variant_still_carries_every_other_structured_section():
    # Dropping guardrails must not collapse the rest of the packet — banner,
    # assumptions, sensitivity, kpis, income statement, startup costs all still
    # render for the client copy.
    vm = _aggressive_vm()
    pkt = build_packet(vm, role="board", variant="client")
    for key in ("banner", "evidence", "recommendation", "assumptions",
                "sensitivity", "provenance", "kpis", "income_statement",
                "startup_costs", "disclaimer"):
        assert key in pkt["sections"], key

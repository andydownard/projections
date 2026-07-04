"""§12.2 guardrail justification notes travel into the Board Packet (Task 4.3).

When a driver is out of its advisory benchmark band the engine sets a `flags`
entry with `requires_note: True` (ENGINE_CONTRACT §6.2 / PRD §12.2). That
advisory — "this input is out of band and requires a written justification" — is
part of what makes the packet defensible to a skeptical board/funder, so it MUST
travel into the packet a board actually reads, not just the interactive UI.

These tests use the REAL Aggressive golden fixture (shares 15/20/25, ~32% Y1
margin at design-parity labor) so the guardrails section is grounded in the exact
view-model the engine produces, never a hand-built stub.
"""

from app.packet import build_packet, render_packet_docx, render_packet_md
from engine.tests.conftest import build_aggressive_result
from engine.viewmodel import to_view_model


def _docx_text(data: bytes) -> str:
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.read("word/document.xml").decode("utf-8")


def _aggressive_vm() -> dict:
    return to_view_model(build_aggressive_result())


# --------------------------------------------------------------- structured
def test_aggressive_packet_has_a_guardrails_section_with_the_two_flags():
    vm = _aggressive_vm()
    # sanity: the fixture actually fires both §12.2 guardrails.
    assert vm["flags"]["net_margin_out_of_band"]["requires_note"] is True
    assert vm["flags"]["share_y1_out_of_band"]["requires_note"] is True

    pkt = build_packet(vm, role="board")
    guardrails = pkt["sections"]["guardrails"]
    fields = {g["field"] for g in guardrails}
    assert "net_margin_out_of_band" in fields
    assert "share_y1_out_of_band" in fields
    # every rendered guardrail carries the required-justification note text.
    for g in guardrails:
        assert "justification" in g["note"].lower()
        assert g["band"]  # the advisory band travels too (e.g. "≤ ~30%")


def test_guardrails_section_is_empty_when_no_flags_require_a_note():
    # A clean projection (no out-of-band drivers) must NOT sprout guardrail noise.
    clean_vm = {"reco": {"tag": "proceed"}, "flags": {"model_upgrade_available": False,
                                                      "ramp_low_confidence": True}}
    pkt = build_packet(clean_vm, role="board")
    assert pkt["sections"]["guardrails"] == []


# ------------------------------------------------------------------ rendered
def test_justification_note_travels_into_rendered_markdown():
    md = render_packet_md(build_packet(_aggressive_vm(), role="board"))
    # the board reader sees the guardrail heading and a required-justification note.
    assert "Guardrails" in md
    assert "justification" in md.lower()
    # the specific out-of-band drivers are named.
    assert "Net margin" in md
    assert "Donor market share" in md


def test_justification_note_travels_into_rendered_docx():
    # the .docx is the artifact a board actually opens — the note must reach it too.
    text = _docx_text(render_packet_docx(build_packet(_aggressive_vm(), role="board")))
    assert "justification" in text.lower()
    assert "Net margin" in text


def test_guardrails_do_not_alter_the_banner_numbers():
    # The guardrails are advisory framing only — they never change the decision
    # figures (the numbers stay identical to a build without the section wired).
    pkt = build_packet(_aggressive_vm(), role="board")
    facts = {f["label"]: f["display"] for f in pkt["sections"]["banner"]["facts"]}
    assert facts["Capital required"]  # present + grounded
    assert pkt["sections"]["banner"]["tag"] == "revise"

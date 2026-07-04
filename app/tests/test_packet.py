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
from engine.tests.conftest import build_aggressive_result, build_canonical_result
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
    # sanity: the fixture actually fires both §12.2 guardrails. FUSION: the net-margin
    # guardrail runs on the DISPLAYED (cash) margin, so the >30% flag fires on the
    # steady-state LATE years (Y4/Y5) rather than the startup-depressed Year 1.
    assert vm["flags"]["net_margin_y4_out_of_band"]["requires_note"] is True
    assert vm["flags"]["share_y1_out_of_band"]["requires_note"] is True

    pkt = build_packet(vm, role="board")
    guardrails = pkt["sections"]["guardrails"]
    fields = {g["field"] for g in guardrails}
    assert "net_margin_y4_out_of_band" in fields
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


# ------------------------------------------------------ I2 (batch2-review): the
# section must iterate the vm's flags dict, not a hard-coded label map, so a
# future requires_note flag with an unmapped key can never silently fail to
# travel into the packet.
def test_unmapped_requires_note_flag_still_travels_into_the_packet():
    # A synthetic flag key that does NOT exist in app.packet._GUARDRAIL_LABELS.
    # Pre-fix, `_guardrails` iterated the label map, so this key was silently
    # dropped with no test failing — the exact failure §12.2 exists to prevent.
    vm = {
        "reco": {"tag": "revise"},
        "flags": {
            "model_upgrade_available": False,
            "some_future_driver_out_of_band": {
                "value": 0.42, "band": "≤ ~10%", "requires_note": True,
            },
        },
    }
    pkt = build_packet(vm, role="board")
    guardrails = pkt["sections"]["guardrails"]
    fields = {g["field"] for g in guardrails}
    assert "some_future_driver_out_of_band" in fields
    entry = next(g for g in guardrails if g["field"] == "some_future_driver_out_of_band")
    assert entry["band"] == "≤ ~10%"
    assert "justification" in entry["note"].lower()
    # No hand-authored label exists for this key — a readable fallback (not the
    # raw snake_case key, not empty) still names the driver.
    assert entry["label"]
    assert entry["label"] != "some_future_driver_out_of_band"


def test_canonical_occupancy_flag_travels_into_the_packet():
    # The live proof: Task 6.3's occupancy_ratio_out_of_band flag (already in
    # _GUARDRAIL_LABELS ahead of time per the batch-2 review) fires for real on
    # the canonical House of Hope fixture (28.1% occupancy ratio) and must reach
    # the packet exactly like the pre-existing net-margin/share flags do.
    vm = to_view_model(build_canonical_result())
    assert vm["flags"]["occupancy_ratio_out_of_band"]["requires_note"] is True

    pkt = build_packet(vm, role="board")
    guardrails = pkt["sections"]["guardrails"]
    fields = {g["field"] for g in guardrails}
    assert "occupancy_ratio_out_of_band" in fields
    entry = next(g for g in guardrails if g["field"] == "occupancy_ratio_out_of_band")
    assert entry["label"] == "Occupancy ratio (Year 1)"

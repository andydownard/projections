"""RED first: regen_goldens.py must reproduce the CHECKED-IN goldens byte-for-byte.

This is the safety net for later engine changes: it proves the regenerator
recreates today's frozen `engine/tests/golden/*.json` bytes exactly, using the
SAME fixture builders and serialization `test_fixtures_frozen.py` asserts
against, before any engine math is allowed to move. If regen ever diverges
from the checked-in bytes with no engine change in the diff, that is a bug in
the regenerator (or an unintentional drift in the goldens), not a green light.
"""
import pathlib

from scripts.regen_goldens import GOLDEN_DIR, main, regen

REAL_GOLDENS = sorted(p.name for p in GOLDEN_DIR.glob("*.json"))


def test_golden_dir_has_the_four_named_fixtures():
    # Guards against a typo'd FIXTURES map silently regenerating nothing. The two
    # House of Hope twins plus the AGENTS.md Aggressive (§12.2 guardrail) and Grace
    # Mission (§12.4 loss / override) fixtures.
    assert REAL_GOLDENS == [
        "aggressive_flagged.json",
        "grace_mission_loss.json",
        "house_of_hope_canonical_60.json",
        "house_of_hope_design_parity_40.json",
    ]


def test_regen_reproduces_checked_in_goldens_byte_identical(tmp_path):
    exit_code = regen(golden_dir=tmp_path, check=False)
    assert exit_code == 0
    for name in REAL_GOLDENS:
        regenerated = (tmp_path / name).read_bytes()
        checked_in = (GOLDEN_DIR / name).read_bytes()
        assert regenerated == checked_in, f"{name} differs from regen output"


def test_check_flag_passes_against_checked_in_goldens():
    # --check must be non-destructive: it reads GOLDEN_DIR and never writes it.
    before = {p.name: p.read_bytes() for p in GOLDEN_DIR.glob("*.json")}
    assert regen(golden_dir=GOLDEN_DIR, check=True) == 0
    after = {p.name: p.read_bytes() for p in GOLDEN_DIR.glob("*.json")}
    assert before == after


def test_check_flag_fails_closed_on_a_diff(tmp_path):
    (tmp_path / "house_of_hope_canonical_60.json").write_text("{}\n")
    (tmp_path / "house_of_hope_design_parity_40.json").write_text("{}\n")
    assert regen(golden_dir=tmp_path, check=True) == 1


def test_cli_check_exits_zero_against_checked_in_goldens(capsys):
    exit_code = main(["--check"])
    assert exit_code == 0

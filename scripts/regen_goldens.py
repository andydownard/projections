#!/usr/bin/env python3
"""regen_goldens.py — deterministic regeneration of engine/tests/golden/*.json.

The frozen goldens (`engine/tests/test_fixtures_frozen.py`) exist to catch any
accidental drift in engine output: a change to the math must regenerate these
files in the SAME commit (a new `model_version`), never a silent flip. This
script is the one place that writes them, so "regenerate the goldens" always
means "run this," not "hand-edit JSON."

It imports the SAME fixture builders `engine/tests/conftest.py` exposes
(`build_canonical_result` / `build_design_parity_result`) and the SAME
view-model serializer (`engine.viewmodel.to_view_model`), then writes each
golden with the EXACT serialization `test_fixtures_frozen.py` compares
against: ``json.dumps(vm, indent=2, sort_keys=True) + "\\n"``.

Usage:
  python scripts/regen_goldens.py            # overwrite engine/tests/golden/*.json
  python scripts/regen_goldens.py --check     # exit 1 if any golden would change
  python scripts/regen_goldens.py --out DIR   # write elsewhere (used by tests)
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.tests.conftest import (  # noqa: E402
    build_aggressive_result,
    build_canonical_result,
    build_design_parity_result,
    build_grace_result,
    build_nnn_gross_check_result,
)
from engine.viewmodel import to_view_model  # noqa: E402

GOLDEN_DIR = ROOT / "engine" / "tests" / "golden"

# name -> zero-arg builder producing an engine.compute result for that fixture.
FIXTURES = {
    "house_of_hope_canonical_60.json": build_canonical_result,
    "house_of_hope_design_parity_40.json": build_design_parity_result,
    # The two named fixtures from AGENTS.md "Sample golden fixtures": the §12.2
    # guardrail case (Aggressive) and the §12.4 loss / override edge case (Grace).
    # build_grace_result bakes the Payroll#1 pin in — the frozen golden is Grace's
    # canonical WITH-override form.
    "aggressive_flagged.json": build_aggressive_result,
    "grace_mission_loss.json": build_grace_result,
    # NNN resolution pin (Task 6.4): escalator + lease deposit both apply to the
    # resolved occupancy INCLUDING nnn_opex_annual (the conservative reading).
    "nnn_gross_check.json": build_nnn_gross_check_result,
}


def serialize(vm: dict) -> str:
    """The frozen serialization `test_fixtures_frozen.py` compares against."""
    return json.dumps(vm, indent=2, sort_keys=True) + "\n"


def regen(golden_dir: pathlib.Path = GOLDEN_DIR, check: bool = False) -> int:
    """Write (or, with check=True, verify) every golden fixture.

    Returns 0 on success (all written / all match), 1 if `--check` finds a
    diff. Never partially writes under `--check` — it only reads.
    """
    exit_code = 0
    golden_dir = pathlib.Path(golden_dir)
    if not check:
        golden_dir.mkdir(parents=True, exist_ok=True)
    for filename, build in FIXTURES.items():
        text = serialize(to_view_model(build()))
        path = golden_dir / filename
        if check:
            current = path.read_text() if path.exists() else None
            if current != text:
                print(f"DIFF: {path}")
                exit_code = 1
            else:
                print(f"OK: {path}")
        else:
            path.write_text(text)
            print(f"wrote {path}")
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if regenerating would change any golden, instead of writing",
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=GOLDEN_DIR,
        help="directory to write goldens into (default: engine/tests/golden)",
    )
    args = parser.parse_args(argv)
    return regen(golden_dir=args.out, check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""scripts/verify_restore.py — CLI for the Litestream restore-drill check (OPS §4.4).

Thin shim over ``app.store.verify_restore.verify_restore``. Invoked by
``scripts/restore-db.sh`` after ``litestream restore``:

    python -m scripts.verify_restore <restored.db> --slug <known-view-slug>

Exit 0 + a one-line JSON report (the deploy-log line) on success; exit 1 with the
failure reason on any drill-acceptance failure.
"""
from __future__ import annotations

import argparse
import json
import sys

from app.store.verify_restore import RestoreVerificationError, verify_restore


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify a restored projections SQLite DB.")
    ap.add_argument("db_path", help="path to the restored SQLite file")
    ap.add_argument("--slug", required=True, help="known view_slug to round-trip")
    args = ap.parse_args(argv)
    try:
        report = verify_restore(args.db_path, slug=args.slug)
    except RestoreVerificationError as exc:
        print(f"RESTORE VERIFY FAILED: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())

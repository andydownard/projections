"""M7.3 path guard — Litestream MUST replicate the durable volume, never `/app`.

Regression #13 (CLAUDE.md regression registry; SECURITY.md §11): the timpager bug
replicated `/app/timpager.db` — a path on the EPHEMERAL container filesystem that
disappears on every redeploy, so the "backup" backed up nothing. For projections the
DB lives on the durable Railway volume at `/data/projections.db`; this locks that in
so a future edit to `litestream.yml` can never silently point replication at `/app`.
"""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LITESTREAM_YML = REPO / "litestream.yml"


def _config_text() -> str:
    return LITESTREAM_YML.read_text(encoding="utf-8")


def test_litestream_config_exists() -> None:
    assert LITESTREAM_YML.is_file(), "litestream.yml must exist (M0.7 deliverable)"


def test_replicates_the_durable_data_volume() -> None:
    # The db `path:` is the durable volume, exactly (regression #13).
    assert "path: /data/projections.db" in _config_text()


def test_never_references_the_ephemeral_app_path() -> None:
    # No replicated path may live under /app (the ephemeral container FS). Comments
    # that DESCRIBE the timpager `/app/timpager.db` bug are fine; config values aren't.
    for i, line in enumerate(_config_text().splitlines(), start=1):
        config_part = line.split("#", 1)[0]  # strip trailing/standalone comments
        assert "/app/" not in config_part, (
            f"litestream.yml:{i} replicates an /app path (regression #13): {line!r}"
        )
        assert not config_part.strip().startswith("- path: /app"), f"litestream.yml:{i}: {line!r}"


def test_db_path_is_a_single_data_volume_path() -> None:
    # Exactly one replicated DB, and it is the /data volume path — not /app, not /tmp.
    db_paths = [
        ln.split("path:", 1)[1].strip()
        for ln in _config_text().splitlines()
        if ln.strip().startswith("- path:")
    ]
    assert db_paths == ["/data/projections.db"]

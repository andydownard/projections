"""app/jsonutil.py — tiny shared JSON read helper.

The store and routers both read opaque JSON-object TEXT columns (`computed_json`,
`location_json`, `role_tokens_json`, …) that are valid JSON at write time but may
be NULL/empty. `loads_obj` collapses the repeated
``try: json.loads(raw or "{}") except JSONDecodeError: {}`` guard into ONE place so
every read site is identical (DRY) and a corrupt blob can never 500 a read.
"""
from __future__ import annotations

import json
from typing import Any


def loads_obj(raw: str | None) -> dict[str, Any]:
    """Parse a JSON-object column; return ``{}`` for NULL/empty/malformed input.

    The columns are app-written (always valid JSON objects), so the
    ``JSONDecodeError`` branch is defensive, not expected — it guarantees a read
    never raises on a corrupt blob.
    """
    try:
        return json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}

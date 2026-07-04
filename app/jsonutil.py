"""app/jsonutil.py — tiny shared JSON read/write helpers.

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


def dumps_finite(obj: Any) -> str:
    """Serialize a JSON-object column with ``allow_nan=False`` (review F1 class-kill).

    The stdlib default (``allow_nan=True``) would happily encode a stray
    ``NaN``/``Infinity``/``-Infinity`` float as the NON-standard JSON tokens
    ``NaN``/``Infinity``/``-Infinity`` — valid to `json` itself but rejected by any
    strict JSON parser (and by Starlette's own `JSONResponse`, which renders with
    `allow_nan=False`). That mismatch is exactly how a single bad PATCH used to brick
    a row permanently: the non-finite value passed field-level validation (a gap since
    closed — `_require_fraction`/`_require_min` now reject non-finite values outright),
    persisted here, then 500'd every subsequent read/restore of the same row forever.

    This is the backstop, not the primary defense: every value reaching this call
    should already be finite (validated request input, or engine output — the engine
    always emits explicit ``null``, never NaN/Infinity, PRD §12.4). If a non-finite
    value ever reaches here anyway (a future validator gap), raise here and fail the
    *request* (a loud 500) rather than silently writing an unbrickable row.
    """
    return json.dumps(obj, allow_nan=False)

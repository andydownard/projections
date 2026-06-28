"""Unit tests for app.jsonutil.loads_obj — the shared JSON-object read helper.

`loads_obj` collapses the `try: json.loads(raw or "{}") except JSONDecodeError:
{}` guard that the routers and the store apply when reading opaque JSON-object
TEXT columns (`computed_json`, `location_json`, `role_tokens_json`, …). These
cases pin its contract so the de-duplication stays behavior-preserving:

  * a NULL / empty / whitespace / malformed blob NEVER raises and yields ``{}``
    (a read can never 500 on a corrupt stored value);
  * a valid JSON object round-trips verbatim, preserving nesting, unicode, and
    JSON scalar types (numbers, bools, null).
"""
from __future__ import annotations

import json

from app.jsonutil import loads_obj


def test_none_returns_empty_dict():
    # NULL column (row.get(col) is None) -> {} (the `raw or "{}"` arm).
    assert loads_obj(None) == {}


def test_empty_string_returns_empty_dict():
    # Empty TEXT ("") is falsy, so it takes the `or "{}"` arm, not a decode error.
    assert loads_obj("") == {}


def test_explicit_empty_object():
    assert loads_obj("{}") == {}


def test_valid_object_round_trips():
    payload = {"a": 1, "b": "two", "c": [1, 2, 3], "d": {"nested": True}}
    assert loads_obj(json.dumps(payload)) == payload


def test_malformed_json_returns_empty_dict():
    # A corrupt blob must never raise — the defensive JSONDecodeError arm.
    assert loads_obj("{not valid json") == {}
    assert loads_obj("}{") == {}


def test_truncated_object_returns_empty_dict():
    assert loads_obj('{"a": 1') == {}


def test_whitespace_only_returns_empty_dict():
    # Whitespace is non-empty (truthy) but not valid JSON -> JSONDecodeError -> {}.
    assert loads_obj("   ") == {}


def test_unicode_values_preserved():
    assert loads_obj('{"city": "Köln", "mark": "✓"}') == {"city": "Köln", "mark": "✓"}


def test_json_scalar_types_preserved():
    # Mirrors a stored {raw, display} money cell plus bool/null leaves.
    raw = '{"raw": 426911, "display": "$426,911", "ok": false, "missing": null}'
    assert loads_obj(raw) == {
        "raw": 426911,
        "display": "$426,911",
        "ok": False,
        "missing": None,
    }


def test_always_returns_a_dict_instance():
    assert isinstance(loads_obj('{"x": 1}'), dict)
    assert isinstance(loads_obj(None), dict)
    assert isinstance(loads_obj("garbage"), dict)

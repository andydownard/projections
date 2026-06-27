"""Smoke: harness + fixtures + the no-real-network guard wire up (PE11 #130)."""
from __future__ import annotations

import httpx
import pytest

from app.tests.ai_safety.harness import VALID_BODY, money_tokens, stored_view_model


def test_projection_fixture_computes_grounded_figures(store, projection):
    vm = stored_view_model(store, projection["view_slug"])
    assert money_tokens(vm), "engine must emit at least one grounded $ figure"
    assert VALID_BODY["name"] == "House of Hope"


def test_no_real_network_guard_is_active():
    with pytest.raises(AssertionError):
        httpx.post("https://api.anthropic.com/v1/messages", json={})

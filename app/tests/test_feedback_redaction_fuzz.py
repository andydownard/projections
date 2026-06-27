"""#82 (QA-8) — feedback-redaction fuzz over a populated-projection's fields.

The #1 data-leak control (PRD §22, SECURITY §9, CLAUDE Regression Registry #7):
a GitHub feedback issue must carry ONLY a random ``support_id`` + the server
allowlisted context — never a ``view_slug``, token, recovery code, resolvable
link, financial figure, or email.

Where the M6.1 leak test pins the EXACT payload for a fixed adversarial input,
this suite *fuzzes*: it draws leak candidates shaped like a fully-populated
projection (the live ``view_slug``, owner/edit tokens, a recovery code, a
resolvable ``/p/<slug>/edit`` URL, formatted money/percents, an owner email)
and, for many seeded-random combinations, asserts the assembled GitHub payload
AND the persisted ``context_json`` match NONE of the money/percent/slug/token/
url/email pattern classes — only the support_id and the safe context survive.

Deterministic: a fixed seed is used and printed on any failure so a redaction
hole is reproducible. A benign-text negative control proves the matchers do not
pass by over-redacting everything.
"""
import json
import re

import pytest
from fastapi.testclient import TestClient

import app.routers.feedback as feedback_mod
from app.feedback.redact import SAFE_CONTEXT_KEYS
from app.main import create_app
from app.ratelimit import reset_rate_limits
from app.store import get_store
from app.store.sqlite import SqliteStore
from engine.model import MODEL_VERSION

# Reproducible seed (printed on failure). Bump intentionally, never randomly.
SEED = 20260627
N_ITERATIONS = 200


@pytest.fixture()
def captured(monkeypatch):
    """Stub the GitHub filer; capture every outbound payload it would send."""
    calls = []

    def _fake_file(payload: dict) -> str:
        calls.append(payload)
        return "https://github.com/rallytasks/projections/issues/123"

    monkeypatch.setattr(feedback_mod, "file_github_issue", _fake_file)
    return calls


@pytest.fixture()
def client():
    reset_rate_limits()
    store = SqliteStore(":memory:")
    store.migrate()
    app = create_app()
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app)


# --- a fully-populated projection's leak surface (what an issue must NEVER carry)
LIVE_SLUG = "p_8xKQ9mZ2vR7sT4uW6yA1bC3"  # token-shaped view_slug (>=128-bit)
OWNER_TOKEN = "9LpQ2vR7sT4uW6yA1bC3dE5fG0hJ2kL4mN6pQ8rS0tU"  # token_urlsafe shape
EDIT_FRAGMENT = "edit-7sT4uW6yA1bC3dE5fG0hJ2kL9LpQ2vR"
RECOVERY_CODE = "REC-8x9LpQ2vR7sT4uW"
RESOLVABLE_URL = f"https://projections.thriftly.com/p/{LIVE_SLUG}/edit#{EDIT_FRAGMENT}"
OWNER_EMAIL = "treasurer@hopechurch.org"
# Financial figures a populated computed_json would expose.
MONEY = ["$426,911", "$277,990", "$17.08", "$(12,500)", "$25,000"]
PERCENTS = ["6.0%", "11.0%", "39%", "3.75%", "0.8%"]

LEAK_CANDIDATES = [
    LIVE_SLUG,
    OWNER_TOKEN,
    EDIT_FRAGMENT,
    RECOVERY_CODE,
    RESOLVABLE_URL,
    OWNER_EMAIL,
    *MONEY,
    *PERCENTS,
]

# Literal leaks that must never appear verbatim in a sink.
_LITERAL_LEAKS = [LIVE_SLUG, OWNER_TOKEN, EDIT_FRAGMENT, RECOVERY_CODE, OWNER_EMAIL]

# Pattern-class matchers (mirror SECURITY §9 / the redactor's own families). The
# assembled payload must match NONE of these.
PATTERN_CLASSES = {
    "money": re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?"),
    "percent": re.compile(r"\b\d+(?:\.\d+)?\s?%"),
    "url": re.compile(r"https?://", re.IGNORECASE),
    "bearer": re.compile(r"\bBearer\b", re.IGNORECASE),
    "hientropy_token": re.compile(
        r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{22,}\b"
    ),
    "recovery": re.compile(r"\bREC-[A-Za-z0-9]{6,}\b"),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
}

_SUPPORT_ID_RE = re.compile(r"\bSUP-[A-Z0-9]{6}\b")

# Benign filler that must round-trip (no leak shapes inside).
_BENIGN_WORDS = [
    "the", "chart", "marker", "is", "off", "by", "one", "month", "please",
    "fix", "the", "banner", "label", "tooltip", "spacing", "looks", "wrong",
    "on", "mobile", "thanks", "team", "great", "work", "small", "nit", "here",
]


def _assert_clean(blob: str, *, where: str, seed_info: str) -> None:
    """Fail loud: print the offending substring + pattern class + seed info."""
    for name, rx in PATTERN_CLASSES.items():
        m = rx.search(blob)
        assert m is None, (
            f"[{where}] leak-class {name!r} matched {m.group(0)!r} "
            f"({seed_info}); blob={blob!r}"
        )
    for lit in _LITERAL_LEAKS:
        assert lit not in blob, (
            f"[{where}] literal leak {lit!r} survived ({seed_info}); blob={blob!r}"
        )


def _post(client, payload, ip):
    """POST with a unique source IP so the per-IP rate-limit never trips."""
    return client.post(
        "/api/feedback", json=payload, headers={"x-forwarded-for": ip}
    )


# --- 1) Explicit leak-class matrix: one named case per class -----------------
@pytest.mark.parametrize(
    "field, value",
    [
        ("slug_in_title", LIVE_SLUG),
        ("owner_token", OWNER_TOKEN),
        ("edit_fragment", EDIT_FRAGMENT),
        ("recovery_code", RECOVERY_CODE),
        ("resolvable_url", RESOLVABLE_URL),
        ("owner_email", OWNER_EMAIL),
        ("money", "capital " + MONEY[1]),
        ("percent", "margin " + PERCENTS[0]),
    ],
)
def test_leak_class_never_reaches_payload(client, captured, field, value):
    r = _post(
        client,
        {
            "type": "bug",
            "title": f"problem with {value}",
            "description": f"details: {value} please review",
            "route": "/p/example/edit",
            # also stuff the (now-ignored) client context fields
            "context": {"model_version": value},
        },
        ip="203.0.113.7",
    )
    assert r.status_code == 201, r.text
    out_blob = json.dumps(captured[0])
    _assert_clean(out_blob, where=f"matrix:{field}", seed_info="parametrized")
    assert _SUPPORT_ID_RE.search(out_blob)


# --- 2) Seeded fuzz over populated-projection-derived inputs -----------------
def test_fuzz_populated_projection_never_leaks(client, captured):
    import random

    rng = random.Random(SEED)

    for i in range(N_ITERATIONS):
        seed_info = f"seed={SEED} iteration={i}"

        def _mix(n_leaks: int) -> str:
            parts = [rng.choice(_BENIGN_WORDS) for _ in range(rng.randint(2, 6))]
            for _ in range(n_leaks):
                parts.insert(rng.randint(0, len(parts)), rng.choice(LEAK_CANDIDATES))
            return " ".join(parts)

        # A populated projection's slug may arrive via context (own_slug) OR be
        # pasted into free text; cover both branches randomly.
        ctx = {}
        if rng.random() < 0.5:
            ctx["view_slug"] = LIVE_SLUG
        # The (ignored) client context fields are attacker-controlled free text.
        ctx["model_version"] = _mix(rng.randint(0, 3))

        payload = {
            "type": rng.choice(["bug", "idea", "other", _mix(2)]),
            "title": _mix(rng.randint(1, 3)),
            "description": _mix(rng.randint(1, 5)),
            "email": OWNER_EMAIL if rng.random() < 0.5 else None,
            "route": rng.choice(
                [
                    f"/p/{LIVE_SLUG}/edit#{EDIT_FRAGMENT}",
                    f"/r/{LIVE_SLUG}",
                    f"/dashboard/{OWNER_TOKEN}",  # token in a non-/p segment
                    "/",
                ]
            ),
            "context": ctx,
        }

        ip = f"198.51.{i // 256}.{i % 256}"
        r = _post(client, payload, ip)
        assert r.status_code == 201, f"{seed_info}: {r.text}"
        sid = r.json()["support_id"]

        # (a) outbound GitHub-bound payload
        out_blob = json.dumps(captured[-1])
        _assert_clean(out_blob, where="fuzz:outbound", seed_info=seed_info)
        # exactly one support_id, and it is the one returned.
        assert _SUPPORT_ID_RE.findall(out_blob) == [sid], seed_info
        # only the server-allowlisted context keys survive.
        assert set(captured[-1]["context"]) == set(SAFE_CONTEXT_KEYS), seed_info
        assert captured[-1]["context"]["model_version"] == MODEL_VERSION, seed_info
        assert captured[-1]["context"]["type"] in {"bug", "idea", "other"}, seed_info

        # (b) belt-and-suspenders: the persisted context_json mirrors it and
        #     carries no leak; github_issue_url is absent from the API response.
        store = list(client.app.dependency_overrides.values())[0]()
        row = store._conn.execute(
            "SELECT context_json FROM feedback WHERE support_id = ?", (sid,)
        ).fetchone()
        _assert_clean(row["context_json"], where="fuzz:context_json", seed_info=seed_info)
        assert "github_issue_url" not in r.json(), seed_info


# --- 3) Negative control: benign text round-trips (matchers aren't trivial) ---
def test_benign_text_round_trips_unredacted(client, captured):
    benign_title = "The chart marker is off by one month"
    benign_body = "Please fix the banner label and the tooltip spacing on mobile."
    r = _post(
        client,
        {
            "type": "idea",
            "title": benign_title,
            "description": benign_body,
            "route": "/p/example/edit",
        },
        ip="203.0.113.9",
    )
    assert r.status_code == 201, r.text
    payload = captured[0]
    # The benign text survives verbatim — nothing was over-redacted.
    assert payload["title"] == benign_title
    assert payload["body"] == benign_body
    assert "[redacted]" not in json.dumps(payload)
    assert "[link removed]" not in json.dumps(payload)

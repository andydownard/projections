"""Numeric discipline + the single formatting authority (§6.5, §9.2).

Compute in Decimal internally; round ONLY at display/compare. Every money/percent
value the engine emits is a dual-value dict ``{"raw": <number|None>, "display": <str>}``
so the client never re-derives money/percent formatting.

Rounding authority (the side the golden gate's <$0.50 / 0.1pp tolerance absorbs):
the Python engine rounds **money to whole dollars** and **percent to 0.1pp**, half-up.
"""
from decimal import ROUND_HALF_UP, Decimal

_CENT = Decimal("0.01")
_DOLLAR = Decimal("1")
_TENTH_PCT = Decimal("0.1")  # in percentage points


def D(value):
    """Coerce any scalar to an exact Decimal without float poisoning."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        # repr() gives the shortest round-trippable decimal for the float
        return Decimal(repr(value))
    return Decimal(str(value))


def round_dollars(value):
    """Round a Decimal to whole dollars, half-up (the engine's money rounding)."""
    return D(value).quantize(_DOLLAR, rounding=ROUND_HALF_UP)


def _fmt_dollars(value):
    """'$426,911' for non-negative; '($12,401)' for negative."""
    whole = round_dollars(value)
    if whole < 0:
        return f"(${-whole:,.0f})"
    return f"${whole:,.0f}"


def money_view(value):
    # Single rounding authority: raw and display are derived from the SAME canonical
    # value — the exact Decimal the emitted float represents (``D(repr(float(...)))``).
    # Without this, raw=float(value) and display=round_dollars(Decimal value) round two
    # DIFFERENT numbers, so a value like 4712.4999… (exact 4712.5) emitted raw=4712.5
    # (rounds UP to $4,713) while display rounded the fuller Decimal DOWN to $4,712 — the
    # {raw,display} pair disagreeing by $1 on any half-dollar the float lands on. Quantizing
    # to the float-visible value ONCE makes display round-trip to raw BY CONSTRUCTION for
    # every money pair, without changing raw's float semantics (2.7.0; property 4).
    canonical = D(repr(float(D(value))))
    return {"raw": float(canonical), "display": _fmt_dollars(canonical)}


def pct_view(value):
    """``value`` is a fraction (0.1123 -> '11.2%'). Rounded to 0.1pp half-up."""
    points = (D(value) * 100).quantize(_TENTH_PCT, rounding=ROUND_HALF_UP)
    if points < 0:
        body = f"({-points:.1f}%)"
    else:
        body = f"{points:.1f}%"
    return {"raw": float(D(value)), "display": body}


def number_view(value):
    """Plain count, thousands-separated, whole number."""
    whole = round_dollars(value)
    return {"raw": float(D(value)), "display": f"{whole:,.0f}"}


def na_view():
    """Explicit N/A sentinel (§8): raw null, never a 0 masquerading as N/A."""
    return {"raw": None, "display": "N/A"}

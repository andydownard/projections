"""RED first: Decimal/cents discipline + dual-value {raw, display} (§6.5, §9.2)."""
from decimal import Decimal

import pytest

from engine import money


def test_d_coerces_to_exact_decimal():
    assert money.D("17.08") == Decimal("17.08")
    assert money.D(3) == Decimal("3")
    assert money.D(Decimal("0.60")) == Decimal("0.60")
    # floats must not poison precision
    assert money.D(0.1) == Decimal("0.1")


def test_money_view_whole_dollars():
    v = money.money_view(Decimal("426911.4567"))
    assert v["raw"] == pytest.approx(426911.4567, abs=1e-6)
    assert v["display"] == "$426,911"


def test_money_view_negative_parentheses():
    v = money.money_view(Decimal("-12400.50"))
    assert v["display"] == "($12,401)"  # rounded magnitude, parentheses, no minus sign
    assert v["raw"] < 0


def test_money_view_zero():
    assert money.money_view(Decimal("0"))["display"] == "$0"


def test_pct_view_one_decimal_point():
    v = money.pct_view(Decimal("0.1123"))
    assert v["display"] == "11.2%"
    assert v["raw"] == pytest.approx(0.1123, abs=1e-9)


def test_pct_view_negative():
    assert money.pct_view(Decimal("-0.029"))["display"] == "(2.9%)"


def test_na_view_is_null_with_no_display():
    v = money.na_view()
    assert v["raw"] is None
    assert v["display"] == "N/A"


def test_number_view_plain_count():
    v = money.number_view(Decimal("5121.7"))
    assert v["display"] == "5,122"
    assert v["raw"] == pytest.approx(5121.7, abs=1e-6)


def test_round_money_half_up_to_dollars():
    assert money.round_dollars(Decimal("0.50")) == Decimal("1")
    assert money.round_dollars(Decimal("0.49")) == Decimal("0")
    assert money.round_dollars(Decimal("-0.50")) == Decimal("-1")

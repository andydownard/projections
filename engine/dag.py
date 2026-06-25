"""Override DAG: pin validation, topological resolution rules, stale flags (§7).

Cell overrides are pins on a DAG keyed ``"{node}#{year}"``. The actual numeric
resolution happens inline in engine.compute.compute_annual (a pinned component
uses its value; unpinned nodes compute from possibly-pinned inputs). This module
owns the *rules* that guard that resolution at the API boundary:

  - Derived rows / totals / margins / KPIs / decision metrics are NON-PINNABLE;
    a pin write to one is rejected (PinRejected) — not merely hidden in the UI,
    so the statement always foots.
  - No upstream back-solve: pinning a downstream component does not mutate any
    upstream input; an upstream input that no longer drives a pinned downstream
    value is reported as *stale* (the "no longer drives a pinned value" hint).
"""
from __future__ import annotations

# Component lines that MAY be pinned (the input drivers + component expense lines).
PINNABLE_NODES = frozenset({
    # input drivers
    "share", "donation_value", "donations_per_hh", "basket", "sqft",
    "rent_per_sqft", "occupancy", "labor_pct", "marketing_pct", "supplies_pct",
    "card_pct", "payroll_tax_pct", "salvage_pct", "escalator",
    # component expense lines
    "Payroll", "Marketing & outreach", "Supplies & processing", "Credit card fees",
    "Payroll taxes", "Rent", "Insurance liability", "Internet, Phones",
    "Pest control", "Repairs/maintenance", "Security system",
    "Utilities/trash service",
})

# Derived / total / margin / KPI / decision nodes — NEVER pinnable.
NON_PINNABLE_NODES = frozenset({
    "total_revenue", "total_expenses", "net_profit", "net_margin",
    "customers", "salvage_sales", "donating_households", "donations",
    "break_even_month", "startup_capital_required", "first_year_cash_gap",
    "cash_runway_months", "simple_payback_years", "revenue_cagr",
})


class PinRejected(ValueError):
    """Raised when a pin targets a non-pinnable node or has a malformed key.

    Carries the offending ``node`` (when parseable) so the API can echo it in the
    422 ``node_not_pinnable`` body without re-parsing the key.
    """

    def __init__(self, message: str, node: str | None = None) -> None:
        super().__init__(message)
        self.node = node


def parse_key(key: str):
    """'Payroll#1' -> ('Payroll', 1). Raises PinRejected on malformed keys."""
    if "#" not in key:
        raise PinRejected(f"override key must be '{{node}}#{{year}}': {key!r}")
    node, _, year_s = key.rpartition("#")
    if not node:
        raise PinRejected(f"override key missing node: {key!r}")
    try:
        year = int(year_s)
    except ValueError:
        raise PinRejected(f"override key year not an int: {key!r}")
    if year not in (1, 2, 3):
        raise PinRejected(f"override year out of range (1..3): {key!r}")
    return node, year


def validate_pin(key: str):
    """Accept a legal component pin; reject derived/total/KPI/decision pins."""
    node, _year = parse_key(key)
    if node in NON_PINNABLE_NODES:
        raise PinRejected(
            f"node is not pinnable (derived/total/KPI): {node!r}", node=node)
    if node not in PINNABLE_NODES:
        raise PinRejected(f"unknown pinnable node: {node!r}", node=node)
    return True


def validate_all(overrides: dict):
    """Validate every key in an overrides map; raises on the first illegal pin."""
    for key in overrides:
        validate_pin(key)
    return True


# Upstream-input dependency map (node -> the upstream input nodes that feed it).
# Used only to surface the *stale* hint; it never back-solves.
_UPSTREAM_OF = {
    "Payroll": ("share", "labor_pct"),
    "Payroll taxes": ("share", "labor_pct", "payroll_tax_pct"),
    "Marketing & outreach": ("share", "marketing_pct"),
    "Supplies & processing": ("share", "supplies_pct"),
    "Credit card fees": ("share", "card_pct"),
    "Rent": ("occupancy", "escalator"),
}


# Downstream derived rows a pinned component rewrites (foots through to totals).
# Used only to populate overrides[].affected for the Override Inspector; the engine
# always re-foots totals over components, so this is descriptive, not computational.
_TOTALS = ["Total Expenses", "Net profit", "Net margin"]
_AFFECTED_OF = {
    "Payroll": ["Payroll taxes", *_TOTALS],
    "share": ["Donating households", "Annual donations", "Retail Sales",
              "Salvage Sales", "Total Revenue", "Total Expenses",
              "Net profit", "Net margin"],
}


def affected_rows(node: str):
    """Derived/total rows that a pin on ``node`` rewrites (Override Inspector).

    Any pinned expense component foots through to the expense total, net, and
    margin; a few nodes (Payroll, share) additionally drive an intermediate
    derived line. Order is presentation order (component-local first, then totals).
    """
    return list(_AFFECTED_OF.get(node, list(_TOTALS)))


def stale_upstream(overrides: dict):
    """Return the set of upstream input keys that no longer drive a pinned value.

    When a downstream component is pinned to a hard value, its upstream inputs
    (for that year) no longer affect that pinned number — they are 'stale' for it.
    """
    stale = set()
    for key in overrides:
        node, year = parse_key(key)
        for up in _UPSTREAM_OF.get(node, ()):  # pragma: no branch
            up_key = f"{up}#{year}"
            if up_key not in overrides:
                stale.add(up_key)
    return stale

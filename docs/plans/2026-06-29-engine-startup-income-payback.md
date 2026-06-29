# Engine: Year-1 income includes startup + payback resolves to "Month N"

**Epic:** GitHub #321 — *engine: income includes startup + payback fix*
**Branch:** `feat/engine-startup-income-payback`
**Status:** Phase 1 — SPEC + RED tests (this doc). Phase 2 (implementation + golden
regeneration + DOCS-CODE) is gated on review approval. **MONEY / golden-gate change.**

This is a versioned, server-authoritative math change. It touches the one math
authority (`engine/`), so the three-way golden gate (server compute == stored
`computed_json` == LibreOffice recalc of the `.xlsx`, `< $0.50` / `< 0.1pp`, zero
formula errors) is CI-blocking and must stay green **with and without overrides**.

---

## 0. Owner decisions (locked — do not relitigate in Phase 2)

1. **INCOME = full Year-1 startup hit.** The *reported* Year-1 net income subtracts the
   one-time startup total:
   `reported_net[1] = total_rev[1] − total_exp[1] − startup_total`.
   Years 2–5 stay operating net (unchanged). The 5-year "Net income" row, the
   `incomeSeries`, the "Net income" KPI, and the `.xlsx` "Net income" Year-1 cell all
   reflect the hit; the `.xlsx` Year-1 formula subtracts the **Total Startup Costs**
   cell so the in-sheet relationship still foots to the server net.

2. **PAYBACK = real "Month N" from grand opening.** Extend the monthly model beyond the
   12 Year-1 operating months across the full 5-year horizon, so payback resolves to
   the first project-month where **cumulative cash ≥ 0** (startup fully recovered).
   The web view-model (`engine/viewmodel.py:126`, `:165`), the `.xlsx`
   (`engine/xlsx.py:235`), and the card-list (`app/store/card_summary.py:51`) all agree
   on the **same** definition and display ("Month N").

---

## 1. New per-year net & margin definitions

We carry **two** nets through the engine and expose each where it belongs. This is the
crux of the change; everything else follows from it.

| Quantity | Definition | Where it lives | Notes |
|---|---|---|---|
| **`operating_net[y]`** | `total_rev[y] − total_exp[y]` | `AnnualYear.net` (the **existing** field, **unchanged**) | Drives the monthly roll-up, decision metrics, sensitivity re-runs, the recommendation, and the displayed Net **margin** + §12.2 margin guardrail. |
| **`reported_net[y]`** | `operating_net[y]` for `y ∈ {2,3,4,5}`; `operating_net[1] − startup_total` for `y = 1` | **NEW** `AnnualYear.reported_net` (set in `compute()` once `startup_total` is known) | The user-facing "Net income" surfaces (row, KPI, `incomeSeries`). |

**Why keep `AnnualYear.net` as operating net (do NOT redefine it):** the recommendation
engine (`decision._recommend`) gates on `y1.net <= 0` in two branches, `simple_payback`
on `y1.net > 0`, the sensitivity `_scenario_net` returns `years[1].net`, and
`monthly.build_monthly` rolls each year's operating net into months. If `.net` became
startup-inclusive, the design-parity fixture's Year-1 net would flip from `+$47,359` to
`−$191,141`, flipping its verdict away from "proceed" and breaking
`test_design_parity_capital_matches_appendix_d_headline` /
`test_payback_present_when_y1_net_positive`. So `.net` stays operating; `reported_net`
is purely additive and is consumed only by the income display surfaces.

**`reported_net` is computed in the engine, not the view-model.** Subtracting startup is
*math*; `engine/viewmodel.py` is the format authority only. `compute()` sets
`years[1].reported_net = years[1].net − startup_total` and
`years[y].reported_net = years[y].net` for `y ≥ 2`, after `startup_total` is resolved.

### Margin (recommendation: keep the §12.2 guardrail on OPERATING margin)

The displayed **Net margin** and the §12.2 `> 30%` net-margin guardrail both stay on
**operating** economics:

```
margin[y] = operating_net[y] / total_rev[y]        # = AnnualYear.margin, UNCHANGED
```

Rationale: the `> 30%` guardrail means "an implausibly-high *operating* margin for a new
store." A one-time capital outlay (startup) is not an operating cost; folding it into
Year-1 margin would push the Year-1 margin to `≈ −44.8%` for the design-parity case and
silence the guardrail's actual signal. So:

- `AnnualYear.margin` stays operating (no code change).
- `decision.build_flags` net-margin guardrail reads operating margin (no code change).
- **The Net income row and the Net margin row are intentionally decoupled in Year 1.**
  Year-1 will legitimately show a *negative* Net income next to a *positive* Net margin
  (operating health is good; Year-1 net is dragged negative by one-time startup). This
  is honest and is the owner's chosen framing; surface a short label/footnote in the UI
  ("Year-1 net includes one-time startup costs") — a UI follow-up, additive, not in this
  engine epic. Locked by `test_net_margin_row_stays_operating_not_startup_inclusive`.

---

## 2. Monthly-model extension (the payback enabler)

### How many months
The operating ramp now spans the **full 5-year horizon: 60 operating months**
(`G .. G+59`). The uniform project-month timeline becomes
`N = max(G + 59, last scheduled month)` (was `G + 11`). Pre-opening months `1..G-1`
are unchanged (first-class P&L months carrying only their scheduled costs).

### How each month past month 12 is derived
Reuse the **existing ramp mechanism** (`monthly._distribute`, last bucket absorbs the
Decimal residual). Each year `y`'s annual lines are split across that year's 12 months:

- revenue split by `_REVENUE_WEIGHTS`,
- payroll split by `_PAYROLL_WEIGHTS`,
- all other operating expense split by `_REVENUE_WEIGHTS`,
- `net = rev_part − (payroll_part + other_part)`.

This reuses the Year-1 S-curve weights as a **deterministic intra-year allocation** for
years 2–5 (not a seasonality claim); it keeps the per-year roll-up penny-exact and is
emitted under the existing `flags.ramp_low_confidence`. *Documented allocation choice:*
the intra-year shape for years 2–5 affects only the **exact** payback month by a few
positions, never the annual totals, capital, break-even, or cash gap. (Alternative: a
flat `1/12` split for years 2–5; reuse-the-ramp is recommended for code reuse and a
single distribution path.)

`build_monthly` signature changes from `build_monthly(annual_y1, ...)` to taking the
full `annual` dict (`compute.py:352` passes `years` instead of `years[1]`). The Year-1
portion (`G..G+11`, the S-curve ramp, its values) is **byte-unchanged**.

### Penny-exact roll-up (Regression #15, now per year)
For **every** year `y`: `sum(monthly net | rev | exp over its 12 months) == annual[y]`
operating totals, exactly (Decimal, residual in the last bucket). Locked by
`test_annual_rolls_up_from_extended_monthly_series`.

### Year-1-anchored metrics MUST stay byte-unchanged
Extending the series past Year 1 must not move `capital`, `break_even_month`, or
`first_year_cash_gap`. **This requires explicit scoping**, because for the *canonical*
(60% labor) fixture Year 2 is also an operating loss (`−$12,811`), so the global cash
trough would otherwise drift into Year 2 and inflate capital. Required scoping:

| Metric | Current code | Phase-2 scoping | Effect on goldens |
|---|---|---|---|
| `first_year_cash_gap` | `min(cumCash) for G ≤ m ≤ G+11` (`decision.py:126`) | **unchanged** (already Year-1 window) | byte-identical |
| `startup_capital_required` | `min(cumCash) over ALL months` (`decision.py:115`) | scope to `m.index ≤ G+11` (pre-open + Year-1 window) | byte-identical for goldens (G=1, no post-window cost ⇒ same set) |
| `break_even_month` | sustained-non-negative over **all** `op_nets` (`monthly.py:148`) | compute over the **first 12** operating months only | byte-identical (canonical Month 9, design-parity Month 5) |
| `cash_runway_months` | count before first negative (`decision.py:88`) | unchanged (first-negative is early; extension adds only later months) | byte-identical |

> Side effect to note for review: scoping `capital` to `m.index ≤ G+11` means a cost
> scheduled **beyond** the Year-1 operating window (e.g. a Year-3 refit at month 30) no
> longer raises the *launch* capital headline. This is consistent with the #182
> philosophy already applied to `first_year_cash_gap` (Year-1-anchored funding), and no
> existing test asserts the contrary. Flagged here so the reviewer ratifies it.

---

## 3. Payback definition & display

```
payback_month = first project-month m where cumulativeCash[m] ≥ 0,
                occurring AFTER cumulative cash has gone negative
                (i.e. the startup outlay is fully recovered).
                None ⇒ N/A-with-reason (never 0) when unreached within the 60-month horizon.
```

- **Cash basis** (replaces the current `decision.py:139-152` "cumulative *operating
  profit* since opening ≥ startup_total"). For the all-startup-at-opening case the two
  are arithmetically identical (so the existing recovered-case test keeps the same
  month); the cash basis is strictly more correct when costs are timed (it accounts for
  *when* outflows land), and it is what lets payback span years 2–5.
- **Guard against the pre-opening false-positive:** require a prior negative month, so
  the leading `cumulativeCash == 0` pre-opening months (before any spend) are not read
  as "recovered at month 1." (If cash never goes negative — no startup — payback is the
  grand-opening month; an unreachable edge in practice, documented.)
- **Display:** `engine.viewmodel._milestone(...)` already renders `{raw, display:
  "Month N"}` + a `duration` ("30 months") from grand opening; no display code changes,
  it now simply receives a non-`None` month for viable cases.

Worked example (design-parity / Aurora-class, `startup_total = $238,500`, all at
opening): cumulative operating net reaches `$238,500` during Year 3
(end-Y2 `$156,937` < `$238,500` < end-Y3 `$328,627`), so `payback_month ≈ Month 30`.
The canonical loss fixture's 5-year cumulative operating net is `≈ +$40,128 < $238,500`,
so it **stays** N/A-with-reason. Locked by
`test_positive_operating_net_yields_finite_payback_month` and
`test_canonical_loss_payback_stays_na_within_horizon`.

---

## 4. Exhaustive change list (Phase 2)

### 4.1 Engine — `engine/compute.py`
- `AnnualYear`: add field `reported_net: Decimal` (Year-1 startup-inclusive).
- `compute()`: after `startup_total` is known, set `years[1].reported_net = years[1].net
  − startup_total` and `years[y].reported_net = years[y].net` (y ≥ 2).
- `compute()`: pass the full `years` dict to `build_monthly` (was `years[1]`).
- `model_version` / `compute_schema_version` bump (see §6).

### 4.2 Engine — `engine/monthly.py`
- `build_monthly(annual, assumptions, opening_month_number, startup_by_month)`: accept
  the full annual dict; emit 60 operating months (`G..G+59`); distribute each year's
  annual lines into 12 monthly slices via `_distribute` (penny-exact).
- `N = max(G + 59, last scheduled month)`.
- Year-1 ramp (`G..G+11`) values byte-unchanged.
- **break-even** computed over the first 12 operating months only (Year-1 ramp).

### 4.3 Engine — `engine/decision.py`
- **Payback** (`decision.py:139-152`): cash-basis first-cumulative-cash-≥0-after-negative
  over the extended series; N/A-with-reason flag when unreached.
- **Capital** (`decision.py:115`): scope cumulative-cash trough to `m.index ≤ G+11`.
- `first_year_cash_gap`, `cash_runway`, sensitivity, CAGR, `simple_payback_years`,
  `break_even_revenue`, `_recommend`: **unchanged** (all read operating `.net`).
- `simple_payback_years` (operating `startup/net[1]`) retained internally for its unit
  tests; **no longer rendered** in the `.xlsx` (see §4.5).

### 4.4 Engine — `engine/viewmodel.py`
- `kpis` "Net income" value → `money_view(annual[1].reported_net)`.
- `incomeSeries` → `[reported_net[1], net[2], net[3], net[4], net[5]]`.
- `rows` "Net income" cells → `reported_net` per year (Y1 startup-inclusive; Y2–Y5 same
  as today). Driver-row helper for "Net income" reads `reported_net`.
- `year5Income` → unchanged (`annual[5].net`, == reported for Y5).
- `milestones.payback` (`:126`) & "Payback period" KPI (`:165`): unchanged code; now
  resolve to a real month for viable cases.
- "Net margin" row + KPI: **unchanged** (operating margin).
- `monthly[]`: now 60 rows (same field shape).

### 4.5 Engine — `engine/xlsx.py`
- **Net income Year-1 cell** (`xlsx.py:202`): formula becomes
  `=B{tr}-B{te}-B{startup_total_row}` (subtract Total Startup Costs); Y2–Y5 stay
  `=C{tr}-C{te}` etc. Requires knowing `startup_total_row` when writing the Net income
  line — the startup block is currently built *after* the projection table, so either
  (a) pre-compute the startup-block row offset, or (b) write the Net income Y1 formula in
  a second pass after the startup block lands. (Excel forward-references resolve fine on
  recalc.) Locked by `test_xlsx_net_income_year1_subtracts_total_startup`.
- **Net margin row** (`xlsx.py:205-206`): change from `=…{npr}/{tr}` to
  `=IF(B{tr}=0,"",(B{tr}-B{te})/B{tr})` (operating margin, **decoupled** from the
  startup-adjusted Net income cell) so the golden-gate Net-margin reconcile keeps
  matching the operating margin in the view-model.
- **"Simple payback (years)" cell** (`xlsx.py:234-240`): **remove**. It is a years-based
  division that now disagrees with the "Month N" payback. The existing **MILESTONES
  "Payback"** row (`xlsx.py:338`) already renders the engine's `_milestone(...)` "Month
  N"/N/A and now resolves for viable cases — it is the single `.xlsx` payback surface,
  matching the web + card. (Removing this guarded `=IF(net<=0,"",…)` cell also removes
  one division from the recalc gate.)
- `_build_monthly_tab`: now writes 60+ rows (no logic change; the loop already iterates
  `result.monthly`).

### 4.6 App — `app/store/card_summary.py`
- `payback` (`:51`) already reads `milestones.payback`; `y1_net` reads the "Net income"
  KPI; `income_series` reads `incomeSeries`. **No code change** — these flow through
  automatically and now carry the new values consistently with the detail page.

### 4.7 Frontend (downstream consequence, confirm with Design in Phase 2)
- The cash-flow chart's `monthly[]` grows from 12 to 60 points (the payback crossing is
  now visible). Pure rendering; no engine dependency. Flag to `/design-review` since the
  PRD framed this tab as the *Year-1 launch* cash-flow.

---

## 5. Goldens that change & version bump (Phase 1 deliverable 3)

### Goldens to regenerate in Phase 2
Both frozen view-model fixtures change and must be regenerated in the implementation
commit (never a silent flip):

- `engine/tests/golden/house_of_hope_canonical_60.json`
  - `incomeSeries[0]`, `kpis[Net income]`, `rows[Net income].y1`: `−$44,433` →
    `−$282,933` (`= −44,432.91 − 238,500`).
  - `monthly[]`: 12 → 60 rows.
  - `milestones.payback`: **stays N/A-with-reason** (never recovers in 60 months).
  - `model_version` / `compute_schema_version`: bumped (below).
  - **Unchanged:** Net margin row, `metrics` (capital/cashGap/breakeven Month 9), reco
    `do_not_proceed`, year5Income, share guardrail flags.
- `engine/tests/golden/house_of_hope_design_parity_40.json`
  - `incomeSeries[0]`, `kpis[Net income]`, `rows[Net income].y1`: `+$47,359` →
    `−$191,141`.
  - `monthly[]`: 12 → 60 rows.
  - `milestones.payback`: N/A → **`Month ~30`** (resolves); the
    `flags["payback_month"]` N/A entry is **removed**.
  - `model_version` / `compute_schema_version`: bumped.
  - **Unchanged:** Net margin (11.1%…26.9%), reco `proceed`, capital ≈ `$279k`,
    breakeven Month 5, year5Income.

Both must re-pass the **three-way golden gate with and without overrides** (run under a
pinned `soffice`) before Phase 2 lands.

### Version bump (`engine/model.py`)
- `MODEL_VERSION`: **`2.6.0` → `2.7.0`** — math/semantics change (Year-1 reported net is
  startup-inclusive; payback redefined as cash-recovery month; monthly ramp spans the
  full 5-year horizon).
- `COMPUTE_SCHEMA_VERSION`: **`1.5.0` → `1.6.0`** — `monthly[]` now spans 60 project
  months (a real consumer-contract change even though keys are unchanged), and
  `incomeSeries[0]` / "Net income" Year-1 carry startup-inclusive semantics. Add the
  changelog stanza to the `model.py` banner + `ENGINE_CONTRACT.md` version line.

### DOCS-CODE (same PR as Phase 2 implementation)
- `ENGINE_CONTRACT.md`: §4.x version banner; §3/§6 net & margin (`net[y]` → distinguish
  `operating_net` vs `reported_net`; `payback_month` definition at L258/L338); §5 monthly
  model (`N = G+11` → full-horizon ramp; capital/break-even scoping); §6.4 simple-payback
  note (now also dropped from the `.xlsx`); §13 fixture rows (L465–466).
- `DATA_MODEL.md`: §4.8 `computed_json` "Net income" Y1 + `incomeSeries` notes; §4.x
  `monthly[]` (`N = opening+11` → `opening+59`); payback notes (L502/L548/L561–562).

---

## 6. RED tests (Phase 1 deliverable 2) — `engine/tests/test_startup_income_payback.py`

5 RED + 1 soffice-gated RED + 2 invariant-lock (GREEN-now, must-stay-GREEN):

| Test | Asserts | State |
|---|---|---|
| `test_year1_net_income_includes_full_startup_hit` | (a) design-parity Net income KPI / `incomeSeries[0]` / row Y1 `== operating_net − startup_total` | **RED** |
| `test_year1_drop_equals_startup_total_for_canonical` | (a) same drop for the loss fixture | **RED** |
| `test_years_2_to_5_net_income_stays_operating` | Y2–Y5 income == operating net; `year5Income` unchanged | GREEN |
| `test_positive_operating_net_yields_finite_payback_month` | (b) Aurora-class: finite `payback_month` (12 < pm ≤ 60); cash-basis; milestone+KPI agree | **RED** |
| `test_canonical_loss_payback_stays_na_within_horizon` | loss fixture payback stays N/A-with-reason | GREEN |
| `test_annual_rolls_up_from_extended_monthly_series` | (c) 60 operating months; per-year penny-exact roll-up (Reg #15) | **RED** |
| `test_xlsx_net_income_year1_subtracts_total_startup` | (d) Y1 Net income formula references the Total Startup Costs cell | **RED** |
| `test_xlsx_net_income_year1_recalcs_to_server_net` | (d) LibreOffice recalc of the Y1 cell `== server net ±$0.50` | RED-where-soffice (skipped here) |
| `test_net_margin_row_stays_operating_not_startup_inclusive` | margin stays operating (decoupled from Net income) | GREEN-lock |
| `test_capital_and_cash_gap_are_year1_window_anchored` | capital + cash gap derivable from the Year-1 window alone; breakeven Month 9 | GREEN-lock |

RED-failure evidence (current code, no `soffice`):

```
test_year1_net_income_includes_full_startup_hit  → 47358.711632 == -191141.2883680000  (FAIL)
test_year1_drop_equals_startup_total_for_canonical → -44432.9056672 == -282932.9056672000 (FAIL)
test_positive_operating_net_yields_finite_payback_month → payback_month None is not None (FAIL)
test_annual_rolls_up_from_extended_monthly_series → 12 == 60 operating months (FAIL)
test_xlsx_net_income_year1_subtracts_total_startup → '=B36-B50' lacks 'B60' (FAIL)
```

Full engine suite: **5 failed (these RED), 237 passed, 8 skipped** — no pre-existing test
disturbed.

---

## 7. Existing tests to UPDATE in Phase 2 (not touched in Phase 1)

Behavior/horizon/version changes will require updating these (and regenerating goldens):

- **`engine/tests/test_fixtures_frozen.py`** — both `*_is_byte_stable` (regen goldens);
  `test_canonical_is_a_loss_case` (`model_version` `2.6.0`→`2.7.0`).
- **`engine/tests/test_viewmodel.py`** — `test_monthly_rows_shape` (12→60);
  `test_monthly_covers_all_project_months_one_to_n_with_preopening` (`N = G+59`);
  `test_version_stamps` (version bump). (`_recovered_payback_result`-based tests stay
  green — same recovered month.)
- **`engine/tests/test_monthly.py`** — `test_twelve_operating_months`,
  `test_no_pre_open_months_when_opening_at_month_one` (len),
  `test_pre_opening_months_are_first_class_pl_months` (len 15→63),
  `test_n_equals_g_plus_eleven`, `test_no_scheduled_cost_keeps_timeline_at_g_plus_eleven`,
  `test_operating_rollup_holds_when_opening_is_late`,
  `test_timeline_extends_past_operating_year_for_late_cost`, and the
  `*_roll_up_to_annual_to_the_penny` trio (scope to first 12 operating months).
- **`engine/tests/test_decision.py`** — `test_first_year_cash_gap_is_most_negative_cumulative`
  (scope troughs to the Year-1 window). (`simple_payback`, sensitivity, capital,
  reco/break-even-consistency tests stay green — operating `.net` preserved.)
- **`engine/tests/test_five_year.py`** — `test_income_series_is_annual_net_income_y1_to_y5`
  (Y1 compares against `reported_net`).
- **`engine/tests/test_xlsx.py`** — `test_monthly_tab_emits_a_row_per_project_month_1_to_n`
  (`N = G+59`); any assertion on the removed "Simple payback (years)" cell (none found).
- **`engine/tests/test_golden_gate.py`** — re-run with/without overrides under pinned
  `soffice` (CI); pre-opening / month-1-lump / override / loss-case legs must stay green.
- App tests (`test_five_year_api`, `test_store_card_summary`, `test_packet_docx`) — read
  hand-built VMs or robust shape assertions; expected to stay green.

---

## 8. Phase 1 exit

Commit on this branch: this SPEC + `engine/tests/test_startup_income_payback.py` (RED).
**STOP for review.** No `compute.py` / `decision.py` / `monthly.py` / `xlsx.py` /
`viewmodel.py` / `model.py` logic changed; no golden regenerated. Phase 2 proceeds only
on explicit approval.

# ENGINE_CONTRACT.md — The Math Authority

> **Status:** Built & deployed (engine **2.9.0** — fixes an owner defect in the Years 2-5 monthly shape; this contract tracks it) · **Repo:** `rallytasks/projections` · **Owner:** Andy Downard
> **Model version this contract defines:** `model_version = "2.9.0"` · `compute_schema_version = "1.7.0"` (schema unchanged — no field shape change, only the Years 2-5 intra-year NUMBERS). **Owner defect fix (2026-07-05):** "net should never fall month-over-month unless a startup expense forces it." Years 2-5 of `monthly[]` used to jump INSTANTLY from the prior year's exit run-rate to the new year's flat annual average at each year seam (project months 13/25/37/49) — an artificial one-month Net cliff with no cost event behind it. Fixed in `engine/monthly.py`: Years 2-5 now GLIDE from the prior year's own last month toward that year's flat average over `_BLEND_MONTHS` (3) months, then hold flat for the rest of the year (`_blend_then_flat`, replacing the old uniform-1/12 `_distribute` call) — each year still feet to its annual revenue/expense/net line exactly (Regression #15). **Year 1 itself, its S-curve shape, capital, break-even, and every annual total are byte-unchanged** — only the Years 2-5 intra-year shape moved. A full "net never decreases" guarantee is **not** mathematically achievable while Year 1 keeps its deliberate dramatic S-curve recovery shape: in any non-decreasing 12-month sequence summing to a fixed annual total, the last month is always ≥ the flat average, and Year 1's S-curve intentionally ends well above its own average — a much-slower-growth following year cannot always sustain that exit rate even at ITS OWN flat average. The flat level held after the glide is SOLVED from the footing equation, not the naive `total/12` average, so the glide meets the flat tail as one continuous arithmetic progression (no hidden second jump — an earlier, naive-average draft of this fix had exactly that bug, caught in review). What's guaranteed: no more instant one-month cliff at a year seam, and no month-over-month drop anywhere in Years 2-5 worse than the old bug's own seam cliff (`engine/tests/test_monthly.py::test_no_instant_flat_jump_at_a_year_seam` / `test_no_month_over_month_drop_in_years_2_5_exceeds_the_old_seam_cliff`).
>
> **Prior model version this contract defined:** `model_version = "2.8.0"` — the **fusion** of two independently-stamped 2.7.0 engines. **DISPLAY layer = cash-based (lineage A, deployed):** displayed Net income AND Net margin subtract the one-time Year-1 startup and are congruent (`cash_net[1]=operating_net[1]−startup_total`, `cash_net[y≥2]=operating_net[y]`, `net_margin[y]=cash_net[y]/total_rev[y]`); `monthly[]` spans the full 60-month horizon; payback = the first project-month cumulative-cash ≥ 0 after going negative ("Month N"); the §12.2 net-margin guardrail runs on the DISPLAYED (cash) margin; the `.xlsx` Year-1 Net-income cell subtracts the Total Startup Costs cell and payback rides the MILESTONES Month-N row. **OPERATING layer = params/gaps (lineage B, this branch):** the INTERNAL operating net (unchanged) still drives the verdict (`_recommend` gates), `simple_payback`, sensitivity re-runs, and the monthly roll-up; the **Year-1 monthly window uses the 6.2 three-stream split** (fixed costs flat 1/12, payroll+taxes on the payroll ramp, %-of-revenue on revenue weights — Years 2–5 uniform 1/12), which reshapes the Year-1 cash trough → **capital / break-even are computed on this distribution**; 990-grounded constants (`PAYROLL_TAX_PCT_OF_PAYROLL` 8.0%, `FIXED_ANNUAL["Insurance liability"]` $10,000); the 6.3 override-aware advisory flags (`occupancy_ratio_out_of_band` / `labor_ratio_out_of_band` / `sales_per_sqft_out_of_band` + the `break_even_revenue` ≥100% guard, all OPERATING-layer); `money_view` single-rounding-authority + exact lease-deposit arithmetic; NNN resolved to the resolved-occupancy (incl. `nnn_opex_annual`) reading. schema 1.7.0 = the union of lineage A's cash surfaces + 60-row monthly + Month-N milestone and lineage B's `sensitivity{base,downside,upside}` + `confidence{ramp}` + the full editable settings knob set. Stored 2.7.0 snapshots read **verbatim** with `upgrade_available`; recompute writes a NEW 2.8.0 revision.
> 
> <details><summary>Lineage detail — 2.7.0-A (cash, deployed) and 2.7.0-B (params, this branch)</summary>
> 
> **2.7.0-A** **Model version this contract defines:** `model_version = "2.7.0"` · `compute_schema_version = "1.6.0"` (2.7.0 — **the projection is CASH-BASED** (epic #321): there is **no amortization and no capitalization**; the one-time startup is a **cash outflow that hits when paid (Year 1, at/around opening)**. The **displayed** Net income AND Net margin are BOTH cash-based and therefore **congruent** (no footnote, no second margin): displayed `cash_net[1] = operating_net[1] − startup_total`, `cash_net[y] = operating_net[y]` for `y≥2`, and displayed `net_margin[y] = cash_net[y] / total_rev[y]`. The **internal operating net** (`AnnualYear.net = total_rev − total_exp`) is **unchanged** and still drives the go/no-go verdict (the `_recommend` gates on `y1.net≤0`, `simple_payback` on `y1.net>0`, the sensitivity re-runs, and the monthly operating roll-up) — a startup is **not** "do not proceed" merely because Year-1 cash is negative; `capital_required` + `payback` carry the funding story. The **monthly model now spans the full 60-month horizon** (`G..G+59`, was 12) so **payback resolves across years**: `payback_month` = the first project-month where **cumulative cash ≥ 0 after going negative** ("Month N"); `null` ⇒ N/A-with-reason. Years 2–5 use a uniform 1/12 intra-year split (Year-1 keeps the launch S-curve byte-for-byte); each year's 12 months roll up to that year's annual line to the penny (Regression #15, now per year). **Capital required, break-even month, and first-year cash gap stay Year-1-anchored and byte-unchanged** (capital + first-year-cash-gap troughs are scoped to the launch window `m.index ≤ G+11`; break-even is computed over the Year-1 operating window only). The **§12.2 net-margin guardrail now runs on the displayed (cash) margin**. The `.xlsx` **Net income Year-1 cell subtracts the Total Startup Costs cell** (`=B{tr}-B{te}-B{startup_total}`); Years 2–5 stay `=rev-exp`; the **"Simple payback (years)" cell is removed** — payback is surfaced only via the **MILESTONES "Payback" Month-N row**. schema 1.6.0: the income/margin display surfaces (`Net income` row + KPI, `Net margin` row + KPI, `incomeSeries[0]`, `year5Income`, card `y1_net`) are **cash-based**; `monthly[]` grows from 12 to 60 rows. Same field shapes; the NUMBERS change with model 2.7.0. The labels stay "Net income"/"Net margin" — only the numbers become cash-based. schema 1.5.0: view-model gains `startupCosts` — the one-time startup line items as `[{category, amount{raw,display}}]`, the engine's `result.startup` including the computed "Lease Deposit + First Month Rent" line — and `startupTotal` `{raw,display}`, so the Board Packet `.docx` (EPIC DOCX) renders a grounded startup-costs table from the SAME format authority. Additive shape change, **no math change** (`model_version` stays 2.6.0). 2.6.0: the annual P&L extends from a **3-year to a 5-year horizon** — **Year 4 / Year 5** are driven by their own explicit donor-share inputs `share_y4` / `share_y5` through the SAME driver chain and the existing **compounding rent escalator** (which now compounds through Year 5 with the same `(1+e)^(y−1)` formula, no special-case); the revenue **CAGR is Y1→Y5** (exponent `1/4`); the **§12.2 share + net-margin guardrails also check Y4/Y5**; the **"Net profit" row/KPI/.xlsx line is renamed "Net income"** everywhere. The monthly S-curve cash-flow and the decision metrics (**capital required, break-even month, first-year cash gap**) stay **Year-1-anchored and are byte-unchanged**. Donation drivers (`donationValue`, `basket`, `donationsPerHouseholdPerYear`) are surfaced as **editable settings**. schema 1.4.0: every annual `rows[]` entry carries `y4`/`y5` cells; `settings` gain `shareY4`/`shareY5` + the editable donation drivers; top-level `incomeSeries` (annual net income Y1..Y5 `{raw,display}`) + `year5Income` for the list/detail sparkline. Legacy 3-year snapshots (2.5.0) read **verbatim**; `upgrade-model` recompute **auto-extends** absent `share_y4`/`share_y5` to the decelerating-plateau defaults `0.11`/`0.12` and writes a NEW 2.6.0 revision (the prior bytes are preserved); 2.5.0: **Utilities/trash service** stops being a flat fixed-$ line and is **derived** as `UTILITIES_PER_SQFT × building_sqft` — the SAME pinnable line + slot, now sq-ft-scaled; the default cost-schedule seed scales **Equipment & Fixtures** + **Build-out** as `FIXTURES_PER_SQFT`/`BUILDOUT_PER_SQFT × building_sqft`; all three **anchored** so the example's 10,000 sq ft reproduces today's literals byte-for-byte (#245); schema 1.3.0: view-model `settings.utilitiesPerSqft` + `settings.rentPerSqft` additive scalars; 2.4.0: `first_year_cash_gap` is scoped **strictly** to the operating Year-1 window `G..G+11`, so a scheduled cost beyond `G+11` no longer leaks its deeper trough into the first-year headline (#182); `cash_runway_months` ignores leading zero-cost pre-opening months instead of trivially reporting `1` (#184); 2.3.0: downside sensitivity rent stress applied to the **resolved** occupancy — `rent_per_sqft` and `nnn` opex are stressed too, not just `occupancy_annual` (#181); 2.2.0: multi-month pre-opening timeline + scheduled costs + 3 milestones; schema 1.2.0: view-model `milestones` block + Payback-period KPI, monthly `scheduledCosts`)
> 
> **2.7.0-B** **Model version this contract defines:** `model_version = "2.7.0"` · `compute_schema_version = "1.6.0"` (2.7.0 — Wave-6 close-out, single golden regen: **990-grounded constants** `PAYROLL_TAX_PCT_OF_PAYROLL` 7.5%→8.0% and `FIXED_ANNUAL["Insurance liability"]` $2,000→$10,000 (six-EIN sample, [DECISIONS.md](./DECISIONS.md)); the **6.2 monthly split** (fixed operating costs charged flat, payroll taxes on the payroll ramp) reshapes the Year-1 cash trough → capital / break-even; the **6.3 advisory flags** `occupancy_ratio_out_of_band` / `labor_ratio_out_of_band` / `sales_per_sqft_out_of_band` + the `break_even_revenue` "N/A — variable-cost rate ≥ 100%" guard; the **money_view single rounding authority** (`raw` and `display` derive from one canonical value) + **exact lease-deposit arithmetic** (`occupancy_y1 × 3 / 12`); **NNN resolved** so the escalator AND lease deposit both apply to the resolved occupancy INCLUDING `nnn_opex_annual` (conservative reading; §1/§3). No new view-model shape (schema stays 1.6.0). schema 1.6.0: view-model gains `sensitivity{base,downside,upside}` + `confidence{ramp}` + the full editable settings knob set — see the changelog tail of this block. schema 1.5.0: view-model gains `startupCosts` — the one-time startup line items as `[{category, amount{raw,display}}]`, the engine's `result.startup` including the computed "Lease Deposit + First Month Rent" line — and `startupTotal` `{raw,display}`, so the Board Packet `.docx` (EPIC DOCX) renders a grounded startup-costs table from the SAME format authority. Additive shape change, **no math change** (`model_version` stays 2.6.0). 2.6.0: the annual P&L extends from a **3-year to a 5-year horizon** — **Year 4 / Year 5** are driven by their own explicit donor-share inputs `share_y4` / `share_y5` through the SAME driver chain and the existing **compounding rent escalator** (which now compounds through Year 5 with the same `(1+e)^(y−1)` formula, no special-case); the revenue **CAGR is Y1→Y5** (exponent `1/4`); the **§12.2 share + net-margin guardrails also check Y4/Y5**; the **"Net profit" row/KPI/.xlsx line is renamed "Net income"** everywhere. The monthly S-curve cash-flow and the decision metrics (**capital required, break-even month, first-year cash gap**) stay **Year-1-anchored and are byte-unchanged**. Donation drivers (`donationValue`, `basket`, `donationsPerHouseholdPerYear`) are surfaced as **editable settings**. schema 1.4.0: every annual `rows[]` entry carries `y4`/`y5` cells; `settings` gain `shareY4`/`shareY5` + the editable donation drivers; top-level `incomeSeries` (annual net income Y1..Y5 `{raw,display}`) + `year5Income` for the list/detail sparkline. Legacy 3-year snapshots (2.5.0) read **verbatim**; `upgrade-model` recompute **auto-extends** absent `share_y4`/`share_y5` to the decelerating-plateau defaults `0.11`/`0.12` and writes a NEW 2.6.0 revision (the prior bytes are preserved); 2.5.0: **Utilities/trash service** stops being a flat fixed-$ line and is **derived** as `UTILITIES_PER_SQFT × building_sqft` — the SAME pinnable line + slot, now sq-ft-scaled; the default cost-schedule seed scales **Equipment & Fixtures** + **Build-out** as `FIXTURES_PER_SQFT`/`BUILDOUT_PER_SQFT × building_sqft`; all three **anchored** so the example's 10,000 sq ft reproduces today's literals byte-for-byte (#245); schema 1.3.0: view-model `settings.utilitiesPerSqft` + `settings.rentPerSqft` additive scalars; 2.4.0: `first_year_cash_gap` is scoped **strictly** to the operating Year-1 window `G..G+11`, so a scheduled cost beyond `G+11` no longer leaks its deeper trough into the first-year headline (#182); `cash_runway_months` ignores leading zero-cost pre-opening months instead of trivially reporting `1` (#184); 2.3.0: downside sensitivity rent stress applied to the **resolved** occupancy — `rent_per_sqft` and `nnn` opex are stressed too, not just `occupancy_annual` (#181); 2.2.0: multi-month pre-opening timeline + scheduled costs + 3 milestones; schema 1.2.0: view-model `milestones` block + Payback-period KPI, monthly `scheduledCosts`; schema 1.6.0: view-model gains `sensitivity{base,downside,upside}{net{raw,display}, breakeven int|null, capital{raw,display}}` + `sensitivity.delta` and `confidence{ramp}` — surfacing the §12.2 ±stress scenarios and the ramp low-confidence flag `decision.py` already computed but the view-model previously dropped (audit P0); `settings` gains the full editable knob set `sensitivityDelta`, `fixedAnnual` (label→annual-$), `nnnOpexAnnual`, `buildingSqft`, `salesfloorPct`. Additive shape change, **no math change** (`model_version` stays 2.6.0). Same wave: `AssumptionsIn` gains bounds-checked exposure for `reserve_buffer`/`sensitivity_delta`/`fixed_annual` (§2), plus `ge=0` on `donations_per_hh`/`basket`/`utilities_per_sqft` and fixed_annual PATCH-accumulate semantics (a partial `fixed_annual` merges over the STORED map across sequential PATCHes, never a flat replace) — API-surface hardening, not an engine formula change)
> </details>
> **Source of truth for requirements:** [`PRD.md`](reference/PRD.md) (cited inline as §) and [`methodology.md`](reference/thrift-store-projections-skill/reference/methodology.md).
> **Sibling docs:** [ARCHITECTURE.md](ARCHITECTURE.md) · [BUILD_PLAN.md](BUILD_PLAN.md) · [DATA_MODEL.md](DATA_MODEL.md) · [API_SPEC.md](API_SPEC.md) · [SECURITY.md](SECURITY.md) · [OPS_RUNBOOK.md](OPS_RUNBOOK.md) · [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CLAUDE.md](CLAUDE.md) · [AGENTS.md](AGENTS.md) · [IDEA_FAB.md](IDEA_FAB.md)

This document is the **single mathematical authority** for the Thrift Store Projection web app. Every number the app shows, exports, or narrates is produced by **one** pure compute core (`engine/compute.py`). If a formula is not in this document, it does not exist. If code and this document disagree, **this document is the bug report** — fix one of them in the same PR (the "Docs Are Code" rule, see [CONTRIBUTING.md](CONTRIBUTING.md)).

Scope of this contract:

1. The driver model and every formula, with named default constants.
2. The Year-2 = explicit-input rule (the methodology midpoint is **killed**).
3. The monthly launch cash-flow model and the decision metrics derived from it.
4. The override DAG and its topological resolution rules (PRD §11/§14).
5. Edge-case math, N/A sentinels, and the `flags` map (PRD §12.4).
6. The Excel export contract, cell-by-cell (PRD §18).
7. The golden-test gate: server compute vs. Python reference vs. LibreOffice recalc.

---

## 0. The #1 correction: the existing engine is a SEED, not the authority

[`generate_projection.py`](reference/thrift-store-projections-skill/scripts/generate_projection.py) is the **calibration reference**, not the v1 engine. A line-by-line read shows it satisfies ~30% of v1: it is **annual-only**, computes **Year-2 = midpoint** (`compute()` line 65; Excel `=AVERAGE(...)` line 209), treats **supplies as a fixed $3,700** (DEFAULTS line 44), has **no Marketing line, no rent escalator, no monthly cash-flow, no decision metrics, no override/DAG**, returns **positional tuples**, and emits **unguarded division formulas** that produce `#DIV/0!` (Excel lines 257 `=net/totrev`, 284 `=startup/Y1net`).

**Build rule (M1):** Treat M1 as a **versioned rewrite**, not a "wire-up." Keep the bottom-up driver chain and the blue-input / live-formula Excel styling. Build monthly cash-flow, decision metrics, the new cost lines, the escalator, and the override DAG as **new code** under `model_version = "2.0.0"`. Retain the legacy annual script only as a **calibration golden** (see §13.7).

The PRD's phrase "reused engine, single math authority" (§13, §23, Appendix A) means **"extract & extend the formulas into a pure core, rebuild the renderers"** — not "wrap the old script behind an API." See the Engine Gap Table in §0.1.

### 0.1 Engine Gap Table (as-built vs. v1 required)

| Concern | `generate_projection.py` as-built | v1 requirement | Status |
|---|---|---|---|
| Driver chain (hh→donations→retail→customers→salvage→total) | `compute()` 71–76 | unchanged | **EXISTS** |
| Year-2 share | midpoint `(y1+y3)/2` line 65 / `=AVERAGE` line 209 | three explicit inputs `share_y1/y2/y3` (§7.1) | **REWRITE** |
| Supplies | fixed `$3,700` (line 44) | `supplies_pct` × revenue, default 5.0% (§7.3) | **REWRITE** |
| Marketing & outreach | none | `marketing_pct` × revenue, default 3.75% (§7.3) | **NEW** |
| Rent | `sqft × rate`, flat all 3 yrs (line 80/247) | escalator 3.0% compounding Y2–Y5 (§7.3); or annual occupancy $ | **REWRITE** |
| Reserve buffer | none | `$25,000`, feeds capital-required (§12.1) | **NEW** |
| Monthly cash-flow M0–M12 | none | full ramp/timed-outflow model (§10) | **NEW** |
| Decision metrics (break-even mo, capital req, cash gap, runway, sensitivity, recommendation) | none | §12 | **NEW** |
| Override DAG / pins | none | topological resolve, §11/§14 | **NEW** |
| Output shape | positional tuple (line 94) | App-D view-model + `computed_json`+`flags` | **REWRITE** |
| N/A guards / `#DIV/0!` | unguarded (257, 284) | explicit null + `flags`; Excel `IF(denom=0,"",…)` | **REWRITE** |
| `model_version` stamp | none | stamped into `computed_json` + `.xlsx` | **NEW** |
| Renderers | `build_xlsx`/`build_docx` mix math + cells | pure core; `engine/xlsx.py`, `engine/packet.py` consume core output | **REWRITE** |

---

## 1. DECISIONS-TO-RESOLVE (must be closed before any golden fixture is frozen)

The PRD leaves three numeric defaults ambiguous. **A builder cannot start golden tests until these are pinned.** The Resolved Defaults table (§2) below states the chosen values. **Labor is pinned to 60% by owner decision** ([DECISIONS.md](./DECISIONS.md)); the canonical House of Hope golden reproduces the engine at 60% (Y1 revenue ≈ $426,911 is labor-independent and holds; margin/decision-metrics are computed at 60% and need not equal the prototype's 40% headline). A separate **40% design-parity fixture** reproduces the Appendix-D prototype SHAPE for design-QA only — at 2.7.0 the 990-grounded constants (payroll tax 8%, Insurance $10k) move its numbers to capital ≈ **$302,238**, net margin ≈ **9.0%**, break-even **month 6**, and `reco = raise_cash` (capital crosses the $300k funds by $2,238; the prototype's ~$277,990 / ~11% / month-5 / "Proceed" headline was calibrated to the pre-990 basis). Both are "correct" for their stated labor input — do not conflate them.

| Open item | PRD evidence | **Resolved for v1** | Rationale |
|---|---|---|---|
| **Labor % of revenue** | DEFAULTS=0.60; methodology=60%; prototype=40%; Appendix-D sample=40%; Appendix-B=0.60 | **0.60** | **Owner decision ([DECISIONS.md](./DECISIONS.md)); matches the original verified engine.** The canonical correctness golden reproduces House of Hope at **60%** (a loss/"revise" case — valid for a math gate). A separate **40% design-parity fixture** reproduces the prototype SHAPE for design-QA only — at 2.7.0 its 990-grounded numbers are ~9.0% margin, capital ≈ $302,238, break-even month 6, `reco = raise_cash` (the pre-990 "~11% / ~$278k / month 5 / Proceed" headline is superseded; see §10 + DECISIONS.md). Slider editable; band 25–60% (§12.2). |
| **Average basket value** | §7.3=$17; Appendix-D=$17.08; example JSON=17 | **17.08** | Required to reproduce Y1 revenue ≈ $426,911 at 6% share. Editable. |
| **Rent escalator behavior** | §7.3 "applies to Y2–Y3"; compound vs. linear unspecified | **Compound**: `rent_y` = `occupancy_y1 × (1 + escalator)^(y−1)`, where **`occupancy_y1` is the RESOLVED occupancy including NNN opex** (`base_rent + nnn_opex_annual` for an NNN lease). The escalator compounds the **resolved** occupancy, and the **lease-deposit startup line is 3 months of that same resolved occupancy** (`occupancy_y1 × 3 / 12`), NNN included — the conservative (higher-cost) reading. **Code behavior governs** (matches §3; resolves the prior §1↔§3 contradiction — Task 6.4 / [DECISIONS.md](./DECISIONS.md)). | Conservative reading for a first-time operator; fixtured (`nnn_gross_check`). |

> Labor is **60%** (owner decision). The 40% design-parity fixture lives alongside the 60% canonical golden; moving the **default** between them is a **new `model_version`** with a regenerated golden set in the same change — not a silent flip. See §3 and [DECISIONS.md](./DECISIONS.md).

---

## 2. Resolved Defaults (named constants)

These live as module constants in `engine/model.py`. Every default is overridable per projection via `assumptions_json` / `inputs_json` (sliders on the Settings tab, PRD §7.3/§19.3). **No formula may hard-code a literal; it must reference a named constant.**

```python
# engine/model.py
MODEL_VERSION          = "2.0.0"     # math changes => bump
COMPUTE_SCHEMA_VERSION = "1.0.0"     # view-model shape changes => bump

# --- demand engine
DONATIONS_PER_HH_PER_YEAR = 3        # §7.3
AVG_BASKET_VALUE          = 17.08    # §7.3 (resolved §1) -> customers
SALVAGE_PCT_OF_RETAIL     = 0.008    # §7.3 (0.8%)

# --- cost structure (% of total revenue unless noted)
LABOR_PCT_OF_REVENUE      = 0.60     # §7.3 (owner decision, DECISIONS.md) — band 0.25–0.60
MARKETING_PCT_OF_REVENUE  = 0.0375   # §7.3 — NEW line
SUPPLIES_PCT_OF_REVENUE   = 0.05     # §7.3 — REPLACES fixed "Store/office supplies"
PAYROLL_TAX_PCT_OF_PAYROLL= 0.075    # §7.3

# --- card-processor formula (Model v3, model_version 3.0.0) — REPLACES the flat
# CARD_FEES_PCT_OF_REVENUE = 0.02 line. fees = CARD_SHARE × (CARD_RATE × retail +
# CARD_PER_TX_FEE × transactions); see §4.2.
CARD_SHARE                 = "0.65"  # % of retail sales processed via card (vs. cash)
CARD_RATE                  = "0.026" # effective rate on card volume (2.6%)
CARD_PER_TX_FEE            = "0.10"  # per-transaction fee ($0.10)

# --- workers' comp + optional contributions revenue (Model v3, 3.0.0)
WORKERS_COMP_PCT_OF_PAYROLL = "0.02" # 2% of payroll; rides the payroll ramp monthly,
                                      # not the flat fixed residual — §4.2/§5
CONTRIBUTIONS_ANNUAL        = "0"    # optional flat annual add to total_rev; default
                                      # 0 => byte-unchanged unless explicitly set — §4.2

# --- production-station module (Model v3, 3.0.0) — read-only derived metrics
# bridging retail $ to a staffing/space count: items_sold -> items_produced ->
# production_hours -> stations_staffed (monthly) -> stations_installed (peak monthly
# value, ceil'd). Never feed total_rev/total_exp; see §4.2 and §7.3 (non-pinnable).
AVG_ITEM_PRICE                = "5.00" # $ per item sold at retail
SELL_THROUGH                  = "0.50" # fraction of produced/processed items that sell
ITEMS_PER_HOUR                 = 75    # items processed per production labor-hour
PRODUCTIVE_HOURS_PER_STATION   = 160   # productive hours one production station covers/mo

# --- labor_mode: pct | coverage (Model v3, 3.0.0). "pct" (default, below) is today's
# total_rev × LABOR_PCT_OF_REVENUE formula, byte-unchanged. "coverage" is a headcount/
# wage-driven alternative computed on the year's average month — see §4.2.
LABOR_MODE                 = "pct"
OPEN_HOURS_PER_WEEK        = "60"    # store open hours/week (coverage mode)
CASHIER_TX_PER_HOUR        = "22"    # transactions one cashier can process/hour
MIN_STAFFED_LANES          = "1.5"   # minimum staffed checkout lanes at all times
DOOR_DEDICATED              = "1.0"  # dedicated donation-door staff (FTE-equivalent)
DOOR_PEAK                   = "0.25" # additional peak-hours donation-door coverage
RUNNERS                     = "1.5"  # floor/backroom runners (FTE-equivalent)
WAGE                        = "15.00"  # hourly wage, coverage mode
MGR_SALARY                  = "55000"  # store manager annual salary
AM_SALARY                   = "42000"  # assistant manager annual salary
AM_COUNT                    = 2        # assistant manager headcount

# --- occupancy
RENT_ESCALATOR            = 0.03     # §7.3 — compound, Y2–Y5 (resolved §1; 5-year horizon)

# --- sq-ft scaling basis (#245). Example store = 10,000 sq ft; each per-sq-ft
# constant is the example literal / 10,000, ANCHORED so that × 10,000 reproduces
# today's literal exactly. No formula hard-codes the literal.
EXAMPLE_BUILDING_SQFT     = 10000    # reference/.../house_of_hope.json sqft
UTILITIES_PER_SQFT        = "2.23"   # 22,300 / 10,000  (utilities/trash, $/sqft/yr)
FIXTURES_PER_SQFT         = "4.50"   # 45,000 / 10,000  (Equipment & Fixtures, $/sqft)
BUILDOUT_PER_SQFT         = "5.00"   # 50,000 / 10,000  (Build-out / Renovations / TI)
DEFAULT_RENT_PER_SQFT     = "12.00"  # AI-off manual default — 120,000 / 10,000 (parity)

# --- fixed annual operating $ (not %-based)
FIXED_ANNUAL = {
    "Insurance liability":      2000,   # methodology line 24
    "Internet, Phones":         3000,
    "Pest control":              300,
    "POS platform":             4800,   # $400/mo (Model v3, 3.0.0)
    "Production software":      1200,   # $100/mo (Model v3, 3.0.0)
    "Repairs/maintenance":      1600,
    "Security system":           900,
}   # NOTE: "Store/office supplies" $3,700 REMOVED (now SUPPLIES_PCT);
    # "Utilities/trash service" REMOVED here — now DERIVED as UTILITIES_PER_SQFT ×
    # building_sqft in compute (#245), keeping its same pinnable line + EXPENSE_ORDER slot.

# --- one-time startup (Year 0). Equipment & Fixtures / Build-out are the per-sq-ft
# anchor source: at EXAMPLE_BUILDING_SQFT they equal FIXTURES_PER_SQFT/BUILDOUT_PER_SQFT
# × sqft. The default cost-schedule SEED scales them by building_sqft; this no-schedule
# lump stays at the example basis. (DECISION #245: seed change, not engine-resolution.)
STARTUP = {
    "Thrift Store Consultant":                         100000,  # methodology line 43
    "Equipment & Fixtures":                              45000,
    "Build-out / Renovations / Tenant Improvements":     50000,
    "Legal, Permits, Insurance Setup, Signage":          13500,
}   # "Lease Deposit + First Month Rent" = occupancy_y1 * 3 / 12 (computed, not a literal;
    # occupancy_y1 is the RESOLVED occupancy incl. NNN opex; exact multiply-before-divide, 2.7.0)

# --- capital & cash
CASH_RESERVE_BUFFER       = 25000    # §7.3 / §12.1
SENSITIVITY_DELTA         = 0.25     # §12.2 ±25% on rent & donations. SINGLE SOURCE
    # (schema 1.6.0): this is the DEFAULT of Assumptions.sensitivity_delta, and
    # decision.py derives the downside/upside multipliers (1 ± delta) from THAT field
    # — never a second hard-coded 1.25/0.75 literal. Editable via AssumptionsIn
    # (see §2.1); an edit changes decision.py's stress math, not just this constant.

# --- monthly ramp (calibration backlog — label low-confidence, §12.5)
# The donation S-curve to steady state is implemented as fixed monthly weight
# vectors in engine/monthly.py (_REVENUE_WEIGHTS / _PAYROLL_WEIGHTS), not scalar
# constants here.
```

**Calibration reference (Longview, TX — methodology lines 51–57):** ~6,900 first-year donations → ~2,300 donating households → ~7% donor share of ~31,800 city households; retail ~$573K → ~$83 resale value/donation; basket ~$15–$20. Use as the reality check the guardrails (§12.2) enforce.

### 2.1 API exposure & PATCH bounds (`AssumptionsIn`, schema 1.6.0)

Every constant above is overridable per projection, but not every override is unbounded. `app/routers/projections.py`'s `AssumptionsIn` is the API-boundary gate: it re-validates the **merged** `assumptions` dict on every `create`/`PATCH` (never just the newly-PATCHed keys), so a request can never persist an out-of-domain value the engine would otherwise accept literally. A violation is **422 `invalid_assumptions`** — rejected before the merged surface ever reaches `engine.compute` (API_SPEC.md §4.4/§11).

| Constant | `AssumptionsIn` field | PATCH bound | Note |
|---|---|---|---|
| `CASH_RESERVE_BUFFER` | `reserve_buffer` | `int`, `>= 0` | Feeds `capital = abs(peak shortfall) + reserve_buffer` (decision.py) — a $ delta on `reserve_buffer` shifts `capital` by exactly that delta. |
| `SENSITIVITY_DELTA` | `sensitivity_delta` | decimal string, `[0, 0.9]` | Single source for the §12.2 `(1 ± delta)` stress multiplier (see §2 above); `> 1` would make the downside multiplier negative. |
| `FIXED_ANNUAL` | `fixed_annual` | dict; keys allowlisted to `FIXED_ANNUAL` labels, each value `>= 0` | A **partial** PATCH **accumulates**: incoming keys deep-merge over the STORED map across sequential PATCHes (never a flat replace, which would silently revert an earlier PATCH's line), then the resolved map merges over the engine defaults for any line never touched at all. |
| `DONATIONS_PER_HH_PER_YEAR` | `donations_per_hh` | `int`, `>= 0` | |
| `AVG_BASKET_VALUE` | `basket` | decimal string, `>= 0` (no upper bound) | |
| `UTILITIES_PER_SQFT` | `utilities_per_sqft` | decimal string, `>= 0` (no upper bound) | |
| `LABOR_PCT_OF_REVENUE` / `MARKETING_PCT_OF_REVENUE` / `SUPPLIES_PCT_OF_REVENUE` / `CARD_SHARE` / `CARD_RATE` / `PAYROLL_TAX_PCT_OF_PAYROLL` / `SALVAGE_PCT_OF_RETAIL` / `RENT_ESCALATOR` | `labor_pct` / `marketing_pct` / `supplies_pct` / `card_share` / `card_rate` / `payroll_tax_pct` / `salvage_pct` / `escalator` | decimal string, `[0, 1]` | Pre-existing bound (task 1.1); `labor_pct == 1` is intentionally in-band (the §12.2 advisory band flag warns, the hard cap only rejects a nonsensical > 100% share). `card_share`/`card_rate` are Model v3's rename of the retired `card_pct` (§4.2) — same bound, new field names. |
| `CARD_PER_TX_FEE` | `card_per_tx_fee` | decimal string, `>= 0` (no upper bound) | Model v3 — a per-transaction $ fee, not a `[0,1]` fraction, so it takes the lower-bound-only treatment (like `basket`/`utilities_per_sqft`) rather than the `[0,1]` row above. |

**Fail-closed on legacy stored values:** because re-validation runs over the merged dict, a row that already carries an out-of-range value from *before* one of these bounds existed will 422 on its **next** `PATCH` — even one touching an unrelated field — until that value is re-sent in-range. This is intentional hardening, not a regression (DATA_MODEL.md §4.8 contract notes).

**Model v3 (3.0.0) scope: engine-only, no new PATCH exposure in this PR.** Of everything Model v3 added (§4.2/§5/§6.2), only the card-fee fields above (`card_share`/`card_rate`/`card_per_tx_fee`) are reachable via `AssumptionsIn` — and that is a **rename** of the already-exposed `card_pct`, not new exposure. `labor_mode` and its coverage-mode fields (`open_hours_per_week`, `cashier_tx_per_hour`, `min_staffed_lanes`, `door_dedicated`, `door_peak`, `runners`, `wage`, `mgr_salary`, `am_salary`, `am_count`), the production-station knobs (`avg_item_price`, `sell_through`, `items_per_hour`, `productive_hours_per_station`), `workers_comp_pct`, `contributions_annual`, and the share-ramp fields (`share_m1`/`share_m12` on `InputsIn`) are **not** on `AssumptionsIn`/`InputsIn` at all — they can only be set by constructing `engine.compute.Assumptions`/`Inputs` directly (i.e. from a test), never from a live PATCH. Every projection today computes with the engine defaults for all of them.
>
> This is a deliberate scope fence, not an oversight: a future "expose Model v3 knobs via PATCH" task must land two engine fixes in the **same** change that adds any of these fields to `AssumptionsIn`/`InputsIn`, or a live `labor_mode="coverage"` projection would silently diverge between its `computed_json` and its exported `.xlsx` (breaking the golden-gate invariant, §13):
> - `engine/xlsx.py`'s `_expense_formula`'s `"Payroll"` branch always emits `=<revenue>*<labor_pct>` — it does not branch on `labor_mode`, so an exported workbook would show the pct-mode formula even when the server computed coverage-mode payroll.
> - `engine/dag.py`'s `_UPSTREAM_OF["Payroll"]` lists only `("share", "labor_pct")` — it does not include the coverage-mode inputs, so the stale-pin hint would be incomplete (informational only; it never back-solves, but it would under-report staleness).
>
> Both are currently **unreachable in production** (no live projection can set `labor_mode="coverage"` without direct Python construction), so this is a documented gap, not a live bug.

---

## 3. Version locking & the upgrade lifecycle (PRD §13)

- `computed_json` and the `.xlsx` are **stamped** with the `model_version` that produced them.
- On **read**, if the stored `model_version` ≠ the current engine's `MODEL_VERSION`, **return the stored snapshot verbatim** and set a top-level `flags.model_upgrade_available = true`. **Never silently recompute.**
- `POST …/upgrade-model` recomputes with the new engine and **writes a NEW revision**; the prior revision is preserved (PRD §13, §24, §25).
- Track **two** versions independently:
  - `model_version` — the **math** changed (a formula, a default that changes results, the ramp).
  - `compute_schema_version` — the **shape** of `computed_json` / the view-model changed (a renamed field, a new KPI key) with no math change.
  - A renderer/shape change must not be mistaken for a math change. Golden fixtures are pinned to a specific `model_version`.

---

## 4. The driver model (annual P&L)

Bottom-up, donor-market-share driven (methodology §Drivers, lines 8–15). Inputs are explicit and defensible; nothing is a top-line guess.

Let `H` = trade-area households (§8 basis), `freq` = `DONATIONS_PER_HH_PER_YEAR`, `basket` = `AVG_BASKET_VALUE`, `donation_value` = resale value per donation (input).

For each year `y ∈ {1, 2, 3}`:

| Node | Formula | Source |
|---|---|---|
| `share[y]` | **explicit input** `share_y1`, `share_y2`, `share_y3` | §7.1 (NOT midpoint) |
| `donating_hh[y]` | `H × share[y]` | methodology 10 |
| `donations[y]` | `donating_hh[y] × freq` | methodology 11 |
| `retail[y]` | `donations[y] × donation_value` | methodology 12 |
| `customers[y]` | `retail[y] / basket` *(N/A-guarded, §12.4)* | methodology 13 |
| `salvage[y]` | `retail[y] × SALVAGE_PCT_OF_RETAIL` | methodology 14 |
| `contributions[y]` *(Model v3, 3.0.0)* | **optional flat input** `contributions_annual` (`Inputs`, not per-year) — default `CONTRIBUTIONS_ANNUAL = "0"`, so `total_rev` is byte-unchanged unless explicitly set | §4.2 |
| `total_rev[y]` | `retail[y] + salvage[y] + contributions[y]` | methodology 15 (Model v3 adds the `contributions` term) |

### 4.1 Year-2 is an explicit input — the midpoint is dead (and the horizon is 5 years)

The methodology's "Year 2 = midpoint" (methodology lines 17–18) and the engine's `share={1:y1, 2:(y1+y3)/2, 3:y3}` (line 65) and Excel `=AVERAGE(...)` (line 209) are **superseded by PRD §7.1**. v1 has an **independent blue input cell per year** for share. The annual P&L spans **five years** (`share_y1..share_y5`); Year 4 / Year 5 default to the decelerating-plateau `0.11`/`0.12`. The Excel year rows reference **their own input cells**, never `AVERAGE`. The wizard's "even ramp" helper may *pre-fill* intermediate years, but each value is a real, editable input.

### 4.2 Expense lines (annual)

`rent_y[y] = occupancy_y[y]` where occupancy is **either** `building_sqft × rent_per_sqft` **or** a directly entered annual occupancy dollar (§7.3), then escalated:

```
occupancy_y[y] = occupancy_y1 × (1 + RENT_ESCALATOR)^(y − 1)     # compound, y∈{1,2,3,4,5}; §1 (escalator compounds through Y5, same formula)
```

If `lease_type == "nnn"`, add researched/entered NNN opex to occupancy (§7.3, §16.4). The Gross/NNN toggle and the escalator both apply.

| Expense line | Formula | Default constant |
|---|---|---|
| **Credit card fees** *(Model v3, 3.0.0 — two-term formula, replaces the flat `CARD_FEES_PCT_OF_REVENUE`)* | `CARD_SHARE × (CARD_RATE × retail[y] + CARD_PER_TX_FEE × customers[y])` | `card_share` 65% of retail sales processed by card, `card_rate` 2.6% effective rate on that card volume, `card_per_tx_fee` $0.10/transaction (`customers[y]` is the transaction count, already computed above) |
| Payroll | `total_rev[y] × LABOR_PCT_OF_REVENUE` (mode `pct`, default) — **or** the `labor_mode: "coverage"` headcount/wage formula below | 60% (owner) |
| Payroll taxes | `Payroll[y] × PAYROLL_TAX_PCT_OF_PAYROLL` | 7.5% |
| **Workers' comp expense** *(NEW, Model v3, 3.0.0)* | `Payroll[y] × WORKERS_COMP_PCT_OF_PAYROLL` — a %-of-**payroll** line (like Payroll taxes), so it rides the monthly payroll ramp (`_PAYROLL_WEIGHTS`, §5), never the flat fixed-annual residual | 2.0% of payroll |
| **Marketing & outreach** *(NEW)* | `total_rev[y] × MARKETING_PCT_OF_REVENUE` | 3.75% |
| **Supplies & processing** *(reclassified)* | `total_rev[y] × SUPPLIES_PCT_OF_REVENUE` | 5.0% |
| Rent / occupancy | `occupancy_y[y]` (+ NNN opex if applicable) | sqft×rate or annual $ |
| Insurance liability | `FIXED_ANNUAL[...]` | $2,000 |
| Internet, Phones | fixed | $3,000 |
| Pest control | fixed | $300 |
| **POS platform** *(NEW, Model v3, 3.0.0)* | flat, `FIXED_ANNUAL[...]` — a store-level cost, NOT scaled by `stations_installed` | $4,800/yr ($400/mo) |
| **Production software** *(NEW, Model v3, 3.0.0)* | flat, `FIXED_ANNUAL[...]` — same store-level (not per-station) treatment | $1,200/yr ($100/mo) |
| Repairs/maintenance | fixed | $1,600 |
| Security system | fixed | $900 |
| **Utilities/trash service** *(sq-ft-derived, #245)* | `building_sqft × UTILITIES_PER_SQFT` (flat across years — sq ft drives it, not the rent escalator) | $2.23/sqft → $22,300 at 10k |

```
total_exp[y] = sum(all expense lines above)
net[y]       = total_rev[y] − total_exp[y]
margin[y]    = net[y] / total_rev[y]        # N/A if total_rev[y] == 0 (§12.4)
```

**Year-1 reconciliation rule:** the annual Year-1 column is **the roll-up of the 12 monthly P&L rows** (§10), not an independent annual computation. A golden test asserts `annual_Y1 == sum(monthly M1..M12)` **to the penny** (§13.4). Years 2–3 are annual (§10.3).

**`labor_mode: "coverage"` (Model v3, 3.0.0) — headcount/wage-driven Payroll, an alternative to the `pct` default.** Selected per-projection via `Assumptions.labor_mode` (not yet PATCH-exposed, §2.1). Uses the year's **average month** (`production_hours[y] / 12`, `customers[y] / 12`) rather than the actual monthly-weighted ramp, because `compute_annual` (which produces the annual Payroll figure) runs **before** `build_monthly` — depending on the real monthly ramp would be circular:

```
open_hours_per_month = OPEN_HOURS_PER_WEEK × 52 / 12
cashier_hours   = max(customers[y]/12 / CASHIER_TX_PER_HOUR, MIN_STAFFED_LANES × open_hours_per_month)
door_hours      = (DOOR_DEDICATED + DOOR_PEAK) × open_hours_per_month
runner_hours    = RUNNERS × open_hours_per_month
hourly_hours    = (production_hours[y]/12) + cashier_hours + door_hours + runner_hours
salaries        = MGR_SALARY + AM_COUNT × AM_SALARY
Payroll[y]      = hourly_hours × WAGE × 12 + salaries      # coverage mode
```

Every division above is zero-guarded (§12.4). The monthly Payroll split is unchanged either way — the resulting **annual** Payroll dollar figure rides the existing `_PAYROLL_WEIGHTS` hire-ramp in `engine/monthly.py` regardless of `labor_mode`. `break_even_revenue`'s fixed/variable split (§6.1) correctly **drops** the labor term from `var_rate` under coverage mode (Payroll is a `max()`-and-sum of driver terms, not a clean revenue percentage — including it would produce a confidently-wrong break-even revenue); the actual Payroll dollars still land in `total_exp`, so they fall into the `fixed` residual instead of being double-modeled. `pct` mode is byte-unchanged.

**Production-station module (Model v3, 3.0.0) — read-only derived metrics, never feed `total_rev`/`total_exp`.** A physical throughput chain bridging retail dollars to a staffing/space count, computed alongside the driver chain above and surfaced in the view-model (§9.1) and `.xlsx`, but not in this task's cost stack:

```
items_sold[y]        = retail[y] / AVG_ITEM_PRICE                          # N/A-guarded
items_produced[y]     = items_sold[y] / SELL_THROUGH                        # N/A-guarded
production_hours[y]   = items_produced[y] / ITEMS_PER_HOUR                  # N/A-guarded
stations_staffed[m]   = production_hours_month[m] / PRODUCTIVE_HOURS_PER_STATION   # monthly, N/A-guarded
stations_installed    = ceil(max(stations_staffed[m] for all months))       # peak monthly value, 0 if never positive
```

`items_sold`/`items_produced`/`production_hours` are annual (`AnnualYear` fields); `stations_staffed` is monthly (rides a linear rescale of the existing footing-exact revenue split, §5); `stations_installed` is a single top-level integer on `ComputeResult` (not per-year). All four are **non-pinnable** (§7.3).

### 4.3 One-time startup costs (Year 0)

| Line | Value | Source |
|---|---|---|
| Thrift Store Consultant | `STARTUP[...]` $100,000 | methodology 43 |
| Equipment & Fixtures | $45,000 | |
| Lease Deposit + First Month Rent | `occupancy_y1 × 3 / 12` | methodology 45; uses the **resolved** `occupancy_y1` (incl. NNN opex), **not** escalated (Task 6.4). Multiply-before-divide keeps it exact |
| Build-out / Renovations / Tenant Improvements | $50,000 | |
| Legal, Permits, Insurance Setup, Signage | $13,500 | |

```
startup_total = sum(startup lines)
```

---

## 5. Monthly launch cash-flow model (the new core, PRD §10)

A 3-year annual P&L hides early-failure risk. The model is **monthly-first**; Year-1 annual is derived from it (§4.2 reconciliation rule).

### 5.1 Year 1 definition (locked, §10.1)
**Year 1 = the first 12 operating months**, starting at the planned opening month — not a calendar/fiscal year. This label is identical across UI, KPIs, Excel, narrative, and exports.

> **The monthly series spans the full 60-month horizon (model 2.7.0).** Year 1 is still
> "the first 12 operating months", but the model now emits **60 operating months**
> (`G..G+59`) so the cash-flow series reaches the **payback crossing** across years (§6.6).
> Year 1 keeps the launch S-curve byte-for-byte; **Years 2–5 GLIDE from the prior year's
> own last month toward that year's flat steady-state average over `_BLEND_MONTHS` (3)
> months, then hold flat** (model 2.9.0, owner defect fix, 2026-07-05 — an instant
> flat-jump at the year seam used to read as an unexplained one-month Net cliff on the
> chart; see `engine/monthly.py` module docstring for why a full "net never decreases"
> guarantee isn't achievable while Year 1 keeps its S-curve) — the intra-year shape for
> Years 2–5 affects only the EXACT payback month by a few positions, never the annual
> totals, capital, break-even, or cash gap. `N = max(G+59, last scheduled month)`.

### 5.2 Months M0–M12 (§10.2)
- **`M0`** = pre-open month(s), present only when `opening_status == "pre_launch"`.
- **`M1…M12`** = the first 12 operating months (the Year-1 window; the series continues to month 60).

For each month:

| Component | Rule |
|---|---|
| **Startup outflows** (timed) | Lease deposit, build-out, fixtures/equipment, opening inventory, legal/permits, consultant placed in **their actual months**, not averaged. |
| **Donation ramp** | Donations build from opening to steady state over an S-curve (the fixed `_REVENUE_WEIGHTS` / `_PAYROLL_WEIGHTS` vectors in engine/monthly.py, summing to 1). Steady state = Year-1 annual donations / 12 once ramped. |
| **Revenue ramp** | `retail[m]` follows the monthly revenue weight; `salvage[m]` follows `retail[m]`. |
| **Costs** | Three streams, each distributed by its own weights (Wave-6 / 6.2): **Payroll AND payroll taxes** follow the payroll hire-ramp (`_PAYROLL_WEIGHTS`; payroll taxes are a fixed % **of payroll**, so they track payroll month-to-month, never the revenue curve — this fixes the earlier "payroll-tax scales with revenue" wording); **%-of-revenue lines** (`card, marketing, supplies` — the `_PCT_OF_REVENUE_LABELS` frozenset) scale with **that month's** revenue (`_REVENUE_WEIGHTS`); **fixed annual lines** (Rent, Utilities/trash service, and every other `annual_y1.expenses` label — the FIXED_ANNUAL contract lines; an unclassified new label defaults to fixed) spread **flat 1/12 per operating month**, cent-quantized with the **last operating month absorbing the residual**, so the roll-up stays penny-exact. |
| **Net** | `net[m] = revenue[m] − expenses[m]` (expenses include timed startup outflows in cash terms). |
| **Cumulative cash** | `cumulativeCash[m] = cumulativeCash[m−1] + net[m]`, with stated funds as the starting balance where modeled. |

> The monthly ramp shape and seasonality are **calibration backlog** (§12.5, PRD §29). They are emitted with a **low-confidence flag** until calibrated against a real opening (§6.3 actuals). A confidently-wrong break-even month is worse than a labeled-uncertain one.

### 5.3 Annual roll-up (§10.3)
`Year-1 P&L = Σ monthly[M1..M12]`. With the 60-month horizon the roll-up is **per year**: for **every** year `y`, `annual[y].{total_rev, total_exp, net} = Σ` that year's 12 operating months, to the penny in Decimal (Regression #15, now per year; the last month of each year absorbs the rounding residual). The monthly model and the annual roll-up flow through the **same** override DAG evaluator (§7) so the two surfaces can never disagree.

> **Year-1 cash window (Regression #15, cash basis).** The displayed **Year-1 cash net** (`operating_net[1] − startup_total`) equals the sum of **all monthly cash nets** that fall in the Year-1 window — **project months `1..G+11`** (every pre-opening startup month plus the 12 Year-1 operating months) — **including the startup outflows**. When all startup costs fall within Year 1 (the default and all primary fixtures) this is exact; a cost scheduled beyond the Year-1 window is the only case where the displayed `cash_net[1]` (which always subtracts the full `startup_total`) and the Year-1 monthly-window sum diverge.

### 5.4 Optional linear Year-1 revenue-share ramp (Model v3, 3.0.0)

Year-1 monthly revenue defaults to the fixed `_REVENUE_WEIGHTS` S-curve (§5.2). `Inputs` gains two optional fields, `share_m1`/`share_m12` (both `str | None`, default `None`) — when **both** are set, Year-1 revenue instead rides a **linear** interpolation from `share_m1` to `share_m12` across the 12 operating months, in place of the S-curve:

```
weight[m] = share_m1 + (share_m12 − share_m1) × (m − 1) / 11      # m ∈ {1..12}; not required to sum to 1 — _distribute renormalizes internally, exactly as the fixed S-curve weights are today
```

Both `retail[m]` **and** every %-of-revenue expense line (card fees' revenue-proportional term, marketing, supplies) switch to the linear weights together, so the "expenses are a fixed % of revenue" invariant holds intra-year regardless of which curve is active. `_PAYROLL_WEIGHTS` (Payroll, Payroll taxes, Workers' comp expense) is untouched — payroll rides its own hire-ramp independent of this setting. Years 2–5 are unaffected (they never read `_REVENUE_WEIGHTS`; the Years 2–5 glide, §5.1, anchors on the prior year's own last month).

**Byte-identical when unset (the anchor invariant).** `share_m1`/`share_m12` default to `None`; when either is unset, Year-1 revenue is the existing `_REVENUE_WEIGHTS` S-curve, byte-for-byte — a golden-pinned property (`test_share_ramp_unset_is_byte_identical`). None of the five Model v3 golden fixtures set this field, so none of their numbers move because of it. Regression #15 (annual == Σ monthly, to the penny) holds on the ramped path exactly as on the S-curve path. Not yet exposed via `InputsIn` PATCH (§2.1).

---

## 6. Decision metrics, guardrails & recommendation (PRD §12)

All computed in the core; all asserted by golden tests (not merely rendered).

### 6.1 Capital & cash (§12.1)

```
first_year_cash_gap   = min(cumulativeCash[m] for G ≤ m ≤ G+11)  # most-negative position in the operating Year-1 window; ≤ 0 (#182)
launch_trough         = min(cumulativeCash[m] for m.index ≤ G+11)  # pre-opening + Year-1 window (scoped so the 60-month horizon can't drift a later-year dip in)
peak_cash_shortfall   = |min(0, launch_trough)|
startup_capital_required = peak_cash_shortfall + CASH_RESERVE_BUFFER   # trough already embeds startup (spent at M0) — NEVER add startup_total again
cash_runway_months    = # non-negative cumulative-cash months from the first month with cash activity until cash first goes negative; leading zero-cost pre-opening months don't count; null when cash never goes negative within the horizon (#184)
break_even_revenue    = solve(net == 0 over fixed+variable structure)   # monthly and annual
break_even_month      = first Year-1 operating month ≥ G where net[m] ≥ 0 AND sustained through the Year-1 ramp   # Year-1-scoped; null if never
payback_month         = first project-month where cumulativeCash[m] ≥ 0 AFTER having gone negative   # CASH recovery (epic #321); null ⇒ N/A-with-reason
```

> **Capital, break-even, and first-year cash gap stay Year-1-anchored under the 60-month horizon (model 2.7.0).** The monthly series now runs to month 60 so `payback_month` can resolve across years, but the launch metrics are **scoped** so the extension cannot move them: the **capital** trough is bounded to `m.index ≤ G+11` (pre-opening + the Year-1 operating window), **break-even** is computed over the Year-1 operating window only (a later-year operating dip can never erase a real Year-1 break-even), and **first-year cash gap** is already the strict `G..G+11` window. For the canonical `G=1` fixtures these are byte-identical to the pre-60-month model (the launch window *is* the old 12-month series), and the launch trough is the global minimum because the S-curve front-loads Year-1 losses.

> **Payback is CASH recovery (model 2.8.0, epic #321 lineage).** `payback_month` is the first project-month whose `cumulativeCash ≥ 0` **after** the curve has gone negative — i.e. the one-time startup outlay is fully recovered in cash. The "after going negative" guard means the leading zero-cost pre-opening months are not read as "recovered at month 1". For the all-startup-at-opening case this is arithmetically identical to "Σ(operating net since opening) ≥ startup_total" (so the recovered-case month is unchanged), but the cash basis is what lets payback span Years 2–5. A positive-operating-net projection (e.g. the 40% design-parity fixture) resolves to a real **Month 32** (the fused 6.2 Year-1 distribution shifts it from the pre-fusion Month 30); a multi-year loss (the 60% canonical fixture) stays **N/A-with-reason**.

> **`first_year_cash_gap` is the Year-1 OPERATING window, not "every operating-kind month" (#182).** The timeline can extend past `G+11` to place a scheduled cost on a post-open month (`N = max(G+11, last scheduled month)`); those extension months are tagged `operating` but are **outside** the 12-month Year-1 window. The gap is bounded by month **index** `G..G+11`, so a Year-3 cost (e.g. a cost at month 30) can never pull its deeper trough into the first-year funding headline.

> **`cash_runway_months` ignores leading zero-cost pre-opening months (#184).** Pre-opening months that carry no scheduled cost have `cumulativeCash == 0`; counting them as "cash-positive" made runway trivially `1` on every pre-opening timeline even when cash later plunged deeply negative. Runway now counts the non-negative months from the **first month with cash activity** up to the first month cash goes negative; it is `0` when cash goes negative the moment money is first spent, and `null` (N/A) when cash never goes negative within the horizon.

Months are numbered on the uniform **project-month timeline** `1..N` (`N = G+11`, `G = opening_month_number`); pre-opening months `1..G-1` accumulate their scheduled-cost losses into `cumulativeCash` from month 1 (§5).

The decision banner surfaces `startup_capital_required` prominently (prototype: ~$277,990) with a **"Why? →"** reasons drill-down (§19.3).

### 6.2 Guardrails & sensitivity (§12.2)

Each driver has an advisory benchmark band. Exceeding it sets a `flags` entry **and** requires the user to write a justification note that travels into the packet (§17).

| Metric | Advisory band |
|---|---|
| Donor market share (Y1, **Y4, Y5**) | ≤ ~8% (`SHARE_Y1_BAND_MAX`). The band-violation check is set on Year 1 **and** the late years Year 4 / Year 5, each with its own flag key (`share_y1_out_of_band` / `share_y4_out_of_band` / `share_y5_out_of_band`). The decelerating-plateau default `0.11`/`0.12` for Y4/Y5 sits above the conservative band, so a default 5-year projection carries advisory `share_y4`/`share_y5` flags + a justification note — an **advisory badge, not a math error**. The recommendation gate (§6.3) still keys on `share_y1_out_of_band` only, so the verdict is unchanged. |
| Sales per sq ft | ~$50–$300 (`SALES_PER_SQFT_MIN`/`MAX`) → flag key `sales_per_sqft_out_of_band` (Task 6.3; Year-1 revenue / salesfloor sqft; N/A-guarded on zero revenue / zero salesfloor). **Operating-layer** (unaffected by the cash display). |
| Labor ratio | ~25–60% of revenue (`LABOR_RATIO_BAND_MIN`/`MAX`) → flag key `labor_ratio_out_of_band` (Task 6.3; resolved `Payroll[1] / total_rev[1]` — **override-aware**: a pinned Payroll cell moves the ratio the flag checks). **Operating-layer.** |
| Occupancy ratio | ≤ ~20% of revenue (`OCCUPANCY_RATIO_BAND_MAX`) → flag key `occupancy_ratio_out_of_band` (Task 6.3; resolved `Rent[1] / total_rev[1]` — **override-aware**). **Operating-layer.** |
| Net margin (Y1, **Y4, Y5**) | flag > ~30% as unusual (`net_margin_out_of_band` for Y1; `net_margin_y4`/`net_margin_y5_out_of_band` for the late years). **Runs on the displayed (cash) margin (model 2.8.0):** Year-1 cash margin = `(operating_net[1] − startup_total) / total_rev[1]`; Years 4/5 cash margin == operating margin (no startup). The Year-1 startup hit depresses the cash margin, so an implausibly-high margin now surfaces on the late steady-state years — the honest signal for a new store. |
| **Leadership coverage advisory** *(NEW, Model v3, 3.0.0 — `labor_mode == "coverage"` only)* | flag key `leadership_coverage_advisory`, `{ open_hours_per_week, note, requires_note: false }` — **informational only**, never blocks and never forces a justification note (unlike every other guardrail in this table). Surfaces the implied manager/assistant-manager headcount needed to cover every open hour: `implied_am = ceil(max(0, open_hours_per_week − 40) / 40)`, rendered as "At `N` open hrs/week, plan for 1 store manager + ~`implied_am` assistant manager(s) so a manager or AM is on duty all open hours." Absent entirely when `labor_mode == "pct"`. |

All three 6.3 flags carry `{ value, band, requires_note: true }` and read the SAME resolved Year-1 values the KPI strip shows (override-aware, N/A-guarded); `leadership_coverage_advisory` above is the exception — `requires_note: false` by design. **`break_even_revenue` guard:** when the variable-cost rate (card fees' revenue-proportional term + marketing + payroll×(1+payroll_tax) *(pct mode only — see below)* + supplies) is **≥ 100% of revenue**, break-even revenue is mathematically undefined — no revenue level ever recovers fixed costs — so `decision.break_even_revenue_annual` guards to `null` and `flags["break_even_revenue"] = "N/A — variable-cost rate ≥ 100% of revenue"` (never a `#DIV/0!` or a nonsense figure). **Under `labor_mode == "coverage"` (Model v3, 3.0.0), the labor term drops out of `var_rate` entirely** — coverage-mode Payroll is a `max()`-and-sum of headcount/wage terms, not a clean percentage of revenue, so folding it into `var_rate` would produce a confidently-wrong break-even figure; the actual Payroll dollars still land in `total_exp` and correctly fall into the `fixed` residual instead. `pct` mode's `var_rate` is byte-unchanged (aside from the Model v3 card-fee field rename, §4.2). The per-transaction card-fee term (`CARD_PER_TX_FEE × transactions`) is likewise folded into `fixed`, not `var_rate` — it isn't a clean percentage of revenue either.

**Sensitivity:** base / downside / upside at `±SENSITIVITY_DELTA` (25%) on **rent** and **donations**, showing the effect on net profit, break-even month, and capital required. Each scenario is a full re-run of the core. Downside scenarios are **fixtured** (§13.6) so a sign/compounding error cannot ship behind a passing happy path.

> **Rent stress is encoding-independent (#181).** "Rent" for the stress is the **resolved annual occupancy** the model actually charges — whether it was entered as an explicit `occupancy_annual`, derived from `rent_per_sqft × building_sqft`, or carries an `nnn` opex add-on. The scenario resolves occupancy to a single quantity and multiplies it by the rent factor, so the `±25%` shock lands identically no matter how rent was encoded. (Pre-2.3.0 the multiplier was applied only to `occupancy_annual` and never to `nnn` opex, so a `rent_per_sqft`/`nnn` projection silently skipped the +25% downside rent shock — making the downside artificially rosier and **flipping the go/no-go verdict** on identical economics. Golden-asserted across all four encodings.)

### 6.3 Recommendation (rules-based, explainable, §12.3)

The core emits a semantic **`reco.tag`** enum; the **client** maps enum → color/token (the API never hard-codes hex — see §9.3). Resolution order (first match wins), each with the reasons shown:

| `reco.tag` | Condition |
|---|---|
| `do_not_proceed` | break-even not reached within horizon under base **or** downside |
| `raise_cash` | `startup_capital_required` > stated source of funds |
| `find_cheaper_rent` | occupancy ratio out of band is the **binding** constraint |
| `delay` | ramp/seasonality makes the chosen opening month cash-infeasible |
| `revise` | outcome hinges on out-of-band inputs (flagged) |
| `proceed` | positive Year-1 cash trajectory, capital need ≤ stated funds, ratios in band |

**`do_not_proceed` messaging must distinguish base vs downside (#142/#145).** The
trigger above fires when **either** the base **or** the downside scenario fails to
reach break-even, but those are very different stories and the reason text must say
which — it can never read as a flat "break-even is never reached" when the headline
`metrics.breakeven` shows a real Month-N for the base case (a self-contradiction on
one screen). The engine emits the precise reason in `reco_reasons["breakeven"]`, and
the view-model uses that same string as **both** `reco.sub` and
`metrics.reasonBreakeven` (single source of truth, no second surface):

- **Base never breaks even:** "Break-even is not reached within the horizon under the base case (and the downside scenario fails as well) — the plan is not viable as configured." (Here `metrics.breakeven` is the N/A sentinel, so there is no contradiction.)
- **Base breaks even but the downside does not** (e.g. the Grace Mission fixture, break-even Month 8; pre-6.2 this was also the canonical 60%-labor default): "Base case reaches break-even at Month N, but the downside scenario (rent +25% / donations -25%) never does — the plan is not robust to a tougher market." This surfaces the downside as the driver of the verdict so a non-finance ED isn't confused by "Do not proceed" sitting next to a "Month 8" break-even.

> **Consistency invariant (golden-asserted):** when `metrics.breakeven.raw` is a real
> month, neither `reco.sub` nor `metrics.reasonBreakeven` may claim break-even is
> "not reached" without scoping that to the downside scenario and naming the
> base-case break-even. Enforced by `assert_breakeven_text_consistent` over both the
> live view-model and the frozen `house_of_hope_canonical_60` golden. The verdict
> threshold/guardrail logic is unchanged — this is messaging/transparency only.

### 6.4 KPIs (§11)
Per period, recomputed live (subject to §12.4 guards): Total revenue · **Net income** · Net margin · **Sales per sales-floor sq ft** · Sales per total sq ft · Revenue per donation · Revenue per customer · Annual donations · Customers · Occupancy cost ratio · Labor ratio · Donations per sq ft · **Break-even month** · **Startup capital required** · **First-year cash gap** · **Payback period** (the precise `payback_month`, §6.6) · Revenue CAGR (**Y1→Y5**).

> **Net income & Net margin are CASH-based and congruent (model 2.7.0, epic #321).** The displayed `Net income` row + KPI, the `Net margin` row + KPI, `incomeSeries`, `year5Income`, and the card `y1_net` all source from the **cash** net: `cash_net[1] = operating_net[1] − startup_total`, `cash_net[y] = operating_net[y]` for `y≥2`; and `net_margin[y] = cash_net[y] / total_rev[y]`. Both displayed numbers are cash-based, so the margin equals net ÷ revenue exactly — **one congruent margin, no footnote, no operating twin**. The **labels stay "Net income"/"Net margin"** (only the numbers become cash-based). The **internal operating net** `AnnualYear.net = total_rev − total_exp` is unchanged and is the value the recommendation, `simple_payback_years`, the sensitivity re-runs, and the monthly operating roll-up read — so the go/no-go verdict is unmoved by the cash framing (the funding story is carried by `capital_required` + `payback`). `cash_net()` / `cash_margin()` live in `engine/compute.py` (the one math authority); the view-model and `.xlsx` consume them.

> `simple_payback_years` (`startup_total / net[1]`) is **retained internally** (still computed and listed as a non-pinnable derived node) but is **no longer surfaced on the view-model**: the KPI strip shows the precise **Payback period** milestone (`payback_month`) instead (§6.6).

```
sales_per_salesfloor_sqft = total_rev[1] / (building_sqft × salesfloor_pct)   # N/A if denom 0
occupancy_ratio[y]        = occupancy_y[y] / total_rev[y]                      # N/A if rev 0
labor_ratio[y]            = Payroll[y] / total_rev[y]                          # N/A if rev 0
simple_payback_years      = startup_total / net[1]                            # N/A if net[1] ≤ 0
revenue_cagr              = (total_rev[5] / total_rev[1])^(1/4) − 1           # Y1→Y5, 4 periods; N/A if rev[1] == 0
```

### 6.6 Milestones (project-month timeline, §8 / #117)

Three milestones are computed precisely on the `1..N` timeline and emitted on the view-model as a top-level `milestones` block, each a dual-value `{raw, display}` (e.g. `{raw: 6, display: "Month 6"}`). The **server is the formatting authority** — the client renders the `display` string verbatim, never re-deriving "Month N".

| Milestone | Definition | Value |
|---|---|---|
| `grandOpening` | `grand_opening_month = G` (the `opening_month_number` input) | always known |
| `breakEven` | `break_even_month` — first sustained **Year-1** operating month (≥ G) with ongoing net ≥ 0 | `null` ⇒ N/A-with-reason |
| `payback` | `payback_month` — first project-month where **cumulative cash ≥ 0 after going negative** (the one-time startup outlay is recovered in cash, model 2.7.0) | `null` ⇒ N/A-with-reason; carries a `duration` display ("30 months") when reached |

When a milestone is not reached within the horizon the value is the explicit N/A sentinel `{raw: null, display: "N/A", reason: "<engine flag reason>"}` (the existing `flags` pattern), **never a misleading 0**. The `.xlsx` `MILESTONES` block renders the same `display` strings (single formatting authority).

### 6.5 Numeric discipline (rounding authority)
- **Compute in `Decimal` (or integer cents) internally; round only at display/compare** (§12.4).
- **Money** displays as **whole dollars**; **percentages** to **0.1pp**.
- The **server is the single formatting authority** and emits both `raw` (numeric) and `display` (formatted string) for every value (§9.2). The client never re-derives money/percent formatting.
- The golden tolerance (<$0.50 / 0.1pp) exists to absorb the delta between Python `Decimal` and LibreOffice `double` recalc. **Comparison rule:** round **both** sides to whole dollars (money) / 0.1pp (percent) before computing the delta; assert `abs(delta) < 0.50` for dollar cells, `< 0.1` for percent-point cells.

---

## 7. Override DAG & resolution rules (PRD §11, §14)

Cell overrides are **pins** on a DAG; recompute is **topological** so the statement always foots.

### 7.1 The graph (§14)

```
market_share[y] → donating_households → donations → retail_revenue → customers
retail_revenue → salvage_sales ; retail + salvage → total_revenue
total_revenue → card_fees, marketing, supplies, payroll → payroll_taxes ; sqft,rate(,opex),escalator → rent
{expense lines} → total_expenses → net_profit → net_margin
```
The monthly model and the annual roll-up are **both** evaluated through this single graph (§5.3).

### 7.2 Override key format (§24)
Keys are `"{node}#{year}"`, e.g. `"Payroll#2"`, `"share#1"`, matching `overrides_json` and Appendix B. A pin is `{ value, note, ts }`.

### 7.3 Resolution algorithm

```
resolve(node):
    if node is pinned:
        return pin.value
    return f(resolve(parent) for parent in parents(node))   # the node's formula over resolved parents
```

Rules:
- **Pinned nodes use their value.** Unpinned nodes compute from (possibly pinned) inputs.
- **No upstream back-solve.** Pinning a downstream node does **not** mutate any upstream input. An upstream row that no longer drives any pinned downstream value gets a **`stale` flag** (rendered as the "no longer drives a pinned value" hint; §14).
- **Derived rows + totals + margins + KPIs are NEVER pinnable** so the statement always foots. Pin writes to a non-pinnable node are **rejected at the API boundary** (HTTP 4xx), not merely hidden in the UI. The non-pinnable node list:
  `total_revenue, total_expenses, net_profit, net_margin, customers (derived), salvage_sales, donating_households, donations`, plus **every KPI and every decision metric** (`break_even_month, startup_capital_required, first_year_cash_gap, cash_runway_months, simple_payback_years, revenue_cagr`), plus the **production-station module** (Model v3, 3.0.0 — read-only derived metrics, §4.2): `items_sold, items_produced, production_hours, stations_installed`. These four are implicitly rejected already (they are simply absent from `PINNABLE_NODES`), documented here explicitly per the existing pattern for error-message/test clarity.
  **Pinnable** nodes — and this set is **honest**: every member, when pinned, measurably changes computed output, so the API never accepts-and-persists a no-op pin (#183) — are the per-year revenue driver `share[y]` and the **component expense lines** (`Payroll, Marketing & outreach, Supplies & processing, Credit card fees, Payroll taxes, Workers' comp expense, Rent, Insurance, Internet, Pest control, POS platform, Production software, Repairs, Security, Utilities`) — the last two, **Workers' comp expense** and **POS platform / Production software**, are Model v3 (3.0.0) additions (§4.2). The rate/driver inputs (`labor_pct, marketing_pct, supplies_pct, card_share, card_rate, card_per_tx_fee, payroll_tax_pct, salvage_pct, escalator, basket, donation_value, donations_per_hh, sqft, rent_per_sqft, occupancy`) are **NOT** per-year pins — they are edited as **global assumptions** (`compute()` reads them directly, never via a pin), so a pin on them is **rejected** (HTTP 4xx), not silently ignored. To change one, edit the assumption; to fix a year's resulting expense, pin the component line (e.g. pin `Payroll`, not `labor_pct`). `contributions` (Model v3) is likewise **not** a per-year pin — it is a flat `Inputs.contributions_annual` assumption, like `donation_value`, not a driver-chain cell.
- **Reset:** per-pin reset deletes that key; global reset clears all keys.
- **Totals always derive from resolved component values** so the in-sheet `=SUM(...)` and the server's resolved total are computed from **the same** numbers (this is the case most likely to break the <$0.50 gate — see §11.4).

### 7.4 Required override unit/property tests
- Pin a component → the total re-foots via formula over the now-hardcoded cell.
- Pin then reset → returns to the computed value.
- Attempt to pin a derived/total/KPI/decision node → **rejected** server-side.
- **Every** node in `PINNABLE_NODES`, when pinned, **measurably changes** computed output (no advertised-but-ignored pin); a pin on a non-honored rate/driver input is **rejected**, not silently accepted (#183).
- Pin an upstream input that no longer drives any pinned downstream node → **`stale` flag set**.
- Property: the statement **always foots** (`total_exp == Σ resolved expense lines`; `net == total_rev − total_exp`) under any subset of legal pins.

---

## 8. Edge-case math & N/A sentinels (PRD §12.4)

All guards live in **one** place in the core and are **mirrored** in Excel (§11.5). `computed_json` carries an explicit `null` for every N/A value **plus** a `flags` map describing why.

| Trigger | Affected outputs | Sentinel |
|---|---|---|
| `total_rev == 0` (e.g. 0% share) | `margin`, `sales_per_sqft`, `revenue_per_donation`, `revenue_per_customer`, `occupancy_ratio`, `labor_ratio`, `customers` | `null` + `flags["margin"]="N/A — no revenue"` |
| `net[1] ≤ 0` | `simple_payback_years` | `null` + `flags["payback"]="N/A — no Year 1 profit"` |
| `total_rev[1] == 0` | `revenue_cagr` | `null` + `flags["cagr"]="N/A"` |
| `break_even_month` never reached | `break_even_month`, `cash_runway_months` | `null` + `flags[...]="N/A — not within horizon"` |
| negative value | any P&L value | render in **parentheses + error color**; never `#NUM!` |
| `building_sqft == 0` | — | **blocked at input** (validation error; never computed) |
| out-of-band driver | guardrail metrics | advisory **badge** + requires justification note (§12.2); a flag, **not** a math error |

**`flags` map shape** (top-level in `computed_json`):
```json
"flags": {
  "model_upgrade_available": false,
  "margin": null,
  "payback": "N/A — no Year 1 profit",
  "share_y1_out_of_band": { "value": 0.15, "band": "≤ ~8%", "requires_note": true },
  "ramp_low_confidence": true
}
```

---

## 9. Engine output contract (the view-model, Appendix D)

`engine/compute.py` is **pure, deterministic, side-effect-free**:

```python
def compute(inputs, assumptions, demand_drivers, trade_area, overrides) -> ComputeResult: ...
```

It returns the **App-D view-model** as its native output — the **same** structure the React frontend renders and the `.xlsx`/packet builders consume. This prevents a second math/format surface (the §13 anti-goal). It is serialized into `computed_json` (with `monthly_json` and `flags`).

### 9.1 Top-level fields (Appendix D, verbatim names)

| Field | Shape |
|---|---|
| `reco` | `{ tag, headline, sub, color, bg, icon }` — `tag` is the §6.3 enum; `color/bg/icon` are **client-derived** (see §9.3) |
| `metrics` | `{ capital, cashGap, breakeven }` + reasons `{ reasonCapital, reasonGap, reasonBreakeven }` |
| `milestones` | `{ grandOpening, breakEven, payback }` — each `{ raw, display }`; unreached ⇒ `{ raw: null, display: "N/A", reason }`; `payback` adds `duration` ("25 months") when reached (§6.6) |
| `kpis[]` | `{ label, value, sub, color }` — includes the **Payback period** KPI (sourced from `milestones.payback`); the `simple_payback_years` KPI is retired (§6.4). Model v3 (3.0.0, schema 1.8.0) adds **"Production stations (peak)"** — `value` is `number_view(stations_installed)` (a bare count, `{raw,display}` like every other KPI, not a money view). |
| `monthly[]` | per **project month 1..N** (now the full **60-month** horizon, model 2.7.0) `{ revenue, expenses, scheduledCosts, net, cumulativeCash }` (the same columns as the `.xlsx` Monthly tab; `net = revenue − expenses − scheduledCosts`, so a pre-opening month reads as a real loss) + top-level `breakevenMonth` |
| `rows[]` | per 5-year line `{ label, group, y1, y2, y3, y4, y5, class: input\|computed\|overridden\|estimated, editable }` (every annual row carries all five year cells; the "Net income" and "Net margin" rows are **cash-based** — Year-1 includes the one-time startup hit, model 2.7.0 — but keep their labels). Model v3 (3.0.0, schema 1.8.0) adds: a **"Contributions"** row (`group: "revenue"`, `computed: false`/editable — a direct settable input like `share`, not a derived quantity) placed directly before "Total Revenue"; and three **read-only** rows in a new `group: "production"` — **"Items sold"**, **"Items produced"**, **"Production hours"** — placed after "Salvage Sales"/before the expense rows, each `computed: true` (non-editable, non-pinnable per §7.3). |
| `incomeSeries[]` · `year5Income` | annual **net income** Y1..Y5 as `{raw,display}` (the list/detail sparkline) + the Year-5 figure; server is the one format authority |
| `startupCosts[]` · `startupTotal` | the one-time startup line items `[{ category, amount{raw,display} }]` (from `result.startup`, includes the computed "Lease Deposit + First Month Rent") + their total `{raw,display}`; feeds the Board Packet `.docx` startup-costs table (schema ≥ 1.5.0) |
| `stationsInstalled` *(NEW, Model v3, 3.0.0, schema 1.8.0)* | a plain top-level **int** (not `{raw,display}` — a count, matching the `breakevenMonth` precedent) — `result.stations_installed`, the ceiling of the peak monthly `stations_staffed` (§4.2). Also rendered on the `.xlsx` MILESTONES block as "Production stations needed (peak month)". |
| `overrides[]` | per pin `{ node, year, calculated, value, note, pinnedDate, affected[] }` |
| `evidence[]` | `{ label, value, method, badge, change, meta }` |
| `settings` | `{ laborPct, marketingPct, suppliesPct, cardShare, cardRate, cardPerTxFee, payrollTaxPct, salvagePct, escalator, basket, donationsPerHh, donationValue, donationsPerHouseholdPerYear, shareY1, shareY2, shareY3, shareY4, shareY5, occupancyAnnual, leaseType, salesfloorSqft, reserveBuffer }` (E2: `donationValue` + `donationsPerHouseholdPerYear` join `basket` as editable donation drivers; `donationsPerHh` retained as an alias). **Model v3 (3.0.0):** `cardPct` is renamed to `cardShare`/`cardRate`/`cardPerTxFee` (the two-term card-fee formula, §4.2) — this is the **only** settings-key change Model v3 makes; `labor_mode`, the coverage-mode fields, the production-station knobs, `workers_comp_pct`, `contributions_annual`, and `share_m1`/`share_m12` are **not** surfaced in `settings` (engine-only for now, §2.1). |
| `version`, `model_version`, `compute_schema_version`, `flags` | version stamps (§3) + the N/A flags map (§8) — `flags` gains `leadership_coverage_advisory` under `labor_mode == "coverage"` (§6.2) |

### 9.2 Dual-value convention
Every money/percent value is emitted as `{ raw, display }` — `raw` is the numeric (Decimal-derived) value used for the golden compare; `display` is the server-formatted string (whole dollars / 0.1pp). The client renders `display` and never re-formats (§6.5).

### 9.3 Color is semantic, not API-baked
The core emits `reco.tag` (`proceed | revise | find_cheaper_rent | raise_cash | delay | do_not_proceed`) and cell `class` (`input | computed | overridden | estimated`). The **client** maps these to brand/semantic tokens. The API never returns hex. This keeps brand-vs-semantic token separation (see DESIGN tokens in [ARCHITECTURE.md](ARCHITECTURE.md)) and lets theming change without an API change. (The legacy prototype's `reco.color/bg` from client compute is reference only.)

> **Prototype is NOT the implementation.** [`House of Hope Projection.dc.html`] computes everything client-side (`support.js` `calcYears/calcMonthly/scenario`). PRD §13 forbids client math in v1. The prototype is a **layout + field-name reference only**; all math is server-side (§13). No `calc*` function survives into production.

---

## 10. Sample-data fixture spec (golden from day one)

Three named projections drive design, the §8 edge-case math, and the golden/LibreOffice reconciliation. They are committed in `engine/tests/golden/` as `inputs → expected computed_json + recalced .xlsx`, pinned to `model_version = "2.0.0"`.

| Fixture | Inputs (deltas from defaults) | Expected headline | Tests |
|---|---|---|---|
| **House of Hope (canonical, 60% labor)** | shares **6/8/10/11/12%** (Y4/Y5 = the `0.11`/`0.12` decelerating plateau), basket $17.08, **labor 60% (owner default)**, marketing 3.75%, supplies 5%, escalator 3% (compounds through Y5), reserve $25k, `H`=31,798, donation_value $74, 10,000 sqft, 70% salesfloor, NNN, source_of_funds $300k | Y1 rev ≈ **$426,911** (labor-independent, unchanged); **operating** Y1 net **($65,068)** (operating margin **(15.2%)**), **DISPLAYED (cash) Y1 net ($303,568)** (margin **(71.1%)**, operating − the $238,500 startup), payback **N/A**; at **model_version 3.0.0 (Model v3** — the always-on card-fee two-term formula + Workers' comp + POS platform/Production software, §4.2): capital ≈ **$354,597**, cash-gap ≈ **($329,597)** (trough at M7), break-even **month 8**; `reco.tag = raise_cash` (the downside still breaks even at **month 12**, so the binding constraint is capital > the $300k funds); advisory `share_y4`/`share_y5` + `occupancy_ratio_out_of_band` flags fire. (At 2.9.0, pre-Model-v3: capital ≈ $347,854, cash Y1 net ($292,214) — Model v3's always-on lines add +$6,743 capital; pre-6.2 the fixture was `do_not_proceed`, break-even M9, capital ≈ $321,940; the 6.2 flip to raise_cash feeds owner decision #345 and HELD through 6.4/3.0.0.) | happy path; annual==Σmonthly; 5-column three-way golden reconcile; no overrides |
| **House of Hope (design-parity, 40% labor)** | as above but **labor 40%**, source_of_funds $300k | **operating** Y1 net **$28,858** (operating margin ≈ **6.8%**, was ~9.0% at 2.9.0 / ~11% pre-990); **DISPLAYED (cash) Y1 net ($209,642)** (margin **(49.1%)**, operating − the $238,500 startup), **payback Month 34** (was Month 32 at 2.9.0 — Model v3's added cost lines push cash recovery two months later); capital required ≈ **$306,349** (was $302,238 at 2.9.0; pre-990 basis: ~$277,990 prototype); break-even **month 6**; **`reco.tag = raise_cash`** (unchanged — capital still crosses the $300k funds, now by $6,349) — *** OWNER-VISIBLE 6.4 FLIP HOLDS through 3.0.0 ***: Year-1 operating net still positive, margins in band — capital>funds gate, not a health problem; the prototype "Proceed" headline assumed the pre-990, pre-Model-v3 cost basis | **design-QA only** — the labor-driven prototype SHAPE (numbers superseded by 990-grounding, then Model v3) |
| **Aggressive (flagged)** | shares **15/20/25%** (+ Y4/Y5 `0.26`/`0.27`), **labor 40%** (load-bearing — at the 60% default the %-of-revenue cost stack is ~75.25% of revenue so net margin can never exceed ~24.75% and the >30% net-margin guardrail is mathematically UNREACHABLE; 40% is the only labor at which this fixture serves its purpose), source_of_funds $300k | Year-1 **cash** net income **$79,796** (was $94,912 at 2.9.0 — Model v3's added cost lines eat into the surplus), Y1 cash net margin **7.5%** (was ~8.9%); **triggers** the §12.2 net-margin (>30%) guardrail on the **late steady-state years** (Y4 **35.7%** / Y5 **35.9%**, was ~36.9%/~37.0% at 2.9.0 — cash==operating in Y4/Y5, no startup drag) AND the share (>8%) guardrail on Y1/Y4/Y5 (15%/26%/27%, unchanged by Model v3); `requires_note = true`; `reco.tag = revise` (unchanged); capital ≈ **$295,337** (was $292,645 at 2.9.0); break-even **month 3** (unchanged); payback **month 11** (unchanged) | guardrail flags fire; not a math error; 3-way reconcile w/ + w/o a Marketing pin |
| **Grace Mission (loss case)** | shares 4/5/6/7/8%, **8,000 sqft**, rent **$14/sqft low-confidence** (gross), source_of_funds $250k, **one overridden Payroll cell** (`Payroll#1` = $110,000 vs calc ~$134,266) | **Y1 net (cash) ≈ ($270,081)** (margin **(120.7%)**; was ($261,760) at 2.9.0 — Model v3's added cost lines deepen the loss); capital ≈ **$305,789** (was $300,357 at 2.9.0); break-even **month 9** (base; moved one month later from month 8 at 2.9.0) but `reco.tag = do_not_proceed` (unchanged — the DOWNSIDE never breaks even); `simple_payback_years = null` ("N/A — no Year 1 profit"); negatives in parentheses; low-confidence rent badge; still recalcs clean with the override present | N/A sentinels; override + N/A path both recalc clean (w/ + w/o the pin) |

The **60% canonical** House of Hope fixture is the reconciliation target for the resolved defaults (§1); the **40% design-parity** fixture reproduces the prototype headline for design-QA only ([DECISIONS.md](./DECISIONS.md)). The Aggressive case mirrors `house_of_hope.json` (which carries the old 15/25% shares) and is the guardrail fixture. The Grace Mission case is the edge-case fixture that the legacy engine's unguarded `=net/totrev` / `=startup/Y1net` would have failed (§0, lines 257/284).

---

## 11. Excel export contract (PRD §18)

Server-generated via `engine/xlsx.py`, consuming the §9 core output. **No web request may import the Excel builder to obtain numbers.**

### 11.1 Cell-class rules (per §18)

| Cell class | Representation |
|---|---|
| Inputs / assumptions | hard-coded, **blue** (engine `INPUT_FILL` + `BLUE` font; lines 102/108/116) |
| Computed, not overridden | **live formula** |
| **Overridden component** | hard-coded, **orange** fill + comment (exact string §11.2) |
| Totals / net / margin / KPIs | **always formulas** over components (foots even with overrides) |
| **Net income (CASH-based, model 2.7.0)** | the **Year-1** cell is `=B{tr}-B{te}-B{startup_total}` (subtracts the **Total Startup Costs** cell, written in a second pass once the startup block's row is known; Excel forward-references resolve on recalc); Years 2–5 stay `=rev-exp`. **Net margin** stays `=IF(rev=0,"",net/rev)` over that Net income cell — so the displayed margin is the congruent **cash** margin (no second operating margin). |
| Monthly cash flow | its **own tab**, now **60 rows** (the full horizon); Net = `=B-C-D` (revenue − operating expense − scheduled costs) |
| N/A (§12.4) | **blank + comment**, never `#DIV/0!` |

### 11.2 Override comment string (exact)
```
Manual override — calc was =<formula> → $X; set to $Y on <YYYY-MM-DD>
```
Where `<formula>` is the original live formula, `$X` the calculated value, `$Y` the override value. The cell becomes a hard-coded orange value; the enclosing total cell remains `=SUM(...)` over the (now hard-coded) component cells so the sheet foots.

### 11.3 Year-2 share cell
Three blue input cells for share; the Year-2 projection row references **its own input cell**, **not** `=AVERAGE(...)` (kills engine line 209; §4.1).

### 11.4 Total/override consistency (the gate's hardest case)
The server's resolved total and the in-sheet `=SUM(...)` **must derive from the same resolved node values** (§7.3). The overridden component cell holds the resolved override value; the total formula sums over it. This is the case the legacy `build_xlsx` never handled and the one most likely to fail the <$0.50 gate.

### 11.5 Division guards (kill `#DIV/0!`)
Every divided cell uses the guard pattern so LibreOffice recalc never yields `#DIV/0!`:
```
=IF(<denom>=0, "", <num>/<denom>)
```
Applied to: net margin (`=net/totrev`, was line 257), customers (`=retail/basket`), and every per-unit KPI. A `null` from the core renders as a **blank cell + comment** describing the N/A (§8). (The legacy **"Simple payback (years)" cell `=startup/Y1net` is removed** in model 2.7.0 — payback is surfaced only via the `MILESTONES` "Payback" Month-N row, which also drops one guarded division from the recalc gate.)

### 11.6 Tabs
- **`Projection`** — inputs (blue), 5-year P&L (formulas, columns B–F = Year 1–5), startup costs, KPIs, decision metrics, and a **Notes & Disclaimer** block (§11.7).
- **`Monthly Cash Flow`** — the full **60-month** project-month series (`1..N`, model 2.7.0); pre-opening months read as real losses; the cash curve crosses back above zero at `payback_month` for a recovering case.

### 11.7 Notes & Disclaimer block (#192)
The exported `.xlsx` and the Board Packet (`app/packet.py`) both carry a server-owned **"planning estimates, not advice"** disclaimer — the same defensibility caveat the in-app terms gate protects, so it is never stripped from the artifact a board reads detached from the app. The wording is a single source in `engine.model` (`EXPORT_DISCLAIMER`, `AI_NARRATIVE_DISCLOSURE`, `TERMS_VERSION`; `app.terms` re-exports `TERMS_VERSION`):
- **`.xlsx`** — a `NOTES & DISCLAIMER` text block on the `Projection` sheet with the disclaimer + `Terms v{TERMS_VERSION}` (+ acceptance date when known). **Pure text, no formulas** — it adds no recalc-error surface to the three-way golden gate.
- **Packet** — a footer with the same disclaimer + terms version/date; when an AI narrative is present, an **AI-narrative disclosure** ("Narrative drafted with AI assistance; every figure is grounded in the model.") is prepended to the prose. Server-formatted only; no client math.

### 11.8 The annual cascade guarantee (live formulas, pinned by test)

The entire annual `Projection` P&L is a **live spreadsheet**, not a value dump: every blue input cell drives the whole sheet through Excel **formulas**, so a board member who opens the `.xlsx` and edits one assumption sees the P&L recompute. Concretely, **every derived annual cell is a formula** over the blue inputs and over upstream cells, across **all five year columns**:

- the **driver chain**: Donor market share (`=share_yN`), Donating households (`=share×households`), Annual donations (`=hh×donations_per_hh`), Retail Sales (`=donations×donation_value`), Salvage Sales (`=retail×salvage_pct`), Total Revenue (`=retail+salvage`), Customers (`=IF(basket=0,"",retail/basket)`);
- **every non-overridden expense line**: Payroll (`=rev×labor_pct`), Payroll taxes (`=payroll×payroll_tax_pct`), Credit card fees / Marketing / Supplies (`=rev×pct`), Rent (`=occupancy_y1×(1+escalator)^(y-1)`), Utilities (`=building_sqft×utilities_per_sqft`), and the fixed lines (`=input_cell`);
- the **totals and bottom line**: Total Expenses (`=SUM(...)`), Net income (`=rev-exp`, with the Year-1 cell also `-Total Startup Costs`, §11.1), Net margin (`=IF(rev=0,"",net/rev)`), plus **Total Startup Costs** (`=SUM(...)`).

The **only** derived annual cell that is ever a hard-coded value is an **overridden component** (orange, §11.2); even then its enclosing total stays a `=SUM(...)` so the sheet still foots (§11.4). This guarantee is **deliberately out of scope** for the `Monthly Cash Flow` tab and the `MILESTONES` block: the per-month Revenue / Operating-expenses / Scheduled-costs cells are **server VALUE snapshots** (only the monthly Net and Cumulative-cash cells are formulas), and the grand-opening / break-even / payback milestones are **server display-string snapshots** ("Month 6" / "N/A"). Those snapshots are a separate decision; do not assume they are live.

Two tests in `engine/tests/test_xlsx_cascade.py` pin this contract:

- **Audit** (`test_every_derived_annual_cell_is_a_formula`; runs everywhere, no `soffice` needed): asserts every derived annual cell listed above is an openpyxl formula string, never a literal. This is the regression guard so a future change can never silently hard-code a derived annual cell and break the cascade.
- **Cascade** (`soffice`-gated exactly like the golden gate, runs in CI): edits one blue input cell, recalcs the workbook in LibreOffice, and asserts the downstream cells moved to hand-computed expectations. Editing `share_y1` moves Total Revenue, Payroll, Net income and Net margin; editing `basket` moves Customers (its only dependent) while Total Revenue stays put, proving the cascade is precise. The unedited recalc is also asserted to equal the server's resolved values.

---

## 12. Calibration & confidence (PRD §29, §6.3)

The monthly ramp (the S-curve weight vectors in engine/monthly.py), seasonality, peak-shortfall timing, and therefore `break_even_month` have **never been calibrated against a real opening**. They are emitted with `flags.ramp_low_confidence = true`, shown with a confidence label and sensitivity (§6.2), and feed the **calibration backlog** that the post-launch actuals store (PRD §6.3, §24) will close. Treat a confidently-wrong break-even month as a defect, not a feature.

---

## 13. The golden-test gate (PRD §13, §18) — CI-blocking

The gate is the **only** thing that keeps the single-authority claim true once the model grows (marketing, escalator, monthly). It is built in **M1, before any UI depth** ([BUILD_PLAN.md](BUILD_PLAN.md) M1).

### 13.1 Three-way reconciliation
For every fixture, assert all three agree:
1. **Server Python compute** (`engine/compute.py` output).
2. **Stored `computed_json`** (the serialized view-model).
3. **LibreOffice recalc** of the exported `.xlsx` (`recalc.py`, see [`recalc.py`](reference/thrift-store-projections-skill/scripts/recalc.py)).

### 13.2 Tolerances
- Dollar cells: `abs(delta) < $0.50`.
- Percent cells: `abs(delta) < 0.1pp`.
- Formula errors: **zero** (see §13.3).
- Round both sides per §6.5 before comparing.

### 13.3 Formula-error assertion (verbatim from `recalc.py`)
Assert `result["status"] == "success"` **AND** `result["total_errors"] == 0` across the recalc error list: `#VALUE!, #DIV/0!, #REF!, #NAME?, #NULL!, #NUM!, #N/A` (`recalc.py` lines 103–111). **Fail closed:** a runner without `soffice` returns an `{"error": ...}` dict (no `status`); the harness must treat a missing/`error` status as a **failure**, never a pass.

### 13.4 Annual == monthly roll-up
Assert `annual_Y1[line] == sum(monthly[M1..M12][line])` to the penny for every P&L line (§4.2, §5.3).

### 13.5 With AND without overrides
Run the entire gate in **two states**: (a) no overrides; (b) at least one component override **plus** at least one N/A path (the Grace Mission fixture, §10). The legacy `SKILL.md` step-4 recalc only ever covered the no-override happy path — the build process **extends** it to the override and edge-case fixtures.

### 13.6 Mandatory fixtures
`happy path (House of Hope)`, `0-revenue (0% share)`, `Y1 net ≤ 0 (Grace Mission)`, `negative-net`, `overridden-component (Payroll#1)`, `sensitivity downside (−25% donations, −25% rent)`. Each must recalc clean and emit the correct N/A sentinels / flags.

### 13.7 Calibration golden (legacy script)
Freeze the **legacy** annual `generate_projection.py` output for the House of Hope config as a **regression golden** so the v2.0.0 rewrite is provably calibrated against the known-good Longview driver-chain numbers **before** adding monthly/overrides. The legacy script is a calibration reference **only**; it is never the runtime engine (§0).

### 13.8 Environment pinning
LibreOffice / `soffice` version is **pinned in the build image** (the recalced values can shift across versions and undermine the <$0.50 tolerance). The recalc step is sandboxed and time-boxed (it shells out to `soffice`; `recalc.py` already wraps with `timeout`/`gtimeout`, lines 87–91). See [OPS_RUNBOOK.md](OPS_RUNBOOK.md) for the pinned version and the CI image.

### 13.9 DoD tie-in
This gate is a **Tier-1 GATE** item in [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md): no engine/contract PR merges unless `pytest -q` is green, the three-way reconcile passes, and `python recalc.py <xlsx>` reports `total_errors: 0` — with fresh command output in the PR (verification-before-completion).

---

## 14. Performance budget (PRD §27)

`compute()` targets **p95 < 50 ms server compute, excluding research/LLM**. The annual model is trivially within budget; the monthly model (M0–M12 × line items × DAG topo-sort) plus per-keystroke (debounced) override resolution is heavier and must have a **perf test in M1**. Research and narrative are bounded async services and are **never** in the compute hot path; compute must work fully with AI disabled (PRD §21 opt-out) — a test runs the full compute + `.xlsx` flow with all AI keys unset.

---

## 15. Module layout (where the math lives)

```
engine/
  model.py          # constants + MODEL_VERSION / COMPUTE_SCHEMA_VERSION (§2, §3)
  compute.py        # PURE core: compute(...) -> ComputeResult (§9). No openpyxl/docx imports.
  monthly.py        # M0–M12 ramp + cash-flow (§5)
  dag.py            # override resolution, non-pinnable list, stale flags (§7)
  decision.py       # capital, cash gap, break-even, guardrails, recommendation (§6)
  xlsx.py           # consumes compute output -> .xlsx per §11
  packet.py         # consumes compute output -> Board Packet / .docx (§17)
  narrative_facts.py# computed_json -> approved facts for grounded narrative (§17)
  tests/golden/     # fixtures + LibreOffice recalc via recalc.py (§13)
```

The renderers (`xlsx.py`, `packet.py`) **consume** the core's output; they never re-implement math. This is the structural guarantee behind the single-authority claim.

---

## 16. Summary of binding rules

1. One pure compute core; renderers consume it; **no second math surface** (§0, §9, §15).
2. Year-2 share is an **explicit input**; the midpoint is dead (§4.1).
3. Resolved defaults: **labor 60% (owner; canonical golden), basket $17.08, escalator 3% compound** (§1, §2). A 40% design-parity fixture reproduces the Appendix-D headline for design-QA.
4. New cost lines: **Marketing 3.75%**, **Supplies 5% (replaces fixed $3,700)**; reserve buffer **$25k** (§2, §4.2).
5. Monthly-first; **Year-1 annual == Σ monthly** to the penny (§4.2, §5.3, §13.4).
6. Decision metrics computed in the core and **golden-tested**, not just rendered (§6, §13).
7. Override DAG: topological, **no back-solve**, derived/total/KPI/decision nodes **non-pinnable (rejected server-side)** (§7).
8. N/A → explicit `null` + `flags`; negatives in parentheses; **never `#DIV/0!`** (§8, §11.5).
9. Excel: totals always formulas; overridden components orange + exact comment; monthly tab; division guards (§11).
10. Golden gate (server == `computed_json` == LibreOffice recalc; <$0.50 / 0.1pp; zero errors; with/without overrides; fail-closed; pinned `soffice`) is **CI-blocking from M1** (§13).

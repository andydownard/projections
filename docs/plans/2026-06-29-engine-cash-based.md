# Engine: CASH-BASED projections (Year-1 startup hit, congruent net + margin) + Month-N payback

**Epic:** GitHub #321 · **Branch:** `feat/engine-cash-based` · **Status:** implemented (model 2.7.0).
**MONEY / golden-gate change** — the three-way reconcile (server compute == stored
`computed_json` == LibreOffice recalc of the `.xlsx`, `< $0.50` / `< 0.1pp`, zero formula
errors) is CI-blocking and stays green with and without overrides.

## 0. Final owner decision (supersedes all prior amortization / reported_net / operating-margin work)

**The projection is CASH-BASED. No amortization, no capitalization.** Startup is a one-time
CASH outflow that hits when paid (Year 1, at/around opening). Net income and net margin are
BOTH cash-based and therefore **congruent** — no footnote, no second margin. This supersedes
the `feat/engine-startup-income-payback` Phase-1 spec's `reported_net` / operating-margin
split (that branch's MONTHLY-EXTENSION + PAYBACK design is reused; its margin-stays-operating
parts are dropped).

## 1. What changed

| Quantity | Definition | Surface |
|---|---|---|
| **operating_net[y]** (`AnnualYear.net`) | `total_rev − total_exp` | **unchanged** — drives `_recommend` (gates `y1.net≤0`), `simple_payback` (`y1.net>0`), sensitivity (`years[1].net`), and the monthly operating roll-up, so the **verdict is stable** |
| **cash_net[y]** (`engine.compute.cash_net`) | `operating_net[1] − startup_total` for Y1; `operating_net[y]` for Y2–5 | every income display: Net-income row + KPI, `incomeSeries[0]`, `year5Income`, card `y1_net` |
| **cash_margin[y]** (`engine.compute.cash_margin`) | `cash_net[y] / total_rev[y]` | Net-margin row + KPI; the §12.2 `>30%` guardrail |
| **payback_month** | first project-month `cumulativeCash ≥ 0` **after going negative** ("Month N"); `null` ⇒ N/A-with-reason | `milestones.payback`, the Payback-period KPI, the `.xlsx` MILESTONES row, the card |
| **monthly[]** | full **60-month** horizon (`G..G+59`); Year-1 = launch S-curve (byte-identical); Years 2–5 = uniform 1/12; per-year penny-exact roll-up | view-model + `.xlsx` Monthly tab |

**Year-1 boundary (Reg #15, cash basis):** `cash_net[1]` (= `operating_net[1] − startup_total`)
equals the sum of all monthly cash nets over project months `1..G+11` (pre-opening startup
months + the 12 Year-1 operating months), INCLUDING startup outflows — exact when all startup
falls within Year 1 (the default and all primary fixtures).

**Year-1-anchored metrics (byte-unchanged):** capital trough scoped to `m.index ≤ G+11`;
break-even computed over the Year-1 operating window only; first-year cash gap already strict
`G..G+11`. The S-curve front-loads Year-1 losses, so the Year-1 trough is the global minimum
even across 60 months — capital is byte-identical for the `G=1` fixtures.

**.xlsx:** Net income Year-1 cell `=B{tr}-B{te}-B{startup_total}` (second pass once the startup
block's row is known); Years 2–5 stay `=rev-exp`; Net margin stays `=net/rev` over that cell
(so the displayed margin is the congruent cash margin); the "Simple payback (years)" cell is
removed (payback rides the MILESTONES Month-N row).

## 2. Versions
`MODEL_VERSION 2.6.0 → 2.7.0` · `COMPUTE_SCHEMA_VERSION 1.5.0 → 1.6.0`.

## 3. Golden before/after (regenerated in this change)

| Fixture | Y1 Net income (was → now) | Payback (was → now) | Verdict | monthly[] |
|---|---|---|---|---|
| design-parity 40% | `+$47,359` → **`($191,141)`** | N/A → **Month 30** | **proceed** (unchanged) | 12 → 60 |
| canonical 60% | `($44,433)` → **`($282,933)`** | N/A → **N/A** (stays) | **do_not_proceed** (unchanged) | 12 → 60 |

Capital unchanged (canonical `$321,940`; design-parity `~$279k`). Reco/verdict did NOT change.

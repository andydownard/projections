# Owner deliverables — McKinsey panel + massive refactor (2026-07-03)

## 1. Your TODO list (things only you can do)

Priority-ordered; each has a GitHub issue where noted.

1. **Confirm the insurance re-default with a real quote** (P1). The panel repriced "Insurance liability" $2,000 → $10,000/yr as a placeholder (org-wide 990 evidence says $2k is 5–10× low for staffed 10k-sqft public retail: BOP + GL + nonprofit D&O). Get one real quote for a ~10,000 sqft thrift store in your target market and set the default from it. The constant is now per-projection editable, so this only affects new projections' starting point.
2. **Decide the recommendation-gate rebalance** (#345, P1). Today the joint downside (rent +25% AND donations −25%) is a hard "do not proceed" veto — the DEFAULT projection opens on Do-not-proceed. Options the panel framed: keep as robustness display + map base-pass/downside-fail to "revise" with explicit wording, or keep the veto. Needs a DECISIONS.md entry; engine change is ticketed and waiting on you.
3. **Decide labor-input UX + default** (#355, P2 but decision-loaded). 60% labor mathematically cannot break even annually (break-even revenue $606k vs $427k modeled). The ICP has volunteer labor a single % can't express. Panel proposes a staffing mini-model (paid FTEs × local wage + volunteer hours) or a volunteer-offset %.
4. **Run the M-1 operator calibration** (#220 commented, P1). 3+ operating first-store thrifts: donations/hh/yr, $/donation, real opening capex (is a $100k consultant real?), ramp shape. This is the only way to calibrate the demand chain — 990s cannot see it.
5. **Cost-completeness decision** (#346, P1): explicit lines vs a contingency % for workers comp/SUTA-FUTA (true payroll burden ~10–12% vs our 8%), POS/software, bank/payroll-processing fees, accounting, donation-pickup vehicle.
6. **Terms-acceptance legal wording** (#358, P1). Generate currently rubber-stamps termsAccepted=true silently. The disclaimer now renders (fixed in the branch), but an explicit acceptance affordance needs your legal wording call.
7. **Marketing taper decision** (#347, P2): keep 3.75% flat or taper to ~1–1.5% by Y3 (mature affiliates ride the Goodwill brand; you can't).
8. **Expert-review funnel** (#359, P1): price point + CTA copy for the conversion loop (backend exists, zero frontend affordance).
9. **Ops** (#368): provision LITESTREAM_* in the deployed container and run the live-R2 restore drill (only proven on a file replica).

## 2. Constants validation — six Goodwill 990s (all filed 2024–25, FY2023–24)

Orgs: Wayne & Holmes OH (EIN 34-1272032), NE Pennsylvania (24-0800938), Sandusky OH (34-1113714), Central East Texas/Lufkin (75-2204594), SW Oklahoma & N Texas (73-0675119), Lubbock TX (75-1245440).

| Constant | Our default | Observed (6 orgs) | Verdict | Action |
|---|---|---|---|---|
| Labor % of revenue | 60% | 47.9–71.1% org-wide | plausible, keep | staffing UX ticket #355 |
| Payroll tax % | 7.5% | 7.85–9.34% (all above ours) | **contradicted** | **raised to 8.0% in branch** (workers comp still excluded → #346) |
| Supplies % | 5.0% | 4.3–6.3% | validated | keep |
| Marketing % | 3.75% | 0–1.1% at mature affiliates | launch-premium plausible | taper decision #347 |
| Card fees % | 2.0% | 2.13–2.22% (clean obs.) | validated | keep |
| Salvage % of retail | 0.8% | 8.4% at one mature op | conservative, keep | upside note #356 |
| Occupancy ≤20% guardrail | flag was silent | 3.3–17.3% observed | band well-placed | **flag implemented in branch** |
| Net-margin >30% flag | flag | −7.1% to +4.4% observed | emphatically validated | keep |
| Insurance $2k/yr | $2,000 | org-wide $398–609k (multi-store) | **5–10× low** | **$10k placeholder in branch; you confirm quote** |
| Rent $12/sqft, escalator, utilities $2.23 | — | not observable in 990s | low confidence | M3 research + EIA benchmark idea |
| Demand chain (3/hh/yr, $74, $17.08, 6/8/10%) | — | not observable | Lufkin ~$411k/store ≈ our $427k (within 4%) | M-1 calibration |

Caveat the panel flagged for board conversations: GAAP donated-goods recognition inflates reported 990 revenue ~25–35% vs our cash-basis model (#353 adds this note to the evidence panel).

## 3. Enhancement brainstorm (partner 2 — all within $20/month; most are $0)

**Recommended bundle (all $0/mo except one):**
1. **990 NTEE-P29 thrift-shop cohort priors pipeline** (P0/L, $0) — ProPublica API + IRS bulk XML; grounds the whole cost structure in a real cohort, not 6 hand-read filings.
2. **Census MRTS seasonality (NAICS 4533)** (P0/S, $0) — real monthly seasonal factors for used-merchandise stores; wires the dead seasonality field and makes break-even sensitive to opening month.
3. **State payroll-burden table** (P0/S, $0) — new-employer SUTA + FUTA + workers-comp class 8017 by state → true burden 8.5–12%.
4. **CPI vintage-stamping** (P0/S, $0) — the $74/donation seed is 2013 dollars (~$105 in 2026) paired with 2026 rents; stamp vintages, deflate coherently at next model bump.
5. **Insurance BOP benchmark re-default** (P0/S, $0) — encode published retail BOP premiums as $/sqft.
6. **990 young-org revenue time series** (P1/M, $0) — first 3–5 filed years of recently-ruled thrift orgs → empirical Y1→Y3 ramp to calibrate 6/8/10% and the S-curve.
7. **BLS OES wage-based staffing mini-model** (P1/M, $0) — pairs with your #355 decision.
8. **Census CBP competitor density** (P1/S, $0) — thrift stores per 10k households as a confidence adjuster (respects the §9 fence: confidence only, not point-estimate scaling).
9. **EIA utilities $/sqft by state** (P1/S, $0).
10. **User-actuals calibration loop** (P1/M, $0) — opt-in anonymized pooling on the M7 actuals schema; hierarchical priors. The only compounding one.
11. **Triangulation ensemble + agreement badge** (P1/M, $0) — three independent Y1 revenue estimates (household chain, sales/sqft × cohort, donation-supply ceiling); disagreement = honest low confidence.
12. **Cheap-LLM batch enrichment of 990-EZ image filings** (P2/M, ~$0–3/mo) — the only spend; extends the cohort to the smallest orgs (truest ICP comparables).
13. **Monthly recalibration cron → PR with evidence-stamped constant proposals** (P2/M, $0) — keeps priors fresh; constants change only via model_version bump + human merge.

Also generated (P2/P3): rent-comp hardening via EDC listings + user-pasted listing URLs + HUD FMR sanity band; IRS SOI noncash-deduction tables → donations/hh triangulation; SMART salvage price table; state sales-tax registries → survival base rates.

**Total ongoing cost of the recommended bundle: ~$0–3/month.** All respect server-authoritative compute + citation-validated research.

## 4. What shipped in the branch (filled at ship time)
(placeholder — filled from the ledger at PR time)

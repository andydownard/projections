# Massive Refactor — Session Handoff (2026-07-04)

**Branch:** `refactor/params-gaps-simplify-2026-07` (backend worktree `.claude/worktrees/massive-refactor`, base `55e0997`, 40 commits)
**Stacked FE branch:** `refactor/params-fe` (worktree `.claude/worktrees/massive-refactor-fe`) — already merged into the main branch twice; keep for any remaining FE slices, then delete.
**Authoritative recovery map:** `.superpowers/sdd/progress.md` (the SDD ledger — trust it + `git log` over memory after any compaction). Task briefs live in the scratchpad at `.../scratchpad/briefs/task-*.md`; the plan is `docs/plans/2026-07-03-massive-refactor.md`.

## How to resume
Read `.superpowers/sdd/progress.md` top-to-bottom, then continue the **REVISED REMAINING QUEUE** near its end. One implementer per task/batch (own git commits), a review after each, a final whole-branch review before PR. **Model policy (owner, escalating through the session): everything now runs on Opus — implementers AND reviews AND the final whole-branch review** (Fable + Sonnet limits were hit). Every dispatch MUST carry the workspace guard (pwd + branch check) — an early implementer committed to the wrong checkout once; recovered via cherry-pick.

## Verify commands (proof set)
```
# backend worktree:
/Users/andydownard/projects/projections/.venv/bin/python -m pytest -q            # (worktree has no venv; use the main checkout's)
/Users/andydownard/projects/projections/.venv/bin/python scripts/regen_goldens.py --check   # goldens byte-stable
python -m pytest engine/tests/test_golden_gate.py -q                             # soffice at /opt/homebrew/bin/soffice
python scripts/ratio.py                                                          # test:code > 1.3
cd web && npm test -- --run --no-file-parallelism && npm run typecheck           # eslint binary MISSING in both worktrees — install before lint gate
```
Last green on merged tree (HEAD 4df2b2c): pytest exit 0 · 777 web tests · typecheck clean · ratio 3.06.

## DONE & reviewed (all approved, findings fixed)
- **Wave 0** — docs-drift fix, dead-code deletion, `scripts/regen_goldens.py` (byte-identity net, drift-proven), shared `app/tests/conftest.py`, `app/routers/common.py` helper extraction (penny client_ip kept local deliberately).
- **Wave 1** — `SENSITIVITY_DELTA` wired + exposed; view-model gains `sensitivity{base,downside,upside,delta}` + `confidence{ramp}` + 5 settings keys (**COMPUTE_SCHEMA_VERSION 1.5.0→1.6.0, MODEL_VERSION stays 2.6.0**); `reserve_buffer`/`sensitivity_delta`/`fixed_annual` API-exposed with bounds; PATCH re-validation; xlsx fixed-annual lock; ENGINE_CONTRACT/API_SPEC/DATA_MODEL updated; **1.3g** = numeric→str coercion so the deployed numeric PATCH contract + stored-float rows keep working (a Critical the 3.1 review caught by execution).
- **Wave 2 (wizard)** — `AdvancedOptions` disclosure + `paramGroups.ts` taxonomy; advanced sections on all steps (space/donation/rent/cost/funding groups); visible Source-of-funds; Generate error state + disclaimer; payload mappers send every advanced assumption; localStorage draft persistence + resume (StrictMode-safe, merge-over-defaults). Integration-proven: default wizard body → 201, settings echo engine-equal.
- **Wave 3** — grouped SettingsTab mirroring the wizard (every 1.6.0 param editable); **duplicate endpoint + real 409 recovery** (Overwrite replays the failed body, Save-as-copy forks with the pending edit — both Criticals from review fixed in 3.2f); sensitivity on the RoleView banner + packet; penny Y4/Y5 diff fix; WCAG-AA contrast (9 pairs ≥4.5 + CI gate); clipboard honesty; unified dates; list RecoChip; **CostScheduleEditor null-safety (root-caused the parallel-test flake)**.

## IN FLIGHT at handoff
- **Batch 1** (opus, agent `ab3f1ff54a0231a26`, backend worktree): 3 commits — (a) conflict-recovery hardening [busy-guard against double-copy, SettingsTab banner overwrite clear-on-success, reload hygiene, second-409 restash, MetricBar sensitivity line on owner detail page]; (b) NaN-500 one-liner in `_require_fraction`/`_require_min`; (c) **Task 4.2** rate-limit quad completion. When it lands: review it (opus), then continue the queue.

## REMAINING QUEUE (all opus)
1. **Batch 2** — Task 4.3 freeze `aggressive_flagged.json` + `grace_mission_loss.json` goldens (3-way, with/without overrides; packet §12.2 note travels) + Task 4.4 hypothesis property tests (annual==Σmonthly, capital no-double-count, escalator, {raw,display}, breakeven≥G).
2. **Batch 3** — Task 4.5 app/ coverage gate + pydantic ConfigDict migration + conflict-recovery e2e; investigate the two tracked flakes (web parallel cross-file pollution — mostly fixed by CostScheduleEditor null-safety; `test_store_robustness` id()-reuse race).
3. **Wave 6 engine (2.7.0)** — **the McKinsey heart, needs owner-visible care:** 6.1 pin-defeats-stress fix; 6.2 monthly fixed/variable/payroll split (canonical capital ~$317k→$342k, break-even 9→8 — expected golden change); 6.3 occupancy/labor/sales-per-sqft advisory flags; 6.4 990-grounded constants (payroll tax 0.075→0.08, insurance $2k→$10k placeholder, DEFAULT_DONATION_VALUE="74", NNN contract resolution) + MODEL_VERSION 2.7.0 + single golden regen. **6.4 MUST ALSO update the FE wizard defaults** (`DEFAULT_DRAFT.payrollTaxPct 7.5→8`, `fixedAnnual Insurance 2000→10000`) **and** `shareHelper.test.ts` `ENGINE_DEFAULTS` + byte-pins — the FE anchor is hand-transcribed and CI-invisible to drift (grep `0.075|payrollTaxPct` web/src). See the 6.x task briefs.
4. **Ship** — opus whole-branch review; full proof set; file 3 Wave-5 deferral tickets (projections.py split / ProjectionDetail hooks / PennyDrawer split); PR to `integrate/redesign-v2` with wave summary + golden-diff note + quad matrix + wizard/detail screenshots at 1440/768/375.

## Deliverables already produced (this session)
- **28 GitHub tickets #343–#370** on Projections Roadmap board #5 (priority field set); 7 duplicates commented on existing issues.
- **`docs/2026-07-03-owner-deliverables.md`** — your 9-item manual TODO list, the six-990 constants-validation table, and the ranked $0–3/mo enhancement bundle (990 cohort priors, Census MRTS seasonality, BLS OES staffing model, CPI vintage-stamping, user-actuals calibration loop, triangulation ensemble). **Read this first when you return.**

## Owner decisions still pending (block Wave 6 finalization / M-1)
Insurance quote confirmation; recommendation-gate rebalance (#345 — default projection opens "Do not proceed" via the joint-downside veto); labor-input UX + default (#355); M-1 operator calibration (#220); cost-completeness explicit-lines-vs-contingency (#346); terms-acceptance legal wording (#358); marketing taper (#347); expert-review price/CTA (#359). The RecoChip restore on the list (#3.5-FE) reversed an explicit v2 removal — wants owner eyes.

## Known minor-ledger (deferred, ~46 items in progress.md) — triage at whole-branch review
Highlights: torn-write window on narrative bump-vs-upsert; `_raise_version_conflict` docstring overclaim; 8 more files with inline brand hex; several doc-example staleness (DATA_MODEL §4.5 `fixed` key, API_SPEC number-pct examples). None block; all recorded with file:line in the ledger.

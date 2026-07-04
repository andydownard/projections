# Massive Refactor — Session Handoff (2026-07-04)

> **FINAL STATE: SHIPPED — PR #379 open → `integrate/redesign-v2`** (2026-07-04 afternoon). Whole-branch fable review verdict SHIP; fix-now list landed (8dab589/38b1e99/3b12dcf/b891a41); proof set orchestrator-verified at b891a41 (pytest 1877 · gate 12/12 · --check 0 · ratio 3.200 · web 787 + typecheck). Tickets #371–#378 filed. **Stopped at PR-open — merge/deploy is the owner's call.** Owner must read the PR's "Owner-visible changes" section (BOTH reco flips + 2.7.0 constants). Everything below is the historical resume record.

**Branch:** `refactor/params-gaps-simplify-2026-07` (backend worktree `.claude/worktrees/massive-refactor`, base `55e0997`).
**Stacked FE branch:** `refactor/params-fe` — fully merged; no FE slices remain (Wave-6 FE work lands on the main refactor branch directly). Delete the `massive-refactor-fe` worktree at ship.
**Authoritative recovery map:** `.superpowers/sdd/progress.md` (current through Wave 6B close + 6C dispatch). Task briefs + ALL implementer/review reports: `/private/tmp/claude-501/-Users-andydownard-projects-projections/cc5a008c-e385-4859-b8c3-35c3e0ca3bae/scratchpad/briefs/`. Plan: `docs/plans/2026-07-03-massive-refactor.md`.

## Model policy (owner, 2026-07-04 midday — supersedes the earlier "everything opus")
Reviews (per-batch AND whole-branch) on **Fable**; implementers right-sized (**opus** = engine math, **sonnet** = infra/mechanical); **≤2 agents in flight** (rate-limit throttle); implementers serialized in the shared worktree, reviewers overlapped from their own PINNED worktrees (`git worktree add <scratch> <sha>`, remove after). Every dispatch carries the workspace guard (pwd + branch check).

## State at wrap-up (12:05 MT)

**DONE + fable-REVIEWED (all findings resolved or routed):**
- **Batch 1** (`e53ac03`/`1b482cf`/`d3fcd1a`) — conflict-recovery hardening, NaN-422, Task 4.2 rate-limit quad. Review: Approved-with-followups; F1 Infinity-brick fixed in Batch 3; adjudications: OVERWRITE-test change upheld; cap placement kept (SECURITY.md sentence fixed).
- **Batch 2** (`a972377`/`c4d45a3`) — aggressive+grace goldens frozen (3-way w/ + w/o overrides, §12.2 note travels via new packet guardrails section); 6 hypothesis properties. 40%-labor deviation RATIFIED (60% caps margin at 24.75%). Property tests found the lease-deposit {raw,display} bug → fixed in 6C commit 1.
- **Batch 3** (`1dd7624`/`42bb4e8`/`bd01cc4`) — F1 Infinity fix + `dumps_finite` class-kill; coverage gate binding in CI (93.44% vs fail_under=90); 12 ConfigDict migrations; conflict-recovery e2e (9/9); both flakes killed (id()-reuse root-caused = GC address recycling).
- **Wave 6A** (`a4a83b9`/`4f8edd8`) — 6.1 pin-defeats-stress; 6.2 monthly fixed/variable/payroll split. Canonical: trough −$317,403 @M7, capital $342,403, break-even 8 (reviewer re-derived to the cent). **OWNER-VISIBLE: canonical reco FLIPPED do_not_proceed → raise_cash** (downside now breaks even @M11; rules-as-written, no threshold touched; do_not_proceed coverage re-homed onto grace; independently adjudicated + UPHELD by fable review; feeds owner decision #345). See `briefs/task-6.1-6.2-report.md` "OWNER-VISIBLE" section + `briefs/wave6a-review.md`.
- **Wave 6B** (`54d929c`/`d14dbdf`/`711044d`/`8b4c181`) — 6.3 advisory flags (occupancy/labor/sales-per-sqft, override-aware) + break-even-revenue ≥1 guard (was emitting nonsense negatives); I2 packet fix (guardrails iterate vm.flags — unmapped requires_note can't silently drop); classification-sync tripwire (proven non-vacuous by mutation); override-conflict e2e repaired (3 masked tests unmasked). Review: Approved; its 1 Important (pinned-override flag test) + §6.2 doc line were routed into 6C by addendum.

**Wave 6C — COMPLETE (12:5x MT), tree FULLY GREEN, fable review still pending (first action at resume):** `bae77c4` (money_view single-sourced — raw+display from one Decimal, ZERO golden drift; lease deposit exact; property-4 xfails now permanent guards; 6.3 override-awareness pinned) + `5ce411f` (MODEL_VERSION **2.7.0**: payroll tax 8%, Insurance $10k, DEFAULT_DONATION_VALUE 74, NNN resolved conservative, new `nnn_gross_check` golden, single regen of all 5 goldens, landmines L1/L2/L3 all re-pinned; **canonical reco HELD raise_cash** — L3 not triggered) + `5861a6c` (FE defaults track engine — payrollTaxPct 8, Insurance $10k; wizard $50 donation default deliberately kept per Owner Decision 4 vs engine 74 — reviewer should confirm that divergence is documented intent; full docs pass incl. I-3/I1, API_SPEC /duplicate, AGENTS.md re-pin). Verify: **1867 passed / 0 failed / 0 xfailed · gate 12/12 (incl. nnn w/+w/o overrides) · --check 0 · ratio 3.174 · web 785 + typecheck clean.** Report: `briefs/task-6.4-report.md` (pre-6.2→post-6.2→post-6.4 headline table).
**⚠ SECOND OWNER-VISIBLE FLIP (from 6C):** the 40% design-parity twin (and E2E seed) flipped **proceed→raise_cash** — 990-grounded capital $302,238 crosses its $300k funds by $2,238 (Y1 net still +$38,505; it's the capital>funds gate, not store health). Re-pinned to truth, not massaged. Owner lever: raise the demo's `source_of_funds` above ~$303k if the demo should read "proceed". Must appear in the PR's owner-visible list next to the canonical flip.

## How to resume (1:40pm MT)
1. `git -C .claude/worktrees/massive-refactor log --oneline -12` + check `briefs/task-6.4-report.md`.
   - **6C finished** (3 commits + report): proceed to step 2.
   - **6C incomplete/dead** (>30 min no new commit AND no report): inspect working tree; complete the remainder yourself or re-dispatch ONE opus agent with the 6C dispatch scope minus whatever landed (the dispatch text is reconstructable from this doc's IN-FLIGHT paragraph; do NOT re-do commit 1).
2. **Fable review of 6C** (pinned worktree at its head; base `8b4c181`). Special attention: regen diff sanity (numbers changed ONLY for the documented reasons), L1/L2 re-pins not loosened, L3 (did the canonical reco survive as raise_cash? if it moved again, that's owner-visible), FE anchor byte-pins really match engine defaults, NNN golden asserts the brief's exact numbers, ENGINE_CONTRACT §1-vs-§10 no longer self-contradicts.
3. **Ship phase** (task #5): fable WHOLE-BRANCH review (base `55e0997`, ~60 commits) + triage the minor ledger (m1–m66 in progress.md; most are wontfix/ticket) → fix slice if needed → full proof set (pytest, golden gate w/ soffice, --check, ratio, web test+typecheck; **NO `npm run lint`** — eslint was never installed/configured, known drift m55, note it in the PR) → file 3 Wave-5 deferral tickets (projections.py split / ProjectionDetail hooks / PennyDrawer split) + a 4th: eslint add-or-remove (m55) → PR to `integrate/redesign-v2` with wave summary, golden-diff note, quad matrix, the OWNER-VISIBLE reco-flip section, owner-decision list (#345 linkage prominent), screenshots wizard+detail at 1440/768/375. **Stop at PR-open — merge/deploy is the owner's call.**

## Verify commands (proof set)
```
/Users/andydownard/projects/projections/.venv/bin/python -m pytest -q                    # from worktree root; expect 0 failed 0 xfailed after 6C
/Users/andydownard/projects/projections/.venv/bin/python -m pytest engine/tests/test_golden_gate.py -q   # soffice at /opt/homebrew/bin/soffice
/Users/andydownard/projects/projections/.venv/bin/python scripts/regen_goldens.py --check
/Users/andydownard/projects/projections/.venv/bin/python scripts/ratio.py
cd web && npm test -- --run && npm run typecheck                                          # lint DOES NOT EXIST (m55)
```

## Owner-visible items for the PR (do not bury)
1. **Canonical reco flip** do_not_proceed → raise_cash (6.2 monthly split; upheld by independent fable adjudication; #345 gate-rebalance linkage). Post-6.4 headline numbers: take from `briefs/task-6.4-report.md` table.
2. **2.7.0 constants**: payroll tax 8%, insurance $10k placeholder (owner quote still pending — #341-ish, see owner-decisions list), donation value $74, NNN conservative reading.
3. Aggressive fixture runs labor 40% (only way the §12.2 guardrail can fire; ratified).
4. `npm run lint` never worked (no eslint dep/config ever; CI never ran it) — ticket filed at ship.
5. RecoChip list restore reversed an explicit v2 removal (pre-existing note, still wants owner eyes).
6. Owner decisions still pending (block M-1, not this PR): insurance quote; #345; #355 labor UX; #220 M-1 calibration; #346; #358 terms wording; #347 marketing taper; #359 pricing.

## Deliverables already produced (unchanged)
28 GitHub tickets #343–#370 on board #5; `docs/2026-07-03-owner-deliverables.md` (owner TODO list, six-990 constants table, enhancement bundle).

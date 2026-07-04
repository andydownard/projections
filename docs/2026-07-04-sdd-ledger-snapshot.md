# SDD progress ledger — docs/plans/2026-07-03-massive-refactor.md
# Worktree: .claude/worktrees/massive-refactor · branch refactor/params-gaps-simplify-2026-07 · base 55e0997
# Model policy: implementers haiku/sonnet/opus per plan; ALL reviews on fable (owner instruction 2026-07-03)
# Briefs: /private/tmp/claude-501/-Users-andydownard-projects-projections/cc5a008c-e385-4859-b8c3-35c3e0ca3bae/scratchpad/briefs/task-N-brief.md

Plan committed: 29efb90
Baseline: pytest pending (bg brmayuj8n); npm install done.

## Tasks
(append `Task N: complete (commits X..Y, review clean)` lines below)
Task 0.1: implemented (95cb28b) — review pending
Task 0.2: implemented (df66666) — review pending
INCIDENT: implementer A committed to main checkout's integrate/redesign-v2; recovered via cherry-pick + reset to 55e0997. ALL future dispatches must carry the pwd/branch guard.
Task 0.1: review NEEDS-FIX (Important: DEFINITION_OF_DONE.md:23-24 stale commands not replaced) — fix queued behind implementer B
Task 0.2: complete (df66666, review clean)
MINOR LEDGER (final-review triage): (m1) NumberField.tsx:170 emits orphaned number-field__input--left class (only rule lived in deleted block; no rendered regression) — add rule or delete ternary branch; (m2) reference/PANEL_REVIEW.md:79 mentions deleted app/schemas (historical doc); (m3) implementer report cited pre-cherry-pick SHAs.
Task 0.1: complete (95cb28b + DoD fix commit, review fix applied + verified by orchestrator/fable)
Task 0.3: implemented (3dd70fa) — review pending
Task 0.4: implemented (2d68e8c) — review pending
Task 0.3: complete (3dd70fa, review clean — drift-detection adversarially verified)
Task 0.4: complete (2d68e8c, review clean — all 3 scope deviations judged justified)
MINOR LEDGER +: (m4) regen_goldens.py:12-15 docstring overclaims frozen-test serialization (enforced property is stronger); (m5) test_regen_goldens.py:47 unused capsys; (m6) engine/tests/conftest.py:66-73 fixture bodies duplicate build_* (defensible); (m7) app/tests/conftest.py overrides are top-level-key-only (documented).
Task 0.5: implemented (e995b8e, DONE_WITH_CONCERNS: penny client_ip variant deliberately left local) — review pending
Task 1.1: implemented (5fb204e, goldens byte-identical proven via --check) — review pending
Task 0.5: complete (e995b8e, review Approved — all 4 kept-local decisions adjudicated correct)
WAVE 0 COMPLETE.
MINOR LEDGER +: (m8) penny.py:145 XFF expression now duplicated (needs behavior-permitting convergence w/ None-vs-unknown bucket decision); (m9) penny _load_json near-duplicates jsonutil.loads_obj + projections.py:598,962 inline unguarded json.loads (pre-existing); (m10) test_router_common.py:150 tautological tzinfo assertion.
Task 1.1: complete (5fb204e, review Approved — byte-identity + Decimal repro verified independently)
NOTE for 1.3: reviewer requires sensitivity_delta boundary validation at API exposure (already in 1.3 brief: [0, 0.9]).
NOTE for wave boundary: run soffice golden gate (test_golden_gate.py) — not run at task granularity.
MINOR LEDGER +: (m11) up_mult/down_mult naming mildly confusing (commented); (m12) ENGINE_CONTRACT fold-in of sensitivity_delta must land with 1.5 docs task.
Task 1.2: implemented (6da6294, schema 1.6.0, goldens additive-only, soffice gate GREEN) — review pending
NOTE: soffice available at /opt/homebrew/bin/soffice — golden gate runnable locally at wave boundaries.
Task 1.2: complete (6da6294, review Approved — additive-only + soffice gate green verified independently)
CARRY-FORWARD: DOCS-CODE — API_SPEC.md:590 schema version + DATA_MODEL changelog must land in task 1.5 (same PR) incl. sensitivity/confidence/settings additions.
MINOR LEDGER +: (m13) viewmodel confidence "high" branch unreachable/invented; (m14) sensitivity_delta float computed twice; (m15) three-pair tuple comprehension pins shape (intentional).
PARALLEL TRACKS (owner away, 'plan build ship' authorization): backend tasks continue in THIS worktree; frontend Wave-2 tasks run in .claude/worktrees/massive-refactor-fe on stacked branch refactor/params-fe (from 6da6294), merged back at wave boundaries. web/ and app/+engine/ trees are disjoint so merges are trivial.
Task 2.1: dispatched in FE worktree — in flight
Task 1.3: in flight (backend worktree)
Task 2.1: implemented (0376d90 on refactor/params-fe, 667 web green) — review pending. NOTE: eslint binary missing in FE worktree; lint runs at final verify.
Task 1.3: implemented (1bbabe4, 1453 app + 245 engine green, --check clean) — review pending
LESSON: task 1.2 left app-side version assertions red (engine-only verify); ALL backend tasks now verify full `pytest -q`, not per-tree.
CARRY-FORWARD to 1.5: document `invalid_assumptions` 422 error code in API_SPEC.
Task 2.1: complete (0376d90, review Approved)
RIDE-ALONG for next FE task: (r1) AdvancedOptions badge → Children.toArray(children).length hardening + consumer contract = flat mapped-array children; (r2) pluralize "1 setting"; (r3) keyboard tests add toHaveBeenCalledTimes(1).
FE WORKTREE FIX at wave boundary: npm install in massive-refactor-fe/web (eslint binary missing from copied node_modules).
Task 1.3: complete (1bbabe4, review Approved; 3 Important follow-ups queued)
QUEUED FIX SLICE 1.3f (after 1.4, before 3.1): (f1) Penny int-normalize reserve_buffer (settings echo string-vs-int) + test; (f2) fixed_annual PATCH must ACCUMULATE over stored map (deep-merge in _merge_patch) + two-PATCH pin test + docstring fix — REQUIRED by 3.1's single-line PATCH design; (f3) ge=0 bounds on donations_per_hh/basket/utilities_per_sqft.
CARRY-FORWARD to 1.5: API_SPEC three new fields + bounds + invalid_assumptions code + changelog note re dirty-legacy-value 422 cliff.
MINOR LEDGER +: (m16) PATCH lacks rate limit (planned 4.2); (m17) donationsPerHh same string-typing latent pattern.
Tasks 2.2/2.3/2.4: implemented (9be1e4a, 12e3c67, 6341bb9 on refactor/params-fe; 690 web green; advancedOpen now keyed `${step}:${groupId}` via advancedKey helper) — review pending
Task 1.4: implemented (4a6358a, test-only lock: fixed-annual already wired; reserve/sensitivity absent from sheet by design) — review pending
TICKET AT SHIP: xlsx capital-required line (honest formula over monthly cumulative cash exists; sensitivity cannot be a cell formula) — board reading workbook standalone misses the capital ask.
Task 1.4: complete (4a6358a, review Approved-with-deviation; PATCH→xlsx blue-cell path proven end-to-end)
MINOR LEDGER +: (m18) test_xlsx.py:574 loose rgb endswith assertion (cosmetic).
Tasks 2.2/2.3/2.4: complete (9be1e4a/12e3c67/6341bb9, review Approved; brief's provenance-label parenthetical was self-contradictory — implementer followed primary instruction, correct)
FAST-FOLLOW folded into 2.6 dispatch: (I1) AdvancedOptions.tsx:34 Children.toArray(children).length + gross-lease badge test; plus r2 pluralization + r3 toHaveBeenCalledTimes(1).
MINOR LEDGER +: (m19) advancedOpen key typing loose (template-literal type suggestion); (m20) four non-null taxonomy lookups in StepStartupCosts:155-158; (m21) $/sqft vs $/sq ft unit-string inconsistency; (m22) .source-of-funds>legend rule conflicts with wizard-step__section-label class on same element; (m23) SettingsTab must special-case the non-disclosure 'timing' group (note for 3.1).
NOTE: FeedbackModal.test.tsx showed a parallel-load flake during concurrent 2.5 work — watch it at wave boundary.
Task 2.5: implemented (8c560a6, 698 web green) — review pending
Task 2.5: complete (8c560a6, review Approved; FeedbackModal flake did not reproduce solo — full-suite contention only)
FOLDED into running 2.6 agent: 2xx-missing-slug test, 2xx-malformed-JSON test, busy guard at top of onGenerate.
MINOR LEDGER +: (m24) generateError not cleared on step navigation (alert persists on Back); (m25) success-path tail inside try (localStorage quota edge → duplicate-create on retry); (m26) role=alert wraps Retry button (SR verbosity).
Tasks 1.3f/1.5: implemented (4adcccc fix slice, 1ad32a1 docs) — review pending. WAVE 1 CODE-COMPLETE.
Tasks 1.3f/1.5: complete (4adcccc + 1ad32a1 + orchestrator fix commit for the 2 Important findings: donations_per_hh int-normalize RED->GREEN, ENGINE_CONTRACT header 1.6.0 + stale build-spec status line). WAVE 1 CLOSED.
MINOR LEDGER +: (m27) _as_int truncates non-whole floats silently (40000.7->40000); (m28) create-path 422 uses FastAPI default shape not invalid_assumptions (docs scope it to PATCH correctly); (m29) ENGINE_CONTRACT §2 pseudo-block shows unquoted 0.25; (m30) DATA_MODEL §4.5 stale assumptions_json example (fixed map key, labor 0.40 note) + API_SPEC §4.4 example shows number pcts — follow-up doc pass.
Task 2.6 (+fast-follows): implemented (0f1826d badge, 4c7a7ae mappers+persistence, d23d958 busy-guard+tests; 722 web green, ratio 3.019) — review pending. WAVE 2 CODE-COMPLETE on refactor/params-fe.
MERGE QUEUED: refactor/params-fe -> refactor/params-gaps-simplify-2026-07 after 3.2 commits (backend worktree busy).
Task 3.1: dispatched (FE worktree) — in flight
CROSS-WAVE PIN for 6.4 dispatch: raising PAYROLL_TAX default to 0.08 + insurance to 10000 MUST also update web wizard draft defaults (payrollTaxPct 7.5->8, fixedAnnual Insurance 2000->10000) + the 2.6 anchor test + SettingsTab tests if they pin defaults — otherwise wizard sends stale defaults that differ from engine defaults (anchor break).
Task 2.6: complete (0f1826d/4c7a7ae/d23d958 + orchestrator fix 1d10e7c for the 2 Important findings: StrictMode-safe identity guard, resume merges over DEFAULT_DRAFT; RED->GREEN, 724 web tests). WAVE 2 CLOSED on refactor/params-fe.
6.4 BRIEF ADDENDUM (confirmed by 2.6 review): must update DEFAULT_DRAFT.payrollTaxPct 7.5->8 + fixedAnnual Insurance 2000->10000 + shareHelper.test.ts ENGINE_DEFAULTS + byte-pins; grep '0.075|payrollTaxPct' web/src. FE anchor is hand-transcribed — CI-invisible drift class.
MINOR LEDGER +: (m31) useRef args evaluated every render in persistence block (perf nit); (m32) dismissResume/clearDraft identical bodies; (m33) JSON.stringify key-order-sensitive baseline compare.
Task 3.2: implemented (85ce238 server, 29343e8 client; quad-complete duplicate; 403-not-401 consistent with router convention) — review pending
MERGED refactor/params-fe -> refactor branch at 0476288 (clean, no conflicts). INTEGRATION PROVEN: wizard default ServerCreateBody -> 201, settings echo engine-equal incl. sensitivity block.
CARRY-FORWARD: API_SPEC §4 needs the /duplicate endpoint (fold into a docs pass before PR).
MERGE VERIFIED: full pytest exit 0 + 731 web tests green on merged tree (0476288).
PAUSED 21:47 MT per owner — resume 01:41 MT (background sleep timer set). In flight at pause: 3.1 implementer (FE), 3.2 review, 4.1 implementer (backend) — record their notifications, dispatch NOTHING new until the resume signal.
RESUME QUEUE: (1) process any completed reviews/fixes from the in-flight three; (2) FE track: after 3.1 lands+review → merge params-fe again → 3.4 + 3.5 (sonnet); (3) backend track: after 4.1 → 4.2 (sonnet), then 3.3 (sonnet), 4.3 (opus), 4.4 (opus), 4.5 (sonnet); (4) wave 5 splits (5.1 opus / 5.2 opus / 5.3 sonnet); (5) wave 6 (6.1 opus, 6.2 opus, 6.3 sonnet, 6.4 opus + the pinned FE-defaults addendum); (6) final whole-branch fable review + full proof set + owner deliverables doc + PR.
Task 3.1: implemented during pause (9cbb431 on refactor/params-fe, 737 web green; every 1.6.0 param editable in wizard-mirrored groups; timing group auto-skipped) — REVIEW QUEUED for resume; then merge params-fe again.
Task 3.2: review NEEDS-FIXES (server leg approved; client leg 2 Critical) — FIX SLICE 3.2f is FIRST backend action on resume:
  (C1) ProjectionDetail.tsx:626 must send getOwnerToken() ?? token.current to duplicate (edit token 403s owner_required on owner devices); regression test seeding BOTH tokens in localStorage; hide Save-as-copy when getOwnerToken() null (editor-link holders see a guaranteed-403 button).
  (C2) resolveSaveAsCopy/:622-624 + resolveOverwrite/:609-610 clear conflict+failedBody BEFORE the async call — on 403/429/network the edit is silently lost (the P0 recurs). Clear in .then(), re-stash on .catch.
  (I1) API_SPEC §4.5 now CONTRADICTS code (says owner-or-edit auth, {"name"} body, fresh-owner mint, recovery code; code is owner-only, {"patch"}, workspace-join). Reconcile §4.5 + §1.4:86 + §12 matrix:759 + §1.2's 401 promise (router is 403 repo-wide) in the same slice. Also M4 (docstrings cite §4.4 not §4.5).
  (I2) integration test: settings-driver 409 -> banner Save-as-copy carries the driver edit w/ realistic localStorage.
  (M2) 422 duplicate test asserts no orphan row; (M5) decide+test trashed-source duplicate behavior (recommend: 409 or 404 on trashed source — surface to owner in PR notes); (M3) note combined create+duplicate budget in a comment.
Fable adjudications upheld: 403-not-401 (router-wide convention; API_SPEC §1.2 row is the stale side).
Task 4.1: implemented during pause (8e2725a, 1788 py green; If-Match enforced + revision snapshot + rate caps pre-provider) — REVIEW QUEUED for resume. Review must also answer: does ANY live client code call PUT narrative/regenerate (audit says NarrativeCanvas is unreferenced/dead — if truly unmounted, concern #3's client threading is moot and belongs to ticket #360 wire-or-remove).
ALL IN-FLIGHT AGENTS COMPLETE. Fully paused until 01:41 MT (timer bsj1fme0u).
Task 4.1: complete (8e2725a, review Approved; no live client calls narrative endpoints — If-Match threading moot, ticket #360)
FOLLOW-UP LEDGER +: (f-narr1) torn-write window bump-vs-upsert — extend update_with_version_check_and_revision to take optional narrative upsert (one transaction); (m34) _raise_version_conflict docstring overclaims rotation sharing; (m35) _regen_daily_limited ip_limit=0 dummy readability; (m36) daily-capped caller burns hourly budget; (m37) COUNTER_NARRATIVE_REGEN_BLOCKED unwired.
Task 3.1: complete (9cbb431, review Approved; scale audit clean — no 100x errors; group state persists across tab switches)
CRITICAL QUEUED 1.3g (backend, immediately after 3.2f lands — same file projections.py): _revalidate_assumptions/_revalidate_inputs 422 on NUMERIC values (pydantic 2.13 won't coerce float->Optional[str]). Breaks (a) every legacy-driver autosave (SettingsTab sends numbers: labor_pct 0.45, donation_value 60 — the DEPLOYED contract) and (b) rows already storing floats from deployed-era PATCHes (merged dict carries stored float -> every future PATCH 422s). FIX: mode="before" coercion in the revalidation model wrappers: numeric->str for str-typed fields (and accept int-like strings for int fields? no — keep strict there). RED tests: PATCH {assumptions:{labor_pct:0.45}} -> 200; stored-float row + unrelated PATCH -> 200. Plus a true integration test PATCHing the FE's exact numeric buildBody shape.
MINOR LEDGER +: (m38) font-weight 600 literals vs --w-semibold; (m39) no client upper-bound hints on fraction knobs (server-owned, copy generic); (m40) settingsVm string-coercion unit test (LOW risk, follow-up).
Task 3.2f: implemented (b7d9263 code, 3a76bed docs; 1789 py + 737 web green) — re-review pending
FLAKE TRACKED: web parallel-mode cross-file pollution (StepStartupCosts/CreateProjectionPage undefined.map, 2-4 uncaught) — pre-existing at branch head, green with --no-file-parallelism; investigate in 4.5 infra slice.
Task 3.4: implemented (bcafcd5, 9/9 pairs >=4.5, CI contrast gate, 746 web green) — review pending
FLAKE ROOT CAUSE: CostScheduleEditor.tsx:79 totals?.rowTotals.map missing inner ?. — folded into 3.5-FE dispatch. 3.5 penny Y4/Y5 diff fix SPLIT to backend track (app/penny/tools.py stale on FE branch — merge-conflict risk).
MINOR LEDGER +: (m41) 8 more files carry inline brand hex (ProposalUpload/PennyDrawer/ProjectionTab:370/PennyTranscript et al) — follow-up pass.
Task 3.4: complete (bcafcd5, review Approved — 14 ratios independently recomputed, all sibling --error uses enumerated safe, band dedup proven behavior-neutral)
MINOR LEDGER +: (m42) OverrideAudit ~8 remaining inline style blocks w/ off-scale 0.8125rem (finish in follow-up hex sweep m41); (m43) contrast test :root regex single-block assumption + 6-digit-hex-only luminance (loud-fail, comment wanted).
Task 3.2 (+3.2f): COMPLETE (85ce238/29343e8/b7d9263/3a76bed, re-review: all findings FIXED)
QUEUED W3-WRAPUP slice (FE, small): (w1) busy-disable modal/banner buttons during in-flight resolution (double-click Save-as-copy = two copies today); (w2) SettingsTab banner Overwrite clears conflict BEFORE async flush (same C2 class, autosaveReducer OVERWRITE case) — fix + test; (w3) resolveReload also clears failedBody (hygiene); (w4) test: second 409 from overwrite replay re-stashes with NEW current_version; (w5) §4.5 doc nit: no list-Duplicate affordance exists (drop the claim or ticket the affordance — list actions are ticket #53's scope).
Task 1.3g: implemented (ccfc3e4, 1799 py green, introspection-based mode=before coercion, bool excluded) — review pending
FLAKE TRACKED: test_store_robustness.py::test_each_thread_gets_its_own_reader_connection id()-reuse flake (orthogonal) — fold into 4.5 infra slice.
Task 3.5-FE: implemented (37e9189, 754/754 incl. clean parallel runs — flake dead, 3 unguarded accesses fixed) — review pending
OWNER NOTE for deliverables: RecoChip restore on the list reverses an explicit v2-redesign removal (design audit called its absence a P2 defect; plan mandated restore) — flag for owner eyes.
SEQUENCING: W3-wrapup waits for params-fe -> backend merge AFTER 3.3 lands (ProjectionDetail conflict class: 3.1/3.2f both touched it).
POLICY CHANGE (owner, ~04:00 MT, Fable-limit conservation): per-task reviews now run on OPUS; Fable reserved for ONE final whole-branch review before PR. WAVE 5 DEFERRED to tickets (3 tickets to file at ship: projections.py split, ProjectionDetail hooks, PennyDrawer split).
REVISED REMAINING QUEUE: [3.3+penny in flight] -> merge params-fe -> W3-wrapup (sonnet, opus review) -> 4.2 (sonnet) -> 4.3 (opus) -> 4.4 (opus) -> 4.5 (sonnet) -> 6.1 (opus) -> 6.2 (opus) -> 6.3 (sonnet) -> 6.4 (opus, + FE-defaults addendum) -> FABLE final whole-branch review -> proof set -> deliverables -> PR.
POLICY CHANGE 2 (owner ~08:00 MT): sonnet limit hit — ALL remaining implementer slices run on OPUS.
Task 3.5-FE: complete (37e9189 + review fix fdd22ac/[test-ordering commit]; GREEN 12/12 ShareModal, full suite green. NOTE: fdd22ac was committed while the test was still red — my && chain didn't fail on grep; the follow-up commit completes the fix pair. Squash-irrelevant: both on the branch.)
Task 1.3g: complete (ccfc3e4, review Approved — field classification walked live, create-widening safe, Penny figure-guard upstream intact)
QUEUED into next backend slice: NaN-500 one-liner — _require_fraction/_require_min: reject val.is_nan() or move comparisons inside try (pre-existing, amplified by numeric door; PATCH labor_pct=NaN -> 500 today).
MINOR LEDGER +: (m44) _str_typed_fields would match bare dict[str,float]/list[str] (restrict to Union origins); (m45) semantic string fields now coerce numerics (city 42 -> "42", harmless); (m46) create-path numeric acceptance + share_y2..y5/basket missing from integration body (test completeness).
Task 3.3+penny: complete (8912cb4, e07b63e). MERGE 2 complete (05fa1b5 + seam-fix commit): tokens.css brace restored, two 3.2f tests updated for 3.1 grouping. Both suites green post-merge.
POLICY CHANGE 3 (owner ~08:3x MT): fable AND sonnet limits hit — EVERYTHING runs on opus now, including per-task reviews AND the final whole-branch review.
FOLLOW-UP for W3-wrapup: owner detail page's inline MetricBar doesn't show sensitivity/confidence (only RoleView's DecisionBanner does) — add the downside line there.
Batch 1: LANDED (e53ac03 conflict-recovery hardening, 1b482cf NaN-500 fix, d3fcd1a Task 4.2 rate-limit quad complete). Full suites green: pytest 1817, web 785, typecheck clean, goldens --check 0. REVIEW PENDING (opus, first item on resume). Notes: autosaveReducer OVERWRITE test updated to retain-on-overwrite/clear-on-success; owner-only caps placed after _require_owner (no 429 leak to non-owners) — deliberate.
SESSION END 2026-07-04 (limits). HEAD after batch1 = d3fcd1a. Handoff: docs/2026-07-04-massive-refactor-HANDOFF.md.

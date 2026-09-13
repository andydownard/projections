# SECURITY.md — Thrift Store Projection App

**Repo:** `rallytasks/projections` · **Status:** Pre-build spec (scaffold-ready, not yet built) · **Audience:** every engineer, agent, and reviewer touching this codebase · **Authority:** This document is the security contract. Where it disagrees with code, the code is wrong. Source of record is the PRD ([`reference/PRD.md`](reference/PRD.md), §6, §13, §14, §16, §17, §18, §20, §21, §22, §24, §25, §26, §27).

Sibling docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`BUILD_PLAN.md`](BUILD_PLAN.md) · [`ENGINE_CONTRACT.md`](ENGINE_CONTRACT.md) · [`DATA_MODEL.md`](DATA_MODEL.md) · [`API_SPEC.md`](API_SPEC.md) · [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) · [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md) · [`IDEA_FAB.md`](IDEA_FAB.md)

---

## 0. Threat model in one paragraph

**This app has no authentication or authorization of any kind** (owner decision, 2026-09-13). There are no accounts, no passwords, no sessions, no cookies, and — as of this decision — no capability tokens either. Every projection is fully public: `GET /api/projections` lists every projection in the database to every visitor, and every per-projection route (read, edit, export, trash, delete, Penny) works from the bare `view_slug` in the URL with no credential of any kind. This is a deliberate, informed choice, not an oversight — the owner was shown the exact consequence ("a public directory of every nonprofit's financial data") and chose it anyway. The consequences, which drive every decision below:

- **There is nothing to leak, because there is nothing secret.** No token, no session, no login — so token theft, cross-owner access, and CSRF are not applicable threat classes here anymore. What's left is ordinary web-app hygiene: don't let stored XSS run arbitrary script in a visitor's browser, don't let a mutation silently clobber a concurrent edit, don't let an attacker DoS the compute/export endpoints or the GitHub feedback sink.
- **Every write is unauthenticated**, so every expensive/abusable endpoint (research, narrative, feedback, intent, create) must be rate-limited per IP, or we get cost-amplification and GitHub-issue spam.
- **The app fetches attacker-influenceable web pages server-side** for rent research → SSRF risk against Railway's private network.
- **The app sends user data to LLM providers** and renders LLM output into a board packet → prompt-injection and hallucinated-figure risk.
- **`GET /api/metrics` is the one remaining auth gate in this app** — an internal ops endpoint (per-provider cost/latency counters), gated by a separate `METRICS_TOKEN` bearer secret unrelated to the product's data model. It is out of scope for this decision; see §4.5.
- **Data loss is now the opposite failure mode of what it used to be.** There is no "lost owner token orphans a projection" risk anymore, because there was never a lock to begin with — anyone can always reach and edit any projection. The honest risk to surface to users is the reverse one: nothing here is private.

If you are adding or reviewing an endpoint, read §6 (mutations/concurrency), §7 (rate limits), and the checklist in [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md).

---

## 1. Top damage risks (memorize these)

| # | Risk | The rule that prevents it | Test that proves it |
|---|---|---|---|
| 1 | A resolvable projection link or financial field leaks into a public GitHub feedback issue (§22) | Feedback payload carries only a random `support_id` + non-sensitive context. **Never** `view_slug`, URLs, or financial fields. | CI test asserts the GitHub payload contains no `view_slug`/URL/financial key (§9) |
| 2 | Stored XSS via narrative or evidence runs arbitrary script in a visitor's browser | Server-side allowlist sanitization of all user rich text before storage **and** enforcing CSP with no inline script (§5, §8) | Sanitizer unit tests on adversarial payloads; CSP header assertion test |
| 3 | A mutation without optimistic concurrency silently overwrites a concurrent edit | Every mutation requires `If-Match: <version>`; stale → 409 with current state (§6) | 409-on-stale test on every PATCH/POST |
| 4 | The `METRICS_TOKEN` ops gate is bypassed or its secret leaks into a path/query/log | Bearer-only, constant-time compare, secret only in `Authorization`; endpoint 404s entirely when unconfigured (§4.5) | Metrics-gate 401/403/404 test |

---

## 2. No authentication or authorization (owner decision, 2026-09-13)

This app has no access control of any kind, on any surface, for the projections product. There are no users, sessions, cookies, or secrets of any kind gating a projection.

**What this means concretely:**

- `GET /api/projections` returns every projection in the database, to every caller, with no filter.
- `GET/PATCH /api/projections/{view_slug}` and every other per-projection route (preview, `narrative`, `xlsx`, `packet`, `cashflow.csv`, `revisions`, `trash`, `restore`, `delete`, the Penny endpoints) work with no `Authorization` header at all. The `view_slug` in the URL is just a row lookup key now, not a secret — knowing it is not required to reach the row, since the row is also reachable through the global list.
- There is no owner, no editor, no viewer distinction. Anyone who can reach the app can read, edit, export, trash, or permanently delete any projection.
- The former capability-token machinery (owner token, edit token, role-link tokens, `rotate-tokens`) and the former Clerk satellite login (`CLERK_ENABLED`, JWKS verification, `owner_clerk_user_id`/`owner_org_id`, `share_grants`) are deleted from the code. The `POST /api/projections/claim` and `POST /api/projections/{slug}/claim-share` endpoints no longer exist (404).
- A handful of now-unused columns (`owner_token_hash`, `edit_token_hash`, `owner_clerk_user_id`, `owner_org_id`, `role_tokens_json`) and one now-unused table (`share_grants`) remain in the live schema — this project's migrations are additive-only (a static CI gate forbids `DROP COLUMN`/`DROP TABLE`), so they were left in place rather than dropped. Nothing reads or compares against them for access control anymore; treat them as dead. See [`DATA_MODEL.md`](DATA_MODEL.md).
- `/api/r/{role_slug}` (`app/routers/roles.py`) still exists — a read-only alternate URL that tailors emphasis/CTAs for a board/funder/advisor view. It was never an access-control boundary (the projection is public via its main URL too) and is unaffected by this decision, except that `rotate-tokens` — the only way to mint a *new* role link — is gone, so no new role links can be created going forward.
- **What did NOT change:** `If-Match`/`version`/HTTP 409 optimistic concurrency (§6.1) is a CONCURRENCY control, not an access control, and is completely intact — every mutation still requires it. Per-IP rate limiting also stays (§10). `GET /api/metrics` keeps its own independent `METRICS_TOKEN` bearer gate — see §4.5 — an internal ops endpoint outside this decision's scope.

---

## 3. Read-only export & access boundary

- Every visitor may view a projection and download its `.xlsx` and Board Packet — there is no read-only vs. read-write distinction anymore (PRD §20 is superseded by §2 above). This is not a leak; it is the design.
- Whether export is **gated behind the paid expert-review event** is a **business-model toggle** (PRD §3), a config decision, not an access-control bug. The access layer always permits read+export at the read scope; a separate, clearly-labeled gate (terms acceptance, paid flag) may sit in front of it.
- The toggle is the single server config `gate_config` ({`gate_mode`, `price_usd`}, [API_SPEC.md](./API_SPEC.md) §10a). It governs the **expert-review / sign-off surface ONLY** — the basic `.xlsx` and basic packet stay **free and ungated in every mode**. It is **orthogonal** to the terms gate below: a paid gate never bypasses terms, and flipping it never alters compute/`computed_json`/`model_version`.
- **Terms acceptance is required before export/share** (PRD §21). The gate is a server-checked flag, not client-only.

---

## 4. Secret & environment inventory + boot-refuse policy

**All secrets live in environment variables. No exceptions. Nothing secret is committed, logged, or returned to a client.** This mirrors timpager's strongest pattern: a single source-of-truth env module (`app/env_requirements.py`) and a `validate_config()` called at boot. **In production, the server refuses to boot if any required variable is unset — no fallback chains, no silent misconfiguration.** Dev/test are permissive: a missing var logs a structured event but does not crash, so the AI-opt-out path (§7 of PRD §21) stays testable with no keys set.

### 4.1 Required in production (refuse to boot if unset)

| Secret / config | Env var | Why required |
|---|---|---|
| DB location | `DB_PATH=/data/projections.db` | Must point at the **durable** Railway volume, never ephemeral `/app` (§11). Misconfiguration = data loss |
| DB backend | `DB_BACKEND` | Explicit `sqlite` or `postgres` so the data-access path is never ambiguous (mirrors timpager) |
| Places autocomplete / geocode | `GOOGLE_PLACES_API_KEY` | Location lookup (PRD §16) |
| Census households | `CENSUS_API_KEY` | Trade-area household base (PRD §8, §16) |
| AI provider (**at least one**) | `ANTHROPIC_API_KEY` **OR** `OPENAI_API_KEY` | Research extract + narrative (Anthropic primary, OpenAI fallback, PRD §17). Boot requires at least one; documented graceful degrade if the *other* is absent |

### 4.2 Optional — graceful degrade, no boot failure

| Secret / config | Env var | If missing |
|---|---|---|
| OpenAI fallback | `OPENAI_API_KEY` | No fallback provider; Anthropic-only |
| Feedback → GitHub | `GITHUB_TOKEN`, `GITHUB_REPO` | Feedback capture still works server-side; no GitHub issue is filed |
| Penny → GitHub feedback | `PENNY_GITHUB_FEEDBACK_ENABLED` | **Default OFF / dormant** — Penny's `file_product_feedback` tool is registered **only when truthy** (`build_registry` gates it), so with it off Penny cannot auto-file. **Never** a required boot secret; re-read per request for a no-deploy flip. On ⇒ Penny files at her discretion via the same redacted path (§6.3 item 9, [IDEA_FAB.md](./IDEA_FAB.md) §5.8) |
| Intent → CRM | `CRM_API_KEY` | Intent capture disabled; no CRM push |
| Price/gate flag | `GATE_MODE`, `GATE_PRICE_USD` | **Safe default `free`** — unset/unknown ⇒ free, ungated, `price_usd:null`. A business-model toggle (§3, PRD §3), **never** a required boot secret: a missing value defaults to free and must **not** refuse boot. Re-read per request for a no-deploy flip ([OPS_RUNBOOK.md](./OPS_RUNBOOK.md) §9a) |
| Backup replication | `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `LITESTREAM_REGION` | **See the critical note in §11** — in production these should be treated as effectively required (loud health-check) so replication is never silently off |
| Observability | `SENTRY_DSN` | No error reporting |

### 4.3 Rules

- **No fallback chains.** A required secret is required; do not silently substitute another secret or a default. (timpager's regression #21: env read at call time, never cached at module load, never a fallback chain.)
- **AI keys are the only "at least one" rule.** Everything else required is required outright.
- Accidentally committed a secret? **Rotate it immediately** — deleting the commit is not enough. Then re-scan history.
- Generic errors to clients: never echo internal IDs, file paths, stack traces, or key fragments in an API error body.
- The **browser never holds a provider key.** All Places/Census/Anthropic/OpenAI/GitHub/CRM calls are server-side only (PRD §23). The frontend talks only to our own API.

### 4.4 (removed) Clerk satellite auth

This project used to run an optional Clerk satellite login (`CLERK_ENABLED`) for the owner/editor identity. It is deleted entirely as part of the 2026-09-13 decision to remove all authentication (§2) — there is no `CLERK_ENABLED`, no Clerk env var, and no Clerk code path left anywhere in this app.

### 4.5 `METRICS_TOKEN` — the one remaining auth gate

`GET /api/metrics` (per-provider cost/latency counters, OPS_RUNBOOK §6.3) is a separate internal ops endpoint, out of scope for the no-auth decision in §2 — it is not part of the product's projection data model, and the owner did not ask to remove it.

- `METRICS_TOKEN` unset → the endpoint 404s (it does not exist; an unauthenticated probe learns nothing).
- Missing `Authorization` → 401. Wrong bearer → 403 (constant-time compare; the token never appears in a path/query/log).
- Correct bearer → 200 with the secret-free metrics snapshot.
- This gate is self-contained in `app/routers/metrics.py` (its own hash/compare helpers) — it does not depend on anything in `app.deps`, which has no auth primitives left at all.

---

## 5. XSS & rich-text sanitization

The narrative `body_md` (PRD §24) is **user-editable and rendered as HTML**. The evidence panel renders user-supplied source titles/notes. A single stored XSS still lets an attacker run arbitrary script in another visitor's browser — there is no bearer token to steal anymore (§2), but that is not a reason to relax sanitization: script execution in someone else's session is its own harm regardless of what secrets are or aren't present. Therefore:

- **Server-side allowlist sanitization** of `body_md` and any user rich text (evidence labels/notes, projection name, justification notes that travel into the packet) **before storage** (`narratives.body_md` is stored already-sanitized) **and** defense-in-depth on render.
- Use an allowlist sanitizer (e.g. **`bleach`** for Python server-side; **DOMPurify** if any sanitization happens client-side as belt-and-suspenders). Allowlist a minimal Markdown-rendered tag set (`p`, `ul`/`ol`/`li`, `strong`, `em`, `a` with `href` restricted to `http`/`https`/`mailto`, headings, `blockquote`, `code`). **Strip** all `<script>`, all `on*` event-handler attributes, `style` attributes, `javascript:` URLs, `<iframe>`/`<object>`/`<embed>`, and inline SVG.
- Sanitization is **not** the same as numeric grounding (§6) — both apply to narrative: grounding ensures every *figure* is real; sanitization ensures no *markup* is dangerous.
- The projection name and org name flow into Excel/Word filenames and cell text — they must be treated as untrusted (no path traversal via `org_name`; see §12).

---

## 6. Mutations: concurrency, no-CSRF, and grounding invariants

### 6.1 Optimistic concurrency (every mutation)

Autosave (PRD §19.3) means high write frequency on one row, and a fully public app (§2) means many concurrent editors on the same projection with no ownership to serialize them. Therefore **every mutating endpoint requires**:

```
If-Match: <version>
```

- `version` is a monotonic integer per projection (PRD §24). The UPDATE is `… SET version = version + 1, … WHERE id = ? AND version = ?`. A **0-row** result → **HTTP 409** with `{error, current_version, current_state}` so the UI can offer reload / overwrite / save-as-copy (PRD §19.4).
- The new version is returned in the body and as an `ETag`-style header.
- A `409` must be a **real** conflict response, not cosmetic. The frontend tracks the server version from every computed response and never blind-overwrites.
- Autosave is debounced client-side; the server serializes writes (single-writer WAL, §11) and writes **one revision snapshot per settle** (PRD §24). Revision growth is bounded — see [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) retention policy.

### 6.2 CSRF — not applicable

There is no session, cookie, or credential of any kind for our API to read (§2), so there is no ambient browser credential a cross-site request could forge in the first place — the CSRF threat class does not apply to this app's mutation endpoints. **Do not introduce a cookie, a session, or any ambient credential that our API reads** — that would be the first thing in this app's history that could reintroduce CSRF, so treat `Set-Cookie` / `request.cookies` in any request-handling path as a hard stop requiring a design conversation first.

### 6.3 LLM injection defense & grounding (testable invariants, not prompt wishes)

The research and narrative subsystems are the app's trust surface. These are **hard server-side validators that fail the response**, enforced by CI tests (PRD §16, §17):

1. **Untrusted-data framing.** All web/research snippet text passed to a model is wrapped as untrusted **data** with an explicit system instruction to *extract facts only and ignore any embedded instructions*. Strip injection markers (`ignore previous instructions`, `system:`, role-switch tokens) before the model sees them — borrow timpager's `sanitizeForPrompt` pattern: strip markers, cap input tokens, log sanitization events (pattern + timestamp, **never the full input**).
2. **Citation rejection.** The research LLM extracts only from server-fetched snippets and **cannot introduce a citation that was not server-fetched.** Any returned citation URL not in the server's fetched source set is **rejected** (PRD §16.2).
3. **Numeric grounding.** Every figure appearing in narrative prose **must exist** in `computed_json` / approved facts. Post-generation validation rejects any prose containing an ungrounded number (PRD §17). This protects the board packet from hallucinated figures.
4. **Stale handling.** `narratives.computed_hash` is stored at generation; if figures change, surface "Out of date" + diff + Regenerate — **never auto-overwrite user-edited prose** (PRD §17).

**Penny tool-use loop (Spec B §4/§6.2/§11).** Penny is another input device for the **same** server-authoritative mutation path, not a privileged writer. Her bounded server-side tool-use loop exposes the **seven** core tools below (`app/penny/tools.py`) — plus, **only when `PENNY_GITHUB_FEEDBACK_ENABLED` is on (default OFF, dormant)**, an eighth **`file_product_feedback`** action (item 9); the same invariants apply, as CI tests with **stubbed providers only** (no real provider call ever):

| Tool | Kind | Server-side input schema (sent to the model) |
|---|---|---|
| `read_projection` | read | `{}` — returns grounded `computed_json` facts (metrics, KPIs, rows, overrides), the cost schedule, and the editable surface. The **only** way Penny "knows" numbers. |
| `parse_proposal` | extract | `{proposal_ref?, proposal_text?}` — extract-only over an **untrusted** consultant proposal (PDF, by `proposal_ref`, or pre-extracted `proposal_text`); returns candidate cost line-items, tiers/packages, and an inferred phase→month mapping. Every figure must trace to the document; nothing invented (PE9, §6.3.2). |
| `set_input` | mutate | `{field ∈ {name, city, org_name, households, target_opening_date, opening_month_number}, value}` |
| `set_assumption` | mutate | `{name ∈ {labor_pct, marketing_pct, supplies_pct, card_pct, payroll_tax_pct, salvage_pct, escalator, basket, share_y1..3, rent_per_sqft, occupancy_annual, donation_value}, value}` |
| `set_override` | mutate | `{node, year ∈ {1,2,3}, value, note?}` |
| `clear_override` | mutate | `{node, year ∈ {1,2,3}}` |
| `edit_cost_schedule` | mutate | `{ops:[{op ∈ {add,edit,remove}, category, month, amount?, new_month?}], opening_month_number?}` |

5. **Untrusted-data framing of the loop.** The user message and any proposal text are wrapped as untrusted **data** (extract-only / ignore-embedded-instructions framing) and run through `strip_injection_markers` before the model sees them; grounding facts stay in the **trusted** system prompt (`app/penny/loop.py`). Sanitization events are logged as **pattern + timestamp only**, never the input.
6. **Figure-strip in mutate-tool args.** A mutate tool argument is an **intent** (a raw user input value), never a *computed* figure. The server **strips/rejects** any value argument that is display-formatted money/percent — contains `$`, `%`, or thousands-grouping commas (`$277,990`, `8%`, `($41,200)`, `50,000`) — via `app.aisafety.is_computed_figure_token`, so **no LLM-computed figure is ever applied** (extends the N2 figure-strip rule to the tool loop). Bare numbers/fractions (`0.08`, `5000`) pass.
7. **One mutation wall.** Every mutate tool routes through the existing `apply_projection_patch` (the PATCH/`If-Match` service): override-DAG + domain + cost-schedule validation unchanged, non-pinnable → **422 `node_not_pinnable`** relayed in plain language, stale version → **409** surfaced for re-read/retry, and **one revision tagged `actor:penny`** per applied edit. There is no view-only/edit distinction anymore (§2) — every caller can mutate.
8. **Bounded `cost_schedule` (DoS guard, issue #166).** The timed `cost_schedule` array is COUNT-capped at **`MAX_COST_SCHEDULE_ROWS = 200`** rows — a generous bound (real launch schedules carry ~10-30 timed startup rows) that prevents per-projection blob / revision-bloat (the array is JSON-serialized into `inputs_json`/`cost_schedule_json` **and** snapshotted into a fresh revision on every save, so an unbounded array amplifies durable-volume + Litestream cost). Enforced **server-side identically on both write paths**: the manual PATCH (`_validate_schedule_inputs`) and Penny's `edit_cost_schedule` (re-checked after its add/edit/remove ops), each rejecting an over-cap array with **422 `invalid_inputs`** before any write — so neither a hand-crafted PATCH body nor a runaway consultant-proposal parse can balloon the schedule.
9. **Penny → GitHub feedback at her discretion — dormant behind `PENNY_GITHUB_FEEDBACK_ENABLED` (default OFF, Epic F / decisions #7/#12).** When a chat surfaces a real bug/opportunity, Penny may file a redacted GitHub issue **without asking first** and **tell the user in-thread** — via the `file_product_feedback` tool (`app/penny/tools.py`), registered **only when the flag is on** (`build_registry` gates it), so Penny **cannot auto-file in prod** until it is flipped. It reuses the **same** chokepoint as the public feedback path (§1 risk #1, [IDEA_FAB.md](./IDEA_FAB.md) §5.8): the model-composed title/description go through **`redact.py`** (with the projection's `view_slug` as `own_slug`) **before** anything — `$`/`%`/links/slugs/emails stripped to a qualitative report — and file through the **existing** `file_github_issue()` (best-effort/non-fatal), tagged **`filed-by-penny`**. There is no signed-in identity to record anymore (§2) — the feedback row carries no `creator_*` fields. Abuse controls: a **per-IP** rate limit and a **server-side dedup** on the SHA-256 of the *redacted* body per identity/window (`app/feedback/dedup.py`, identity falling back to IP or `"anon"`), so a re-surfaced issue files **at most once** and a flood is capped before any GitHub/DB write (a duplicate/rate-limited attempt is a friendly no-op, never a second issue). Adversarial CI with a **stubbed GitHub client** (no real issue): flag-off no-op, flag-on redacted filing, redaction-at-the-wire, dedup, rate-limit, in-thread ack (`app/tests/test_penny_github_feedback.py`). **Diagnosability:** `file_github_issue()`'s failure handler logs GitHub's `status_code` + a **~200-char response-body excerpt** (GitHub's own error text — never our `GITHUB_TOKEN`/`GH_PAT`, never the issue body) so a filing outage is debuggable without leaking a secret.

These tests must be **adversarial**: feed a hallucinated figure → assert rejection; feed an unfetched citation → assert rejection; feed `ignore previous instructions` web/proposal text → assert it is stripped/ignored; put a computed `$`/`%` into a mutate-tool arg → assert it is stripped/rejected; push `cost_schedule` past `MAX_COST_SCHEDULE_ROWS` (manual PATCH **and** `edit_cost_schedule`) → assert **422** with no write. A happy-path-only test gives false safety.

#### 6.3.1 Penny tool-use loop — untrusted-data framing (Spec B, issue #122 / PE3)

Penny runs a **bounded server-side tool-use loop** (`app/penny/loop.py`) against the provider abstraction (`app/penny/providers.py`: **Anthropic primary → OpenAI fallback → AI-disabled**; the response carries the **actual** provider used; keys are read from server env only — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — never client/URL/log). The same untrusted-data discipline as §6.3 item 1 applies to the loop, and is CI-tested with **stubbed providers** (no real provider call in any test):

1. **Trusted vs untrusted split.** The system prompt and the **grounding context** (the current `computed_json` facts + the editable surface, emitted by the engine) are **trusted** and go in the system message. The **user message** and any **proposal text** are **untrusted DATA**: each is run through `strip_injection_markers` (the same neutralizer as item 1 — `ignore previous instructions`, `system:`, role-switch tokens) and wrapped in explicit `<<<UNTRUSTED_DATA … UNTRUSTED_DATA>>>` delimiters with an *extract-only / ignore-embedded-instructions* instruction before the model ever sees them. Grounding facts are **never** wrapped as DATA (so the model still trusts engine numbers); user/proposal content is **always** wrapped.
2. **Log pattern + timestamp only.** When a strip removes markers, the loop logs a sanitization event (`event`, `source`, `ts`) — **never the input text** itself.
3. **Hard caps (cost & abuse control, not optional).** Per turn: a **max tool-iteration** cap (a runaway loop terminates with a plain message, never an infinite loop), a **max input-token** preflight (oversized prompts are rejected before any provider call), a **max output-token** cap (passed to the provider), and a **per-turn token cost guard** (cumulative spend over budget stops the loop). An injected **rate limiter** (per-turn / per-projection / per token+IP, §10) surfaces **`429` with `retry_after_seconds`** before any provider work.
4. **Fail-soft, never a 500.** AI opt-out or no key configured → **zero provider calls** and a `409 ai_disabled` signal; both providers down → `503 ai_unavailable`; a provider **parse failure degrades to a plain answer**; an unknown tool or a throwing tool handler becomes an `is_error` tool result the model can recover from. None of these become an HTTP 500.
5. **Tool-registry seam.** The loop executes tools through an **injected registry** (`ToolRegistry`); the **seven real tools** (`read_projection`, `parse_proposal`, `set_input`, `set_assumption`, `set_override`, `clear_override`, `edit_cost_schedule`) and their figure-strip-in-tool-args rule land in PE4 and route through the **normal `PATCH` + `If-Match`** mutation/recompute path — Penny is never a parallel writer and never computes a number.
6. **Same `If-Match` wall as the manual UI — no silent lost update (Regression #9, issue #165).** A Penny mutate tool carries the version Penny **grounded on at the start of the turn** as its `If-Match`: the loop threads the version it read (from the grounding context / `read_projection`) into `ToolContext.version` (`app/penny/loop.py`), and the shared write path (`apply_projection_patch`) enforces it exactly as for a human edit. The tool layer **never** back-fills a missing version from a fresh read of the row — that would manufacture a guaranteed-fresh `If-Match` that always matches and **silently clobbers a concurrent human/edit-token change** (a lost update). Fail-closed: an unset `ctx.version` is refused with the **same `428 if_match_required`** the manual PATCH raises (`app/deps.parse_if_match`); a grounded-but-stale version writes 0 rows and surfaces a **real `409 version_conflict`** (with current server state) that the loop hands back to Penny to **re-read and retry, or relay to the user**. Penny has **no privileged concurrency path** — it hits the identical optimistic-concurrency wall as the UI. CI-tested in `app/tests/test_penny_tools.py` (a concurrent external edit makes Penny's stale write 409, not a blind overwrite).

#### 6.3.2 Proposal → cost-schedule parse (extract-only, PE9 / issue #128)

`parse_proposal` turns an uploaded consultant proposal into **candidates** for `edit_cost_schedule` without ever trusting the document as instructions (Spec B §9, `app/penny/proposal.py`):

1. **Resolve the held upload, never re-fetch attacker input.** The tool reads the PDF bytes already held behind the opaque `proposal_ref` (intake validated type + size; SSRF guard fails closed on any remote-URL intake) — from the tool args or the `proposal_ref` the router threads onto `ToolContext.extra`. A pre-extracted `proposal_text` (e.g. a test body) takes precedence. An unknown ref returns a plain `proposal_not_found` (404) the model relays — it never invents content.
2. **Dependency-free PDF text extraction.** `extract_pdf_text` pulls the strings shown by `Tj`/`TJ` text operators from the content streams (decompressing `FlateDecode` with stdlib `zlib`). It is the **untrusted-document reader, not a full PDF engine**: it **never raises** and **never invents** text — a non-PDF, encrypted, or image-only document yields `""`, so the parse degrades to "no candidates" rather than fabricating numbers. The bytes are never executed or rendered.
3. **Injection stripping before parsing.** The extracted text is run through `strip_injection_markers` **before** any structure is read, so a planted `ignore previous instructions` / `system:` / role-switch marker inside the PDF cannot survive into a candidate or reach the model.
4. **Every dollar traces to the document.** Line-items are derived from `$` tokens literally present in the text; no number absent from the document is ever introduced. A document figure is still *display-formatted* money, so the **figure-strip wall** (item 6 above) blocks it from being applied as a mutate-tool argument — the parse surfaces it as inert data, the user supplies the raw value to populate.
5. **Disambiguate, don't guess.** Multiple tiers/packages set `needs_tier_choice` (Penny must ask which before populating). Phases are mapped to project month #s by inference (sequence + stated durations) and returned with `needs_month_confirm` so the populate step waits for the user to confirm/correct the stated mapping; only then are rows written via `edit_cost_schedule` with `provenance.source = "ai"`.

These are CI-tested adversarially with **stubbed providers** (`app/tests/test_proposal_parse.py`, `app/tests/ai_safety/test_penny_proposal_injection.py`): a PDF carrying an injection + a planted bogus number → markers stripped, instructions not obeyed, and no number absent from the document enters a tool argument.

### 6.4 AI opt-out must actually work

The app must **compute, save, and export `.xlsx`** with **zero AI calls** (manual rent, no narrative) — PRD §21. This is verified by a test that runs the full create → compute → save → export flow with **all AI keys unset**. Compute is server-authoritative and AI-independent (the math engine has no network/LLM dependency).

**Three ways AI turns off (any one engages the zero-AI path), checked by `app/aisafety.ai_disabled`:**

1. **Per-projection** — the `ai_opt_out` flag on the projection row (DATA_MODEL §`ai_opt_out`).
2. **Deployment-wide kill switch — `AI_DISABLED`** (the prod **"ship Penny dark"** switch). Set `AI_DISABLED` to a truthy value (`1`, `true`, or `yes`, case-insensitive) and `app/penny/providers.build_provider_chain` returns an **EMPTY provider chain regardless of whether `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are set**. The keys **stay set**, so the production boot rule (§4: at least one AI key required) is **unaffected** — the server boots normally — yet Penny makes **zero provider calls**: the loop raises `AIDisabledError` → the `/penny*` endpoints return **`409 ai_disabled`**, and the FAB is muted. This is the explicit switch for shipping Penny disabled in production while keeping keys configured. **Flip it OFF (unset, or any non-truthy value) to enable Penny live** — no change to the secrets, just the flag. The same `AI_DISABLED` value is honored by the narrative `:regenerate` opt-out gate (`409 ai_disabled`) so the whole AI surface engages or disengages together.
3. **No key configured** — with neither AI key set the chain is empty too (the dev/CI default; this is how the opt-out guarantee stays tested).

Pinned by stubbed-provider tests (no real `api.anthropic.com`/`api.openai.com` call): `AI_DISABLED` truthy **with keys present** → `build_provider_chain` empty → loop signals `ai_disabled` with **zero** transport calls (`app/tests/test_penny_providers.py`, `app/tests/ai_safety/test_penny_ai_off_rate_fallback.py`).

---

## 7. SSRF hardening of the research fetcher

The research subsystem fetches **attacker-influenceable** candidate source URLs server-side (PRD §16.1). On Railway, an unguarded fetcher can be steered at the private network. The fetcher **must**:

- **Resolve the hostname and block** requests whose resolved IP is in any of: loopback `127.0.0.0/8`, `::1`; link-local `169.254.0.0/16` (incl. the cloud metadata endpoint `169.254.169.254`); private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`; IPv6 unique-local `fc00::/7`; and any `*.railway.internal` host.
- **Block redirects to those ranges too** — re-validate the resolved IP on **every** hop, not just the first. Disallow redirect chains that resolve into a blocked range.
- Enforce a timeout, a max response size, and an allowlist of schemes (`http`/`https` only — no `file:`, `gopher:`, `ftp:`).
- Pin DNS-resolution-then-connect to the validated IP to avoid DNS-rebinding TOCTOU where possible.

Reference list for what to block: timpager's `net-guard.js` private-range list.

---

## 8. HTTP security headers (CSP, CORS, noindex, HSTS)

This is a **greenfield React + TS SPA with no legacy inline-script debt** (unlike timpager, which is stuck on `'unsafe-inline'` because of dozens of inline handlers). Therefore we ship an **enforcing CSP from day one** (not Report-Only) **with no inline script**.

### 8.1 Content-Security-Policy (enforcing, no inline script)

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'none';
  form-action 'self';
```

- **No `'unsafe-inline'` in `script-src`.** The build must not emit inline `<script>` blocks or inline `on*=` handlers; the bundler outputs hashed `.js` files served from `'self'`. If a third-party requires inline script, use a nonce — never blanket `'unsafe-inline'`.
- `connect-src` is **`'self'` only**. The browser talks exclusively to our own same-origin API — **all AI is server-proxied** (the SPA calls `/penny`, never a provider directly), and Places, Census, GitHub, and CRM are server-to-server only. The provider origins `api.anthropic.com` / `api.openai.com` were **removed** (issue #167): no client-side provider call exists, so listing them only widened the **post-XSS exfiltration / SSRF-pivot** surface (a stored-XSS `fetch()` to those origins with the owner token from `localStorage`) for no functional benefit. If a genuine client-side provider call is ever introduced, re-add the specific origin then — defense-in-depth default is `'self'`.
- `frame-ancestors 'none'` is the modern clickjacking defense (equivalent to `X-Frame-Options: DENY`).
- `style-src 'self'` — design tokens are shipped as a real CSS file, not inline `style=` attributes (this also aligns with the design system in [`ARCHITECTURE.md`](ARCHITECTURE.md)).

### 8.2 CORS — locked to the app origin

- `Access-Control-Allow-Origin` is the **exact app origin** (the production hostname in the thriftly.com project), not `*`, not a reflected `Origin`.
- Allow only the methods/headers the API uses (`GET, POST, PATCH, DELETE`; `If-Match`, `Content-Type`).
- No `Access-Control-Allow-Credentials` is needed — we send no cookies to our API and nothing to gate behind credentialed CORS (§2). Do not enable it.
- **The Clerk CSP widening this app used to ship is gone.** `app/middleware.build_csp()` now always returns the strict `'self'`-only policy in §8.1 — there is no flag, no widened variant, and no Clerk origin allowlisted anywhere.

### 8.3 No-index

Every response carries `X-Robots-Tag: noindex, nofollow`, and the app serves a `robots.txt` with `Disallow: /`. Projections are public within the app (§2) but must never be search-indexed — the global list page and every `/{view_slug}` route are no-index.

### 8.4 HTTPS / HSTS

- All traffic is HTTPS (TLS terminated at Railway's edge). HTTP is redirected to HTTPS.
- Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` (consider `preload` only after a stable HTTPS-only period).

---

## 9. Feedback redaction (Idea Fab) + support IDs

Bugs go to GitHub (the "idea fab"), which **may be a public repo**. Therefore the GitHub payload is **provably scrubbed** (PRD §22, [`IDEA_FAB.md`](IDEA_FAB.md)):

- **Never** include `view_slug`, any resolvable projection URL, or **any financial field** in the GitHub issue.
- The user is shown a random **`support_id`** (the `feedback.support_id` column). Only server-side staff tooling resolves `support_id → projection` for support context (not that it grants any *additional* access — every projection is already public, §2).
- Auto-context is **non-sensitive only**: route, app version, `model_version`, `support_id`, timestamp.
- **Server-side allowlist (the single chokepoint, both sinks).** The outbound GitHub payload **and** the persisted `feedback.context_json` are assembled by `app.feedback.redact.build_safe_context` from a fixed allowlist — `SAFE_CONTEXT_KEYS = (route, app_version, model_version, type, ts)` — and from those ONLY. **Client-supplied `context.*` is never trusted** (#201): `model_version` is **stamped server-side** from the engine (`engine.model.MODEL_VERSION`) — the client value is dropped at the schema (`extra="ignore"`); `type` is **coerced to the closed enum** `bug|idea|other` (`normalize_type`, unknown → `other`) so it can carry no link/token/financial/markdown; `route` is slug/fragment-stripped **and** run through `redact_text` so no token/link/financial/email survives even in a non-`/p` path segment. `title`/`description` pass through `redact_text` (injection markers, raw HTML, `Bearer`/recovery/high-entropy tokens, resolvable links, **emails**, `$`-amounts, bare percentages, then the §3.2 caps). **Both sinks are built from the same redacted artifact** — the persisted row is scrubbed identically to the payload, so it is safe-if-public even before live GitHub delivery is enabled.
- UI notice: "Don't paste sensitive financial details." The `feedback` table itself stores **no financial fields and no projection link** (PRD §24). (The reply-to address has its own server-only `feedback.email` column and never reaches the payload.)
- **No creator identity is recorded.** This project used to record a signed-in Clerk owner's identity (`creator_email`/`creator_name`/`creator_phone`/`creator_clerk_user_id`) alongside a feedback row. Clerk is gone (§2), and `app/feedback/creator.py` was deleted with it — the feedback row carries no creator identity fields anymore.
- **CI test (mandatory, non-regressable):** construct a feedback submission from a fully-populated projection and assert the outbound GitHub payload **and** the persisted `context_json` contain no `view_slug`, no `http(s)` projection URL, none of the financial field names, and that client-stuffed `context.model_version`/`type` are dropped (server values only survive). This is risk #1 and must be impossible to regress. Covered by `app/tests/test_feedback_abuse.py` (M6.1 fixed-payload leak gate + the #201 stuffed-context test) and `app/tests/test_feedback_redaction_fuzz.py` (#82 seeded fuzz over a populated projection's leak surface, asserting pattern-class absence in both sinks).
- **Intent → CRM** (email, role, reason, timeline, review request, follow-up consent, PRD §6.1/§22) is a **separate** path with explicit consent; it never carries the projection's financial detail and is gated by the optional `CRM_API_KEY`.

---

## 10. Rate limits & audit logging

### 10.1 Rate limits (per IP)

Every write is unauthenticated (§2), so abuse and cost-amplification are open without limits. Cap the expensive/abusable endpoints per IP:

| Endpoint | Why limited | Limit (per IP) |
|---|---|---|
| `POST /api/research` | LLM + Places + Census cost | 10 / hour |
| `POST …/narrative:regenerate` | LLM regeneration cost (PRD §27 cap) | 10 / hour, hard cap per projection/day |
| `POST /api/feedback` | GitHub-issue spam | 5 / hour |
| `POST /api/intent` | CRM spam | 5 / hour |
| `POST /api/projections` (create) | flood | 20 / hour |
| `PATCH …/{slug}` (autosave) | Quad leg (d): runaway writer + revision-row growth | 240 / hour |
| `POST …/revisions/{id}/restore`, `…/trash`, `…/restore`, `DELETE …/{slug}` | Quad leg (d): lifecycle mutations (rarer, heavier) | 60 / hour |
| `GET …/xlsx` | uncached workbook rebuild (CPU/openpyxl) | 30 / hour |
| `GET …/packet` | uncached packet render (CPU) | 30 / hour |
| `GET …/staticmap` | billed Google Static Maps proxy | 120 / hour |
| `POST …/penny`, `POST /api/penny/draft` | bounded provider tool-use loop (LLM cost) | 120 / hour / IP · 240 / hour / projection |
| `POST /api/penny/proposal` | upload intake (holds bytes) | 60 / hour |

- **Penny is keyed on the real client IP AND the projection, not just IP alone (issue #189).** Every external user reaches us through Railway's **single** proxy IP, so a per-IP-only cap on the Penny loop would be one **global** bucket: one flooded projection's turns would 429 every other user (collateral lockout). So Penny's caps run on **two** axes: the real client IP (right-most `X-Forwarded-For` hop, not the raw socket peer) and the **`projection_id`**, which isolates one flooded row's turns from starving every other caller's budget. Implemented via `app/ratelimit.check(..., extra_scopes=…)`. Tested in `app/tests/test_penny_endpoints.py`.
- Research and narrative results are **cached** (PRD §16.6) — caching is also a cost brake, not only a latency win.
- Exceeded limit → `429` with a top-level `{"error":"rate_limited","retry_after_seconds":…}` body **and** a `Retry-After` header; never a 500.
- **Client-IP extraction:** take the **right-most** hop of `X-Forwarded-For`, falling back to the socket peer. Railway terminates TLS at a single proxy that **appends** the real client IP as the last `X-Forwarded-For` entry, so the right-most hop is the only one a client cannot spoof — anything the client sends arrives to the *left* of the proxy's append. (Never trust the left-most entry; it is fully attacker-controlled.)
- **One shared limiter, one test bypass.** All caps run through `app/ratelimit.py` (a process-local fixed-window counter) via the routers' shared `_rate_limited(...)` gate; the check fires **before** any compute/build/upstream call. The limiter is bypassed **only** under the non-prod E2E seed flag (`E2E_SEED=1` **and** not production — the same gate that guards the demo seed in `app/main.py`) so the Playwright create→export gate (three viewports + CI retries from one IP) never trips a production-realistic cap. It is **never** bypassed in production.
- Compute itself (PATCH recompute) is cheap (<50 ms target) and AI-free and concurrency-bounded by the single-writer DB — so PATCH is **not** throttled per keystroke (the client debounces). It **does** still carry a **coarse per-IP abuse cap** (240 / hour) as **Mutation-Safety-Quad leg (d)** so a runaway flood (and the revision-row it appends per settle) is bounded without ever tripping legitimate autosave (~170/hr worst-case at the 350 ms debounce). The lifecycle mutations (`revisions/restore`, `trash`, `restore`, `delete`) carry a tighter **60 / hour** and are emitted **before** any state read/write.

### 10.2 Audit / access log

The `revisions` table (`change_summary`, `created_at`, PRD §24) plus an access-event log records, for forensics:

- **Mutations** (when, what changed — there is no actor identity to record anymore, §2; `actor_token_hash` is always `NULL`).
- **Exports** (`.xlsx`, packet) and **share-link access** events.

The audit log must never contain a secret.

---

## 11. Storage durability, backups & the Litestream path bug

### 11.1 Durable volume — get the path right

- The database **must** live at **`DB_PATH=/data/projections.db`**, on the **durable Railway volume mounted at `/data`** — **never** on the ephemeral container filesystem (e.g. `/app`).
- **CRITICAL — do not copy the timpager bug.** timpager's `litestream.yml` replicates `/app/timpager.db`, which is the **ephemeral** container FS — replicating that would back up data that disappears on redeploy. **Our `litestream.yml` must replicate `/data/projections.db`.** Call this out in every review of the Litestream config. See [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md).
- SQLite in **WAL** mode, with `busy_timeout` set, and **serialized writes** (single writer) — required for autosave write-amplification under one durable volume (PRD §26).

### 11.2 Backups, RPO/RTO, purge limits

- **Litestream** continuously replicates `/data/projections.db` to object storage (R2/S3). RPO is near-zero (continuous WAL streaming); RTO ~2 minutes (restore + boot).
- **Replication must not be silently off.** timpager's runbook marks Litestream "conditional, runs only if `LITESTREAM_BUCKET` is set" — that is exactly how a prod DB ends up unreplicated. In production, **either** treat `LITESTREAM_*` as boot-required, **or** emit a loud, alerting health-check that fails when replication is not live. Pick one and enforce it (see §4.2 and [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md)).
- **A restore drill is a deliverable, not a sentence.** Before launch (M0/M7) run a real restore from object storage into a throwaway volume and assert `PRAGMA integrity_check` passes and that a sample projection's `computed_json` round-trips. Ship `restore-db.sh`. See [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md).
- **Backup purge limits / lifecycle** are bounded and stated to users (PRD §21): define the object-store retention/lifecycle (how long snapshots/WAL are kept) so retention is finite and disclosed in the privacy section (§13).

### 11.3 Migration safety

- Migrations run on deploy (PRD §26) against a **single durable volume with no staging DB copy** — a bad migration corrupts the live DB. Discipline: **additive-only** (`ALTER TABLE … ADD COLUMN`, new tables). **Never drop a table or column** in a deploy migration (timpager's NEVER-DROP rule).
- Take a **pre-migration Litestream checkpoint/snapshot** so a bad migration can be rolled back to the pre-migration state.
- Run migrations **before** the app starts serving (startup order: migrate → validate config → serve).

---

## 12. The math engine: a safe in-process compute core (with one IO caveat)

The reused Python engine (`reference/.../generate_projection.py`, being **rewritten** into a pure compute core per [`ENGINE_CONTRACT.md`](ENGINE_CONTRACT.md)) is, from a security standpoint, low-risk: pure arithmetic, **no network, no subprocess, no secrets, no `eval`**. Two hardening rules nonetheless apply because the legacy script does filesystem IO from `argv` (`json.load(open(argv[1]))`, `os.makedirs(outdir)`):

- **The server owns the output path.** `.xlsx`/`.docx`/packet artifacts are generated into a **server-controlled per-request temp directory** and streamed to the client, then cleaned up. The output directory and filename are **never** user-controlled — guard against path traversal via `org_name`/projection name (sanitize to a safe filename; reject `..`, path separators, control chars).
- **Never round-trip raw user JSON through the filesystem** as a way to call the engine. The compute core takes a validated, normalized in-memory dict (Pydantic-validated at the API boundary) — not a user-supplied file path.

### 12.1 LibreOffice recalc gate (CI dependency hardening)

The release gate recalculates the exported workbook with LibreOffice (`recalc.py`) and asserts **zero formula errors** (`#VALUE! #DIV/0! #REF! #NAME? #NULL! #NUM! #N/A`) and every cell within `< $0.50 / 0.1pp` of `computed_json`, **with and without overrides** (PRD §13, §18). Security/ops notes for this CI step:

- **Pin the LibreOffice/`soffice` version** in the build image — recalc values can shift across versions and undermine the tolerance.
- **Sandbox and timebox** the `soffice` subprocess; ensure a `timeout`/`gtimeout` wrapper is present in the image (`recalc.py` relies on it) so a headless hang cannot block deploys.
- **Fail closed:** the gate must assert `status == "success"` **and** `total_errors == 0`. A `recalc` that returns an `{"error": …}` dict (e.g. missing `soffice`) is a **failure**, never a pass.

---

## 13. Privacy, AI disclosure & legal

- **AI disclosure:** clearly tell users **when** data is sent to AI providers (rent research, narrative) and **to whom** (Anthropic, OpenAI fallback). Provide the **opt-out** (§6.4): full compute/save/`.xlsx` with no AI (PRD §21).
- **Provider retention:** prefer **zero-retention** provider endpoints; document the provider's data-retention and logging settings.
- **App retention & backup purge:** state app retention and the Litestream/object-store **backup purge limits** (§11.2) to users (PRD §21).
- **Legal/trust language:** projections are **planning estimates — not accounting, tax, legal, investment, lending, or lease advice.** **Terms acceptance is required before export/share** (§3, PRD §21). Researched estimates carry source-date stamps and "verify locally" notes (PRD §15).

---

## 14. Attached-evidence file upload hardening

Users may attach rent quotes, broker notes, payroll plans, and comparable-store data (PRD §15; `evidence.file_ref`, §24). File upload is a classic attack surface:

- **Enforce type and size limits** (allowlist content types: PDF, common images, plain text / CSV, office docs; reject everything else). Cap file size.
- **Never store or serve executable content or active SVG** (an SVG can carry script → stored XSS). If images are allowed, prefer rasterizing/validating; do not serve user SVG inline.
- **Serve attachments with `Content-Disposition: attachment`** and a **non-executable `Content-Type`** (e.g. `application/octet-stream` where in doubt), ideally from an **off-origin** host so a malicious file can never run in the app origin (and thus can never reach the `localStorage` token).
- Strip/ignore client-supplied filenames for storage paths; generate a server-side opaque key (no path traversal).

---

## 15. Security gates in the Definition of Done

Every endpoint and PR carries these, enforced as gates (full list in [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md)):

- **No secret in code, logs, or responses** (log-redaction test; the `METRICS_TOKEN` bearer is the only secret left in this app, §4.5, and it is never logged).
- **Mutation safety quad** on every PATCH/POST, now two legs (owner decision 2026-09-13, §2): (1) `If-Match` optimistic-concurrency **409-on-stale**, (2) a negative/abuse path (rate limit per IP).
- **Grounding/safety tests** as first-class, deterministic (stubbed provider responses): unfetched-citation rejected, hallucinated narrative figure rejected, injected web instructions ignored, sanitizer strips dangerous markup.
- **Feedback-redaction test** (§9) — non-regressable.
- **Boot-refuse test:** production boot fails with a required var unset; AI opt-out flow passes with all AI keys unset.
- **Excel correctness gate** (§12.1): LibreOffice recalc clean, with and without overrides, CI-blocking.
- **Threat model for each new endpoint** noted in the PR.
- A `/security-review` checkpoint (gstack) before promotion, and TDD (RED test first) for the grounding and sanitization invariants.

---

## 15a. M7 hardening review notes (OWASP / STRIDE)

M7 adds no new HTTP endpoint and no new secret; the new surfaces are an operational
script (restore-drill verifier), a boot-time static check (additive-migration gate),
and a client-only presentation component (the degraded/error state). The review
below is the per-surface STRIDE + OWASP pass for those surfaces.

### Surface 1 — restore-drill verifier (`app/store/verify_restore.py`, `scripts/verify_restore.py`)
- **STRIDE / Tampering, Repudiation:** the verifier is read-only against a *throwaway*
  restored file (it never touches `/data` or the live DB). It opens SQLite read-only
  in intent and only `SELECT`s; no user input reaches SQL except the `--slug` value,
  which is passed as a **bound parameter** (no string concatenation, per CLAUDE.md).
- **OWASP A03 (Injection):** parameterised query; the slug is operator-supplied at the
  CLI, not attacker-supplied over the network.
- **Information disclosure:** the report dict echoes only **display strings** for the
  three decision metrics (already non-secret view-model data) plus a row count — never
  tokens, never raw `inputs_json`. Safe for the deploy log.
- **DoS:** single fixed-row lookup; not network-reachable.

### Surface 2 — additive-migration safety gate (`app/store/migration_safety.py`)
- **STRIDE / Tampering, Denial of Service (data-loss class):** this is a *defensive*
  control. It fails the boot **closed** if a shipped migration contains `DROP TABLE`,
  `DROP COLUMN`, `RENAME`, `ALTER COLUMN`, `TRUNCATE`, or bulk `DELETE` — the exact
  destructive DDL a Litestream restore cannot undo because the schema change already
  ran. It strips comments and quoted literals first, so a column named `drop_off_count`
  or a default of `'do not drop table'` does not false-positive (no DoS-by-false-trip).
- **OWASP A08 (Software & Data Integrity):** enforces the additive-only invariant
  (CLAUDE.md DB discipline) as code, not just docs; ships with the migration that runs.

### Surface 3 — degraded/error states (`web/src/components/DegradedState.tsx`)
- **STRIDE / Tampering (stored XSS class):** renders only **static, code-owned copy**
  and an optional caller-supplied `detail` string via React text interpolation (auto-
  escaped) — **no `dangerouslySetInnerHTML`**, no raw HTML. Consistent with "stored XSS
  = token theft" (§0): the error surface cannot become an injection vector.
- **Information disclosure:** the 409/offline/stale copy is generic; it does not leak a
  `view_slug`, token, or financial figure into a user-visible error (mirrors the
  feedback-redaction rule, §9). Recovery callbacks are wired by the page, not encoded
  in a URL.
- **a11y is a security-adjacent control:** meaning is carried in **text + an icon, never
  color alone** (role=alert for hard errors, role=status for degraded-but-usable), so a
  read-only / AI-opt-out / 409 state is unambiguous to every user — reducing the chance
  a user blind-overwrites on a stale 409.

**Verification:** `app/tests/test_migration_safety.py`, `app/tests/test_verify_restore.py`,
`web/src/components/DegradedState.test.tsx`, and the 1440/768/375 design-QA pass in
`e2e/degraded-a11y.spec.ts` (screenshots archived). No new endpoint ⇒ the §16 endpoint
checklist is N/A for this milestone; the boot-refuse and feedback-redaction tests remain
green (no regression to §0 invariants).

---

## 16. Quick checklist for adding an endpoint

1. Does it mutate? → require `If-Match: <version>`; return 409 on stale. No auth of any kind (§2) — do not add a bearer/owner check to a new endpoint.
2. Is it a list endpoint? → it's global, like every other list in this app (§2). Don't add owner/tenant scoping — there's no owner concept to scope to.
3. Any secret in the path/query? → **no**, for the same reason as always: this app has essentially no secrets left (§2), and the one exception (`METRICS_TOKEN`, §4.5) still only ever travels in `Authorization`.
4. Does it call an LLM or fetch the web? → untrusted-data framing, citation rejection, numeric grounding (LLM); SSRF block-list + redirect re-validation (fetch).
5. Is it expensive/abusable? → rate limit per IP; cache where possible.
6. Does it render user input? → server-side allowlist sanitize before store and on render.
7. Does it touch feedback/GitHub? → run the redaction test; only `support_id` + non-sensitive context.
8. Does it write a file? → server-owned path, type/size limits, non-executable content-type, `Content-Disposition: attachment`.
9. Did you log anything? → no financial field; no secret (there's only one left, §4.5, and it's never logged).
10. New secret/env var? → add it to `app/config.py`, classify required vs optional, update §4 of this doc in the same PR (Docs Are Code).

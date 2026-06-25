# IDEA_FAB.md — The §17 Feedback Feature ("Idea Fab") and its GitHub Project Wiring

> **Repo:** `rallytasks/projections` · **Status:** Build/spec doc (not yet built) · **Owner:** Andy Downard
> **Scope:** This document specifies the in-app feedback feature (the "idea fab"), the `POST /api/feedback` contract, the server-side redaction and abuse controls, and how a redacted feedback item becomes a GitHub Issue tracked on the **"Projections Roadmap" (GitHub Project #5, `rallytasks`)** GitHub Project (v2) board.
>
> This is a **build/spec document only**. It contains no product/app code. It is one of the sibling docs a reader will see alongside [ARCHITECTURE.md](ARCHITECTURE.md), [BUILD_PLAN.md](BUILD_PLAN.md), [ENGINE_CONTRACT.md](ENGINE_CONTRACT.md), [DATA_MODEL.md](DATA_MODEL.md), [API_SPEC.md](API_SPEC.md), [SECURITY.md](SECURITY.md), [OPS_RUNBOOK.md](OPS_RUNBOOK.md), [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md), [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 0. Why this feature exists and what it is NOT

The Idea Fab is the in-app **bug/idea report** path. Per PRD **§6.1** and **§22**, it has one job: capture *bugs and product ideas* and file them, **redacted**, into GitHub for triage on a Project board. It is deliberately small and deliberately blind to financials.

**It is NOT the discovery engine.** PRD §6.1 splits two flows that must never be conflated:

| Flow | Purpose | Destination | Endpoint | This doc |
|---|---|---|---|---|
| **Feedback (Idea Fab)** | Bugs and product ideas | **GitHub Issues → Project board** | `POST /api/feedback` | ✅ here |
| **Intent capture** | Customer/sales signal (email, role, reason, opening timeline, "request expert review", follow-up consent) | **CRM** | `POST /api/intent` | ↗ see [API_SPEC.md](API_SPEC.md) §intent and [DATA_MODEL.md](DATA_MODEL.md) `intent` |

The two share a modal surface (the lightbulb opens a panel that offers both a "report a bug / share an idea" tab and a separate "request expert review" intent tab — DESIGN_PROMPT §7), but they are **separate endpoints, separate stores, separate destinations, and separate redaction rules.** Intent goes to a private CRM and may carry an email; **feedback is built to be safe even if `rallytasks/projections` is a public repo.**

**Hard invariant (the product's #1 data-leak risk — PRD §22, [CLAUDE.md](CLAUDE.md) Top Damage Risks):**
> A GitHub feedback payload **never** contains a `view_slug`, an owner/edit/role token, a resolvable projection link, or any financial field. Ever. This is enforced server-side and asserted by a CI test ([DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) Tier-1 gate).

---

## 1. User-facing surface: the docked lightbulb + modal

### 1.1 The lightbulb (entry point)

Per PRD §19.3 and DESIGN_PROMPT §intro, a **collapsed feedback button (lightbulb icon)** is docked in the persistent top bar on every authenticated page (list, wizard, detail Tab 1/Tab 2). On mobile (375) it sits above any bottom nav and out of the data area (DESIGN_PROMPT §responsive). It is **keyboard-accessible**: focusable, **Enter opens**, **Esc closes** — an a11y DoD gate, not an aspiration (PRD §27, [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) Tier-2).

### 1.2 The modal (DESIGN_PROMPT §7 — "Feedback modal")

Fields shown to the user:

| Field | Control | Required | Notes |
|---|---|---|---|
| **Type** | Segmented control: `Idea` · `Bug` · `Other` | yes | Maps to GitHub labels (§5.3). |
| **Title** | Single-line text | yes | ≤ **120 chars** (client soft-cap, server hard-cap §3.2). |
| **Description** | Multi-line text | yes | ≤ **4,000 chars** (server hard-cap §3.2). |
| **Email** | Single-line text | **optional** | For an optional reply only. Stored in `feedback.email`; **never** placed in the public GitHub body (§3.3). |
| *(honeypot)* | Hidden field, off-screen, `autocomplete="off"`, `tabindex="-1"`, `aria-hidden="true"` | n/a | Must stay empty; any value ⇒ silent drop (§4.4). Not visible to humans or screen readers. |

**Notice copy (verbatim intent, PRD §22 / DESIGN_PROMPT §7):**
> "Bugs and ideas only. **Don't include sensitive financial details** — this report does not capture your projection numbers."

**Success state (PRD §22, DESIGN_PROMPT §7):** the modal confirms submission and shows a **random support ID** (e.g. `FB-7K2Q-9XFD`, §3.4) the user can quote. It shows **no GitHub link and no projection link**. Copy: "Thanks — your report is logged as **FB-7K2Q-9XFD**. Reference that ID if you follow up."

### 1.3 What the modal collects automatically (NON-SENSITIVE auto-context ONLY)

The client attaches a small, **fixed allowlist** of non-sensitive context. This is the *entire* set — nothing else is read, computed, or transmitted (PRD §22):

| Auto-context key | Example | Source | Rationale |
|---|---|---|---|
| `route` | `"/:view_slug/edit"` (the **route pattern**, not the resolved URL) | client router | Where the user was. |
| `app_version` | `"projections@1.4.2"` | build constant | Which frontend build. |
| `model_version` | `"2.0.0"` | from the loaded `computed_json` | Which engine produced what they saw. |
| `timestamp` | `"2026-06-24T17:03:00Z"` | client clock (server overwrites with its own) | When. |
| `view_slug` | *(optional, see §3.5)* | client | **Server-only**; stripped from anything that reaches GitHub. |

> **`route` is the route *pattern*, never the resolved path.** The client sends `"/:view_slug/edit"`, **not** `"/abc123def.../edit"`. The slug placeholder is literal. This is a build rule, not a runtime hope — see §3.5 for the server-side belt-and-suspenders redaction that catches any slug that leaks in anyway.

**Explicitly forbidden in auto-context (PRD §22):**
- ❌ Owner token, edit token, role token, recovery code, or any value from `localStorage` / the URL fragment.
- ❌ Any financial field — revenue, net, capital required, share %, rent, payroll, `computed_json`, `monthly_json`, `inputs_json`, `assumptions_json`, `overrides_json`, KPI values.
- ❌ Resolved URLs, full `view_slug` in user-visible payload, projection name, organization name, location.
- ❌ Stack traces with user data, console logs, or screenshots (a screenshot could contain the dashboard's dollar figures — out of scope for v1).

---

## 2. End-to-end flow

```
┌────────────┐  Authorization: Bearer (owner)   ┌──────────────────────────┐
│  Frontend  │  POST /api/feedback              │  FastAPI: feedback.py    │
│  lightbulb │ ───────────────────────────────▶ │  (router)                │
│  → modal   │  {type,title,description,email?, │                          │
└────────────┘   context{route,app_version,     │  1. rate-limit (IP+token)│
                  model_version,timestamp,        │  2. honeypot check       │
                  view_slug?}, hp:""}             │  3. validate + length cap│
                                                  │  4. REDACT (server-side) │
                                                  │  5. mint support_id      │
                                                  │  6. INSERT feedback row  │
                                                  │  7. file GitHub Issue    │
                                                  │     (best-effort, async) │
                                                  │  8. add Issue to Project │
                                                  │     board, Status=Inbox  │
                                                  └───────────┬──────────────┘
                                                              │
                            201 {support_id}  ◀───────────────┘
                            (NO github_issue_url to client)
```

**Ordering rules (build invariants):**
1. **Rate-limit and honeypot run before any work** (§4) — cheap rejection, no GitHub call, no DB write that an attacker controls the rate of.
2. **Redaction happens before persistence and before the GitHub call** (§3). The redacted body is what is stored *and* what is filed; there is one redacted artifact, not two.
3. **GitHub filing is best-effort and non-fatal** (§5.4). If `GITHUB_TOKEN`/`GITHUB_ORG`/`GITHUB_REPO` are unset or GitHub is down, the feedback row is still saved and the user still gets a support ID. This mirrors timpager's regression #11 ("GitHub repo creation is non-fatal") and the graceful-degrade pattern in [SECURITY.md](SECURITY.md).
4. **`github_issue_url` is stored server-side but is NOT returned to the client.** The user gets only `support_id`. Only staff tooling resolves `support_id → projection / issue` (PRD §22).

---

## 3. Server-side redaction, validation, and support IDs

All of this lives in `app/routers/feedback.py` plus a pure helper `app/feedback/redact.py` (testable in isolation). See [ARCHITECTURE.md](ARCHITECTURE.md) for module layout.

### 3.1 Request shape (`POST /api/feedback`)

```jsonc
// Authorization: Bearer <owner token>   (any valid owner token; see §3.6)
{
  "type": "idea" | "bug" | "other",
  "title": "string",
  "description": "string",
  "email": "string|null",            // optional, server-stored only
  "context": {
    "route": "/:view_slug/edit",     // route PATTERN
    "app_version": "projections@1.4.2",
    "model_version": "2.0.0",
    "timestamp": "2026-06-24T17:03:00Z",
    "view_slug": "abc123..."         // OPTIONAL; server-only, never reaches GitHub (§3.5)
  },
  "hp": ""                            // honeypot, must be empty (§4.4)
}
```

### 3.2 Length caps (server-authoritative)

The server hard-caps every free-text field **after** trimming, and truncates with an ellipsis marker rather than rejecting (so a long paste never loses the report):

| Field | Hard cap | On overflow |
|---|---|---|
| `title` | 120 chars | truncate to 120, append `…` |
| `description` | 4,000 chars | truncate to 4,000, append `\n\n[truncated]` |
| `email` | 254 chars | reject (invalid email) |
| `context.route` | 200 chars | truncate |
| `context.app_version` | 64 chars | truncate |
| `context.model_version` | 32 chars | truncate |

Caps mirror the timpager `sanitizeForPrompt` token-cap discipline ([SECURITY.md](SECURITY.md) "Prompt Sanitization"). Length-capping is also a cost/abuse control: it bounds GitHub Issue body size.

### 3.3 Redaction pipeline (`redact.py`)

Applied to `title` + `description` + any string that will reach GitHub, in order:

1. **Allowlist the context.** Only the five keys in §1.3 are read. Any other key in `context` is dropped silently. Financial keys are never read because they are never accepted into the schema in the first place (Pydantic model rejects unknown fields).
2. **Strip secrets-shaped tokens.** Regex-scrub anything matching the token shapes used in this app: high-entropy `token_urlsafe` strings (≥ 22 base64url chars), `Bearer\s+\S+`, and recovery-code patterns. Replace with `[redacted]`. (Defense in depth — a user might paste their own edit link into the description.)
3. **Strip resolvable links.** Any URL whose path matches a `view_slug`-shaped segment, and any occurrence of the request's own `view_slug` (when provided, §3.5), is replaced with `[link removed]`.
4. **Strip injection markers** before the text is ever rendered in a GitHub issue: remove/escape `ignore previous instructions`, `system:`, and HTML/Markdown that could be active in a rendered issue (no raw `<script>`, no inline event handlers). Reuse the timpager `sanitizeForPrompt` marker list ([SECURITY.md](SECURITY.md)). GitHub renders issue bodies as Markdown, so the body is **escaped/allowlisted** the same way narrative `body_md` is sanitized (PRD §20).
5. **Log a sanitization event** (pattern + support_id + timestamp, **not** the full input) for forensics, per timpager's logging rule.

The function signature is pure and deterministic so it can be unit-tested:
`redact(raw_feedback) -> {title, body_md, context_safe}` where `context_safe` contains only `{route, app_version, model_version, timestamp}` — **`view_slug` is never in `context_safe`.**

### 3.4 Support ID scheme

- Format: `FB-XXXX-XXXX` where `X` is from an unambiguous alphabet (Crockford base32: no `I`, `L`, `O`, `U`) — readable aloud, no confusing characters.
- Generated with a CSPRNG (`secrets`), ~50 bits of entropy — enough that IDs are unguessable but they are **not** secrets (they grant nothing; they only let staff look up a row).
- Stored as `feedback.support_id` (unique). Shown once on success. Reused by the user when they follow up.
- **The support ID is the ONLY link between a user-visible artifact and the projection**, and resolving it requires server-side staff tooling (PRD §22). It appears in the GitHub issue body (it is non-sensitive), so staff can pivot issue → support_id → (internal) projection.

### 3.5 `view_slug`: server-only, used at most for staff resolution

`context.view_slug` is **optional** and exists solely so staff tooling can correlate `support_id` to a projection internally. It is:
- **Stored** only as part of the server-side audit trail (and even then, prefer storing the association keyed by `support_id` in a staff-only table, not in `feedback.context_json`).
- **Never** written into `feedback.context_json` that mirrors the GitHub payload.
- **Never** sent to GitHub.
- **Belt-and-suspenders:** the redactor (§3.3 steps 1 & 3) strips the slug from `title`/`description`/`route` even if a client bug puts it there. The `route` field is asserted to match a pattern (contains `:view_slug`, never a raw slug) by a validation rule; a raw-slug-shaped route is normalized back to the pattern.

> **Privacy default:** the simplest compliant build sends **no** `view_slug` at all and relies on the user quoting their support ID plus staff context. Sending `view_slug` server-only is an optional convenience; if it is built, it must pass the CI leak test in §6.

### 3.6 Auth

`POST /api/feedback` requires `Authorization: Bearer <owner token>` (any valid owner token in the system), so feedback is tied to a real workspace for rate-limiting and abuse control (§4) — **but the owner token, the workspace identity, and the projection are never exposed in the GitHub payload.** Per PRD §20 the token is compared constant-time against `owner_token_hash`; the token itself is never logged. Unlike every other mutation, feedback does **not** require `If-Match`/`version` (PRD §25) because it does not mutate a projection.

---

## 4. Abuse controls

The no-login capability-token model means tokens are free to mint, so the abuse surface is "anyone who can create a projection" (PRD §29). The brakes:

### 4.1 Rate limits (per-IP AND per-token)

Per PRD §20/§27, every abuse-prone endpoint is capped on **both** axes. Starting template (tune against real traffic; numbers borrowed from timpager's explicit limits, [CLAUDE.md](CLAUDE.md) / [SECURITY.md](SECURITY.md)):

| Endpoint | Per IP | Per owner token | On exceed |
|---|---|---|---|
| `POST /api/feedback` | **10 / hour** | **20 / day** | `429` + `Retry-After`; **no** GitHub call, **no** DB write |
| `POST /api/research` | 5 / hour | 20 / day | `429` (cost: LLM + Places + Census) |
| `POST …/narrative:regenerate` | 5 / hour | 15 / day | `429` (cost: LLM) |
| `POST /api/intent` | 10 / hour | 20 / day | `429` (CRM spam) |
| `POST /api/projections` (create) | 10 / hour | 50 / day | `429` |

Rate-limit state keyed by `(client_ip, token_hash)`. `client_ip` is the real client IP from the trusted proxy hop (Railway edge appends the public client IP to `X-Forwarded-For`; take the right-most untrusted hop — see the timpager `net-guard` XFF handling in [SECURITY.md](SECURITY.md)). Limits are checked **before** the honeypot to keep the cheapest rejection first.

### 4.2 Why the limits matter here specifically

Each accepted feedback creates a **GitHub Issue**. Without a cap, anyone who mints a token can spam-create issues in `rallytasks/projections` and pollute the Project board (and consume GitHub API rate budget). The per-IP + per-token caps + honeypot are the only brakes.

### 4.3 GitHub-side dedupe / flood protection

- **Idempotency:** if the same `(token_hash, sha256(title+description))` arrives within a short window, return the existing `support_id` instead of filing a duplicate issue. Mirrors timpager's "idempotency guard" mutation requirement ([CLAUDE.md](CLAUDE.md) Mutation Safety quad — adapted: feedback isn't a projection mutation but still gets idempotency + rate-limit + negative-path tests).
- **Circuit breaker:** if GitHub returns sustained `5xx`/`403 (secondary rate limit)`, stop filing for a cool-down window; feedback rows still persist with `github_issue_url = null` and a `status = "pending_github"` so a backfill job (§5.5) can file them later.

### 4.4 Honeypot

A hidden form field (`hp`, see §1.2) that is invisible to humans and screen readers but that naive bots fill. **If `hp` is non-empty, the server responds `201` with a freshly-minted-but-discarded support ID and silently drops the submission** — no DB write, no GitHub call. Returning a plausible success (not a 400) avoids teaching the bot what tripped it. The honeypot complements, not replaces, the rate limits.

---

## 5. GitHub wiring — issues + the "Projections Roadmap" (GitHub Project #5, `rallytasks`) Project board

### 5.1 Configuration (server-side secrets only)

Per PRD §22/§23 and [SECURITY.md](SECURITY.md) env inventory, GitHub wiring is **optional / graceful-degrade**:

| Env var | Required? | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | optional (feedback degrades if unset) | Least-scoped PAT/fine-grained token that can create issues and add items to the Project (§5.6). |
| `GITHUB_ORG` | optional | `rallytasks` |
| `GITHUB_REPO` | optional | `projections` |
| `GITHUB_PROJECT_NUMBER` | optional | The org Project (v2) number for **"Projections Roadmap" (GitHub Project #5, `rallytasks`)**. **`<FILL IN ONCE THE PROJECT IS CREATED>`** — see §5.7. |

If any of `GITHUB_TOKEN` / `GITHUB_ORG` / `GITHUB_REPO` is unset in production, the server **does not refuse to boot** (unlike `DB_PATH`, `ANTHROPIC_API_KEY`, etc.) — it logs a structured "feedback→GitHub disabled" event and feedback still persists locally. This is explicitly in the **optional/graceful-degrade** column of the boot-refuse policy in [SECURITY.md](SECURITY.md), matching timpager's treatment of `GH_PAT`.

### 5.2 Private vs public repo

`rallytasks/projections` **may be public or private** — the redaction contract (§3) makes the feedback payload safe **either way** (PRD §22: "Safe even if the repo is public."). The recommended posture:
- **Private repo** is preferred for v1 (defense in depth) — keeps support IDs and route patterns out of public view.
- The build must **not depend on privacy for correctness**: a CI leak test (§6) proves the payload is publishable. If product later open-sources the repo, no redaction change is required.

### 5.3 Issue shape

For each accepted, redacted feedback, the server creates a GitHub Issue:

- **Title:** `[Idea] <redacted title>` / `[Bug] <redacted title>` / `[Other] <redacted title>`
- **Labels:** `idea-fab` (always) + one of `type:idea` / `type:bug` / `type:other`.
- **Body (Markdown, fully redacted — §3.3):**

  ```md
  <redacted description>

  ---
  - Support ID: FB-7K2Q-9XFD
  - Route: /:view_slug/edit
  - App version: projections@1.4.2
  - Model version: 2.0.0
  - Reported: 2026-06-24T17:03:00Z

  _Filed by the Projections Idea Fab. Contains no projection link and no financial data._
  ```

  Note the body carries **only** `support_id` + the four non-sensitive context fields. **No email, no view_slug, no link, no numbers.**

### 5.4 Filing is best-effort and non-fatal

The GitHub call happens **after** the local `feedback` row is committed. The request returns `201 {support_id}` as soon as the row is saved; the GitHub issue + Project-add can complete asynchronously (a background task) so a slow GitHub API never blocks the user. On GitHub failure the row keeps `github_issue_url = null`, `status = "pending_github"`, and the backfill job (§5.5) retries. This matches timpager regression #11 (GitHub non-fatal) and PRD §22's "safe even if … fails" intent.

### 5.5 Backfill / retry job

A small periodic task scans `feedback WHERE github_issue_url IS NULL AND status='pending_github'` and re-attempts filing (respecting the §4.3 circuit breaker). Documented as an ops task in [OPS_RUNBOOK.md](OPS_RUNBOOK.md).

### 5.6 Least-scoped token

`GITHUB_TOKEN` is provisioned with the **minimum** scope to (a) create issues in `rallytasks/projections` and (b) add items + set a field value on the "Projections Roadmap" (GitHub Project #5, `rallytasks`) Project (v2). Recommended: a **fine-grained PAT** (or GitHub App installation token) scoped to the single repo with **Issues: Read & Write** and **Projects: Read & Write**, and nothing else. No `repo` classic-scope blanket token. Rotated on personnel change ([SECURITY.md](SECURITY.md) rotation rule). The token is server-side only and never logged.

### 5.7 The Project board: "Projections Roadmap" (GitHub Project #5, `rallytasks`)

A GitHub **Project (v2)** at the **org level** (`rallytasks`) named **"Projections Roadmap" (GitHub Project #5, `rallytasks`)** tracks every filed issue. Configuration:

- **Single-select `Status` field** with options, in order: **Inbox → Triage → Planned → Done.**
- New issues land in **`Inbox`** automatically when added by the server (or via the Project's built-in "auto-add" workflow as a backstop).
- Triage moves items Inbox → Triage → Planned → Done by hand (or via Project workflows). The server only ever *adds* the item and sets `Status = Inbox`; it does not manage later transitions.

**Wiring step performed by the server after issue creation:**
1. Add the newly-created issue to Project `GITHUB_PROJECT_NUMBER` (GraphQL `addProjectV2ItemById`).
2. Set its `Status` single-select field to the option id for **`Inbox`** (GraphQL `updateProjectV2ItemFieldValue`).

Both steps are best-effort (same circuit breaker / backfill as §5.4–5.5). The Project number and the `Status` field/option node-ids are resolved once and cached (they are stable for the life of the board).

> **PROJECT NUMBER IS A FILL-IN.** The board does not exist yet. **`GITHUB_PROJECT_NUMBER` is set to a placeholder and MUST be filled in once the "Projections Roadmap" (GitHub Project #5, `rallytasks`) Project (v2) is created** under the `rallytasks` org. Until it is set, the server skips the add-to-Project step (issues are still created and labeled `idea-fab`, so they are findable; they simply aren't on the board yet). Setup checklist:
> 1. Create org Project (v2) **"Projections Roadmap" (GitHub Project #5, `rallytasks`)** under `rallytasks`.
> 2. Add a single-select **`Status`** field with options **Inbox, Triage, Planned, Done** (in that order).
> 3. Record the Project **number** and set `GITHUB_PROJECT_NUMBER` in Railway (staging + prod).
> 4. (Optional) enable the Project's "Auto-add to project" workflow filtered to label `idea-fab` as a backstop to the server-side add.
> 5. Verify with one test submission end-to-end (§6.4).

---

## 6. Tests & Definition of Done (CI-blocking)

Per [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) and the Mutation Safety / Regression Registry rules in [CLAUDE.md](CLAUDE.md), the Idea Fab ships only when these pass:

### 6.1 The leak test (Tier-1 GATE — non-negotiable)

A test feeds a feedback request whose `title`, `description`, `context.route`, and `context.view_slug` are **stuffed with** a real `view_slug`, an owner bearer token, an edit-link fragment, a recovery code, a resolvable URL, and financial strings (e.g. `"$277,990 capital required"`, `"share 6%"`). It then asserts the **exact GitHub payload** the server would send contains:
- ❌ no `view_slug` (raw or in any URL),
- ❌ no token / recovery-code-shaped string,
- ❌ no email,
- ❌ no resolvable link,
- ✅ only `{redacted title, redacted body, support_id, route-pattern, app_version, model_version, timestamp}`.

This test is the materialization of PRD §22 and is **impossible to regress** — it is in the Tier-1 commit gate.

### 6.2 Redaction unit tests
`redact()` strips token shapes, links, slug occurrences, and injection markers; truncates to caps; preserves benign text. Adversarial inputs (pasted edit link, pasted dollar figures, `ignore previous instructions`) all neutralized.

### 6.3 Abuse-control tests
- Per-IP and per-token rate limits return `429 + Retry-After` and **make no GitHub call / no DB write** past the limit.
- Honeypot non-empty ⇒ `201` with discarded support ID, **no** DB write, **no** GitHub call.
- Idempotent re-submit returns the same `support_id`, no duplicate issue.

### 6.4 GitHub-wiring tests
- With GitHub mocked: issue created with correct title/labels/body; item added to Project; `Status` set to `Inbox`.
- **Graceful-degrade test:** with `GITHUB_TOKEN`/`GITHUB_ORG`/`GITHUB_REPO` **unset**, `POST /api/feedback` still returns `201 {support_id}` and persists the row (matches timpager non-fatal pattern). This is part of the [SECURITY.md](SECURITY.md) "AI/integration opt-out must actually work" discipline.
- `github_issue_url` is **never** present in the API response body.

### 6.5 Auth & negative-path tests
- No `Authorization` ⇒ `401`.
- Invalid bearer ⇒ `401` (constant-time compare; no token in logs).
- Feedback never requires `If-Match` and never mutates a projection.

---

## 7. Data model (the `feedback` table)

Per PRD §24, the schema is **scrubbed by design** — there is no column that could hold a financial value or a projection foreign key:

```
feedback(
  support_id      TEXT PRIMARY KEY,   -- FB-XXXX-XXXX (§3.4)
  type            TEXT,               -- idea | bug | other
  title           TEXT,               -- redacted, capped (§3.2/§3.3)
  body            TEXT,               -- redacted body_md, capped
  email           TEXT NULL,          -- optional, server-only, NEVER in GitHub payload
  context_json    TEXT,               -- {route, app_version, model_version, timestamp} ONLY (§3.3)
  github_issue_url TEXT NULL,         -- server-only; NEVER returned to client (§2)
  status          TEXT,               -- new | pending_github | filed
  created_at      TEXT
)
-- NO financial fields. NO projection_id / view_slug column.  (PRD §22/§24)
```

Notes:
- `context_json` mirrors exactly what goes to GitHub — keeping the audit trail and the public payload identical means there is one redacted artifact (§2 rule 2).
- Any staff-only `support_id → projection` association (when §3.5 `view_slug` is captured) lives in a **separate staff-only table**, never joined into this one, never exported.
- String PK (`support_id`) and no SQLite-specific SQL above the `Store` interface keep the Postgres path open ([ARCHITECTURE.md](ARCHITECTURE.md) data-access rules).

---

## 8. Build placement (milestone & modules)

| Item | Where |
|---|---|
| Milestone | **M6 — Feedback + intent** (PRD §28): redacted GitHub + support IDs; CRM intent loop. |
| Router | `app/routers/feedback.py` (and `app/routers/intent.py` for the CRM sibling) |
| Pure redactor | `app/feedback/redact.py` (unit-tested in isolation) |
| GitHub client | `app/integrations/github_idea_fab.py` (issue create + Project add + Status set; circuit breaker; backfill) |
| Store methods | `Store.insert_feedback(...)`, `Store.list_pending_github_feedback()`, `Store.set_feedback_issue_url(...)` |
| Frontend | `FeedbackButton` (docked lightbulb) + `FeedbackModal` + `IntentCapture` (see [ARCHITECTURE.md](ARCHITECTURE.md) frontend component inventory) |
| Ops | backfill task + token rotation documented in [OPS_RUNBOOK.md](OPS_RUNBOOK.md); env table + rate-limit table in [SECURITY.md](SECURITY.md) |

---

## 9. Quick reference — the invariants a reviewer checks

1. **No `view_slug`, token, link, email, or financial value ever reaches GitHub** — proven by the §6.1 leak test (Tier-1 gate). [§3, §6.1]
2. **Auto-context is the fixed 5-key allowlist; `route` is a pattern, not a path; only 4 keys reach GitHub.** [§1.3, §3.3]
3. **Redaction + length caps are server-side and run before persist and before GitHub.** [§2, §3.2, §3.3]
4. **Rate-limited per IP and per token; honeypot drops bots silently; idempotent.** [§4]
5. **Least-scoped `GITHUB_TOKEN`; repo may be public or private; feedback safe either way.** [§5.1, §5.2, §5.6]
6. **GitHub filing is best-effort/non-fatal — feedback persists and returns a support ID even if GitHub is unset or down.** [§5.4, §6.4]
7. **Issues land on "Projections Roadmap" (GitHub Project #5, `rallytasks`) (Project v2) with `Status` Inbox → Triage → Planned → Done; server sets `Inbox`.** [§5.7]
8. **`GITHUB_PROJECT_NUMBER` is a placeholder until the board is created** — fill in per the §5.7 checklist. [§5.7]
9. **`support_id` is the only user-visible handle; `github_issue_url` is server-only; only staff resolve support_id → projection.** [§3.4, §2]

# SECURITY.md — Thrift Store Projection App

**Repo:** `rallytasks/projections` · **Status:** Pre-build spec (scaffold-ready, not yet built) · **Audience:** every engineer, agent, and reviewer touching this codebase · **Authority:** This document is the security contract. Where it disagrees with code, the code is wrong. Source of record is the PRD ([`reference/PRD.md`](reference/PRD.md), §6, §13, §14, §16, §17, §18, §20, §21, §22, §24, §25, §26, §27).

Sibling docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`BUILD_PLAN.md`](BUILD_PLAN.md) · [`ENGINE_CONTRACT.md`](ENGINE_CONTRACT.md) · [`DATA_MODEL.md`](DATA_MODEL.md) · [`API_SPEC.md`](API_SPEC.md) · [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) · [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md) · [`IDEA_FAB.md`](IDEA_FAB.md)

---

## 0. Threat model in one paragraph

This is a **no-login** web app. Access is governed entirely by **capability tokens** (unguessable bearer secrets). There are no accounts, no passwords, no sessions, no cookies. The consequences, which drive every decision below:

- **A leaked token = full access at its scope.** A leaked owner token is total takeover of one projection; a leaked edit token is full write; a leaked `view_slug` is read-only. There is no second factor and no server-side "is this really the owner" check beyond holding the secret.
- **The bearer token lives in `localStorage`.** Therefore **any stored XSS = token theft = projection takeover**, and the token also authorizes `.xlsx`/packet export. Sanitization and an enforcing CSP are load-bearing, not nice-to-have.
- **No cookies ⇒ no CSRF for mutations.** This is a deliberate design win (PRD §20); never reintroduce a cookie.
- **Anyone can mint tokens for free** (create a projection), so every expensive/abusable endpoint (research, narrative, feedback, intent, create) must be rate-limited per IP **and** per token, or we get cost-amplification and GitHub-issue spam.
- **The app fetches attacker-influenceable web pages server-side** for rent research → SSRF risk against Railway's private network.
- **The app sends user data to LLM providers** and renders LLM output into a board packet → prompt-injection and hallucinated-figure risk.
- **Key loss = data loss.** No login means a lost owner token / lost recovery code permanently orphans a projection. Staff cannot recover access (§29). This must be surfaced honestly to users.

If you are adding or reviewing an endpoint, read §3 (tokens), §6 (mutations/concurrency), §7 (rate limits), and the threat-model checklist in [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md).

---

## 1. Top 5 damage risks (memorize these)

| # | Risk | The rule that prevents it | Test that proves it |
|---|---|---|---|
| 1 | A resolvable projection link or financial field leaks into a public GitHub feedback issue (§22) | Feedback payload carries only a random `support_id` + non-sensitive context. **Never** `view_slug`, tokens, URLs, or financial fields. | CI test asserts the GitHub payload contains no `view_slug`/token/URL/financial key (§9) |
| 2 | Stored XSS via narrative or evidence steals the `localStorage` bearer token | Server-side allowlist sanitization of all user rich text before storage **and** enforcing CSP with no inline script (§5, §8) | Sanitizer unit tests on adversarial payloads; CSP header assertion test |
| 3 | Cross-owner data access (list or read another owner's projection) | Every query is owner-scoped or slug-scoped; list is **never** global; constant-time hash compare (§3, §4) | Per-mutation isolation test: owner A cannot read/write/list owner B |
| 4 | A mutation without optimistic concurrency silently overwrites a concurrent edit | Every mutation requires `Authorization: Bearer` + `If-Match: <version>`; stale → 409 with current state (§6) | 409-on-stale test on every PATCH/POST |
| 5 | A secret reaches a URL path, query string, or server log | Secrets only in `localStorage` + URL **fragment** + `Authorization` header. Never path/query. Fragment scrubbed after read. Never log `Authorization` or fragments (§3) | Log-redaction test; route table forbids `:token` path params |

---

## 2. Capability-token model (no login)

Access is a **capability**, not an identity. Holding the secret *is* the authorization. There are no users, sessions, or cookies.

### 2.1 The four token types

| Token | Scope | Length / entropy | Delivery | Storage (server) |
|---|---|---|---|---|
| **Owner token** | Full control of one projection: read, write, share, rotate, trash, delete, list (owner-scoped) | **≥ 256-bit** bearer | `localStorage`; sent as `Authorization: Bearer <owner_token>` | **hashed** (`owner_token_hash`) |
| **Edit token** | Read + write one projection (no rotate/delete) | ≥ 256-bit bearer | URL **fragment** on the `…/edit` link; sent as `Authorization: Bearer <edit_token>` | **hashed** (`edit_token_hash`) |
| **`view_slug`** | Read-only one projection | **≥ 128-bit** | URL path segment (it is the public, shareable read key) | **plaintext** — it is the lookup key |
| **Role link tokens** (board / funder / advisor, §6.2 of PRD) | Read-only with role-specific emphasis/CTAs; advisor adds comment capability | ≥ 128-bit | URL fragment; resolved to a role flag | hashed (per-role) |

Rationale for hashing-but-not-`view_slug`: tokens that grant **write/control** must be unrecoverable from a DB dump → hashed. The `view_slug` is the indexed lookup key for read access and is deliberately public on the share link, so it is stored plaintext (an attacker with the DB already has read access; hashing it buys nothing and costs a lookup index).

### 2.2 Generation — CSPRNG only

```python
import secrets
owner_token = secrets.token_urlsafe(32)   # 32 bytes = 256-bit
edit_token  = secrets.token_urlsafe(32)   # 256-bit
view_slug   = secrets.token_urlsafe(16)   # 16 bytes = 128-bit
```

- Use **only** `secrets` (CSPRNG). Never `random`, `uuid4` as a secret, timestamps, or counters.
- `secrets.token_urlsafe(32)` yields a 43-char URL-safe string carrying 256 bits; `token_urlsafe(16)` yields ≥128 bits. These satisfy the PRD ≥256/≥128 floors.

### 2.3 Hashing & constant-time comparison

These tokens are **high-entropy random secrets, not user passwords.** A 256-bit random value is not brute-forceable, so a slow KDF (bcrypt/argon2/scrypt) buys nothing and would only add latency. Use a fast cryptographic hash:

```python
import hashlib, hmac

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def token_matches(presented: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_token(presented), stored_hash)
```

- **Every** token comparison uses `hmac.compare_digest` (constant-time). Never `==` on a token or hash — it leaks length/prefix timing.
- Store `owner_token_hash` and `edit_token_hash` (and role-link hashes). Look up a presented bearer by computing its hash and matching constant-time; look up read access by `view_slug` equality (still via `compare_digest` against the stored slug).
- Never store, log, or return a plaintext owner/edit token after it leaves the create/rotate response. It is shown to the client once and persisted only by the client.

### 2.4 Auth resolution (the `app/deps.py` dependency)

Every request resolves to one of: `owner`, `edit`, `view`, `role:{board|funder|advisor}`, or `anonymous`. The auth dependency:

1. Reads `Authorization: Bearer <secret>` (if present).
2. Reads the target projection by `view_slug` (path) — this never requires a secret (read-only path).
3. Computes `hash_token(secret)` and compares constant-time against `owner_token_hash`, then `edit_token_hash`, then role hashes.
4. Returns the **highest** scope that matches; otherwise `view` (if a valid `view_slug`) or `anonymous`.
5. **Mutations require ≥ `edit`.** Rotate/delete/trash require `owner`. Reject otherwise with `403` (never reveal whether the projection exists beyond what the `view_slug` already grants).

### 2.5 No secrets in paths, queries, or logs

- **Edit / recovery / role secrets travel only in the URL fragment** (the part after `#`, which browsers never send to the server). The client reads the fragment, moves the secret into the `Authorization` header for API calls, then **scrubs it from the URL** (`history.replaceState` after `location.hash` is consumed) so it does not linger in screenshots, browser history exports, or referrer headers.
- **Never** accept a secret in a path segment (`/p/{token}`) or query string (`?token=`). The route table in [`API_SPEC.md`](API_SPEC.md) must not contain a token path/query parameter. A reviewer who sees one rejects the PR.
- **Never** log `Authorization` headers or URL fragments. The request logger has an explicit redaction allowlist; `Authorization` is dropped, and any field whose name matches `*token*`/`*secret*` is masked. A log-redaction test enforces this (see [`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md)).

### 2.6 Rotation & revocation (ship in v1 — not deferred)

A leaked edit fragment is full write access with no second factor, so `rotate-tokens` (`POST /api/projections/{slug}/rotate-tokens`, owner-only, §25) **must exist at launch**:

- Atomically (one DB transaction) regenerates and re-hashes **owner, edit, `view_slug`, and all role-link tokens**, immediately invalidating every previously shared link.
- Writes a **rotation event** into the audit/revision log (`actor_token_hash`, timestamp, event type) — see §10.
- Returns the new owner/edit secrets once to the rotating client (who must re-store them). The old links now 404/403.
- Use rotation as the compromise response: "I think my edit link leaked" → rotate → all old links dead.

### 2.7 Workspace recovery — the explicit tradeoff

Because there is no login, losing the owner token loses the workspace. The **only** mitigations, and their cost, are:

- **One-time recovery code** shown **once** at create time, surfaced forcefully (a modal the user must acknowledge: "Save this — it is the only way back in. We cannot recover it for you."). It is a capability secret, treated like the owner token: generated with the CSPRNG, stored **hashed**, never re-displayable, delivered/entered via fragment, never logged.
- **Recovery secret in the URL fragment** of a recovery link (never a path segment, never sent to the server until the user explicitly redeems it, never logged).

**Documented tradeoff (honest by design):** convenience vs. durability. We deliberately do **not** offer email-based account recovery in v1 because that would require collecting and storing identity (PII) and reintroduce an account system the product is explicitly built to avoid. The cost of this choice is **irrecoverable orphaning** on key loss. Staff tooling can resolve a `support_id` to a projection for *support context* but **cannot grant access** — there is no staff override that hands out a token, because such an override would itself be a takeover backdoor. This limitation is stated to the user at create time so expectations match reality (PRD §21, §29). See [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) for the support-ID resolution flow.

---

## 3. Read-only export & access boundary

- Read-only holders (`view_slug` / role links) **may** view the projection and download the `.xlsx` and Board Packet — these contain nothing beyond what the read view already shows (PRD §20). This is not a leak.
- Whether export is **gated behind the paid expert-review event** is a **business-model toggle** (PRD §3), a config decision, not an access-control bug. The access layer always permits read+export at the read scope; a separate, clearly-labeled gate (terms acceptance, paid flag) may sit in front of it.
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
| Intent → CRM | `CRM_API_KEY` | Intent capture disabled; no CRM push |
| Backup replication | `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `LITESTREAM_REGION` | **See the critical note in §11** — in production these should be treated as effectively required (loud health-check) so replication is never silently off |
| Observability | `SENTRY_DSN` | No error reporting |

### 4.3 Rules

- **No fallback chains.** A required secret is required; do not silently substitute another secret or a default. (timpager's regression #21: env read at call time, never cached at module load, never a fallback chain.)
- **AI keys are the only "at least one" rule.** Everything else required is required outright.
- Accidentally committed a secret? **Rotate it immediately** — deleting the commit is not enough. Then re-scan history.
- Generic errors to clients: never echo internal IDs, file paths, stack traces, or key fragments in an API error body.
- The **browser never holds a provider key.** All Places/Census/Anthropic/OpenAI/GitHub/CRM calls are server-side only (PRD §23). The frontend talks only to our own API.

---

## 5. XSS & rich-text sanitization

The narrative `body_md` (PRD §24) is **user-editable and rendered as HTML**. The evidence panel renders user-supplied source titles/notes. With bearer tokens in `localStorage`, a single stored XSS = token theft = full takeover. Therefore:

- **Server-side allowlist sanitization** of `body_md` and any user rich text (evidence labels/notes, projection name, justification notes that travel into the packet) **before storage** (`narratives.body_md` is stored already-sanitized) **and** defense-in-depth on render.
- Use an allowlist sanitizer (e.g. **`bleach`** for Python server-side; **DOMPurify** if any sanitization happens client-side as belt-and-suspenders). Allowlist a minimal Markdown-rendered tag set (`p`, `ul`/`ol`/`li`, `strong`, `em`, `a` with `href` restricted to `http`/`https`/`mailto`, headings, `blockquote`, `code`). **Strip** all `<script>`, all `on*` event-handler attributes, `style` attributes, `javascript:` URLs, `<iframe>`/`<object>`/`<embed>`, and inline SVG.
- Sanitization is **not** the same as numeric grounding (§6) — both apply to narrative: grounding ensures every *figure* is real; sanitization ensures no *markup* is dangerous.
- The projection name and org name flow into Excel/Word filenames and cell text — they must be treated as untrusted (no path traversal via `org_name`; see §12).

---

## 6. Mutations: concurrency, no-CSRF, and grounding invariants

### 6.1 Optimistic concurrency (every mutation)

Autosave (PRD §19.3) means high write frequency on one row, and shared edit links mean concurrent editors. Therefore **every mutating endpoint requires both**:

```
Authorization: Bearer <owner-or-edit token>
If-Match: <version>
```

- `version` is a monotonic integer per projection (PRD §24). The UPDATE is `… SET version = version + 1, … WHERE id = ? AND version = ?`. A **0-row** result → **HTTP 409** with `{error, current_version, current_state}` so the UI can offer reload / overwrite / save-as-copy (PRD §19.4).
- The new version is returned in the body and as an `ETag`-style header.
- A `409` must be a **real** conflict response, not cosmetic. The frontend tracks the server version from every computed response and never blind-overwrites.
- Autosave is debounced client-side; the server serializes writes (single-writer WAL, §11) and writes **one revision snapshot per settle** (PRD §24). Revision growth is bounded — see [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) retention policy.

### 6.2 No CSRF — keep it that way

Mutations authenticate via the `Authorization: Bearer` header, **not** a cookie. Because no ambient credential is attached by the browser, cross-site requests cannot forge authenticated mutations → **no CSRF**. **Do not introduce a cookie, a session, or any ambient credential.** If you find yourself reaching for `Set-Cookie`, stop — it reintroduces a class of attack the design eliminated (PRD §20).

### 6.3 LLM injection defense & grounding (testable invariants, not prompt wishes)

The research and narrative subsystems are the app's trust surface. These are **hard server-side validators that fail the response**, enforced by CI tests (PRD §16, §17):

1. **Untrusted-data framing.** All web/research snippet text passed to a model is wrapped as untrusted **data** with an explicit system instruction to *extract facts only and ignore any embedded instructions*. Strip injection markers (`ignore previous instructions`, `system:`, role-switch tokens) before the model sees them — borrow timpager's `sanitizeForPrompt` pattern: strip markers, cap input tokens, log sanitization events (pattern + timestamp, **never the full input**).
2. **Citation rejection.** The research LLM extracts only from server-fetched snippets and **cannot introduce a citation that was not server-fetched.** Any returned citation URL not in the server's fetched source set is **rejected** (PRD §16.2).
3. **Numeric grounding.** Every figure appearing in narrative prose **must exist** in `computed_json` / approved facts. Post-generation validation rejects any prose containing an ungrounded number (PRD §17). This protects the board packet from hallucinated figures.
4. **Stale handling.** `narratives.computed_hash` is stored at generation; if figures change, surface "Out of date" + diff + Regenerate — **never auto-overwrite user-edited prose** (PRD §17).

These tests must be **adversarial**: feed a hallucinated figure → assert rejection; feed an unfetched citation → assert rejection; feed `ignore previous instructions` web text → assert it is stripped/ignored. A happy-path-only test gives false safety.

### 6.4 AI opt-out must actually work

The app must **compute, save, and export `.xlsx`** with **zero AI calls** (manual rent, no narrative) — PRD §21. This is verified by a test that runs the full create → compute → save → export flow with **all AI keys unset**. Compute is server-authoritative and AI-independent (the math engine has no network/LLM dependency).

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
  connect-src 'self' https://api.anthropic.com https://api.openai.com;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'none';
  form-action 'self';
```

- **No `'unsafe-inline'` in `script-src`.** The build must not emit inline `<script>` blocks or inline `on*=` handlers; the bundler outputs hashed `.js` files served from `'self'`. If a third-party requires inline script, use a nonce — never blanket `'unsafe-inline'`.
- `connect-src` enumerates **only** `api.anthropic.com` and `api.openai.com` (the browser never talks directly to providers, but these are listed for resilience/observability hooks). **Places, Census, GitHub, and CRM are server-to-server only — they are intentionally absent from `connect-src`** (the browser never connects to them).
- `frame-ancestors 'none'` is the modern clickjacking defense (equivalent to `X-Frame-Options: DENY`).
- `style-src 'self'` — design tokens are shipped as a real CSS file, not inline `style=` attributes (this also aligns with the design system in [`ARCHITECTURE.md`](ARCHITECTURE.md)).

### 8.2 CORS — locked to the app origin

- `Access-Control-Allow-Origin` is the **exact app origin** (the production hostname in the thriftly.com project), not `*`, not a reflected `Origin`.
- Allow only the methods/headers the API uses (`GET, POST, PATCH, DELETE`; `Authorization`, `If-Match`, `Content-Type`).
- No `Access-Control-Allow-Credentials` is needed (no cookies). Do not enable it.

### 8.3 No-index

Every response carries `X-Robots-Tag: noindex, nofollow`, and the app serves a `robots.txt` with `Disallow: /`. Projections are private capability-scoped documents; they must never be indexed (PRD §20). The owner-scoped list page and all `/{view_slug}` routes are no-index.

### 8.4 HTTPS / HSTS

- All traffic is HTTPS (TLS terminated at Railway's edge). HTTP is redirected to HTTPS.
- Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` (consider `preload` only after a stable HTTPS-only period).

---

## 9. Feedback redaction (Idea Fab) + support IDs

Bugs go to GitHub (the "idea fab"), which **may be a public repo**. Therefore the GitHub payload is **provably scrubbed** (PRD §22, [`IDEA_FAB.md`](IDEA_FAB.md)):

- **Never** include `view_slug`, owner/edit token, any resolvable projection URL, or **any financial field** in the GitHub issue.
- The user is shown a random **`support_id`** (the `feedback.support_id` column). Only server-side staff tooling resolves `support_id → projection` (and that resolution grants *context*, not *access* — see §2.7).
- Auto-context is **non-sensitive only**: route, app version, `model_version`, `support_id`, timestamp.
- UI notice: "Don't paste sensitive financial details." The `feedback` table itself stores **no financial fields and no projection link** (PRD §24).
- **CI test (mandatory, non-regressable):** construct a feedback submission from a fully-populated projection and assert the outbound GitHub payload contains no `view_slug`, no token, no `http(s)` projection URL, and none of the financial field names. This is risk #1 and must be impossible to regress.
- **Intent → CRM** (email, role, reason, timeline, review request, follow-up consent, PRD §6.1/§22) is a **separate** path with explicit consent; it never carries the projection's financial detail and is gated by the optional `CRM_API_KEY`.

---

## 10. Rate limits & audit logging

### 10.1 Rate limits (per IP **and** per token)

Tokens are free to mint, so abuse and cost-amplification are open without limits. Cap the expensive/abusable endpoints on **both** dimensions (per-IP catches anonymous floods; per-token catches a single workspace hammering paid APIs). Starting template (tune against real usage; mirror timpager's explicit numbers as a starting point):

| Endpoint | Why limited | Starting limit (per IP) | Starting limit (per token) |
|---|---|---|---|
| `POST /api/research` | LLM + Places + Census cost | 10 / hour | 20 / hour |
| `POST …/narrative:regenerate` | LLM regeneration cost (PRD §27 cap) | 10 / hour | 20 / hour, hard cap per projection/day |
| `POST /api/feedback` | GitHub-issue spam | 5 / hour | 10 / hour |
| `POST /api/intent` | CRM spam | 5 / hour | — |
| `POST /api/projections` (create) | token-mint flood | 20 / hour | — |

- Research and narrative results are **cached** (PRD §16.6) — caching is also a cost brake, not only a latency win.
- Exceeded limit → `429` with a `Retry-After` header; never a 500.
- Compute itself (PATCH recompute) is cheap (<50 ms target) and AI-free; it is concurrency-bounded by the single-writer DB, not rate-limited per keystroke (the client debounces).

### 10.2 Audit / access log

The `revisions` table (`actor_token_hash`, `change_summary`, `created_at`, PRD §24) plus an access-event log records, for forensics and the "show access events" compromise view (PRD §20):

- **Mutations** (who/when via `actor_token_hash`, what changed).
- **Token rotations** (§2.6).
- **Exports** (`.xlsx`, packet) and **share-link access** events.

Log `actor_token_hash`, **never** the plaintext token. The audit log must never contain a secret. This is what lets a compromised owner see "access events" after rotating.

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

- **No secret in code, logs, or responses** (log-redaction test; `Authorization`/fragments never logged).
- **Mutation safety quad** on every PATCH/POST: (1) bearer-token auth required, (2) owner/slug-scope isolation (never global list, never cross-owner read/write), (3) `If-Match` optimistic-concurrency **409-on-stale**, (4) a negative/abuse path (rate limit per IP+token).
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

1. Does it mutate? → require `Authorization: Bearer` (≥ edit) **and** `If-Match: <version>`; return 409 on stale. (Owner-only for rotate/delete/trash.)
2. Is it owner-scoped? → filter by the resolved token; **never** return another owner's data; list is never global.
3. Any secret in the path/query? → **no.** Secrets only in header/fragment. No `:token` path param.
4. Does it call an LLM or fetch the web? → untrusted-data framing, citation rejection, numeric grounding (LLM); SSRF block-list + redirect re-validation (fetch).
5. Is it expensive/abusable? → rate limit per IP **and** per token; cache where possible.
6. Does it render user input? → server-side allowlist sanitize before store and on render.
7. Does it touch feedback/GitHub? → run the redaction test; only `support_id` + non-sensitive context.
8. Does it write a file? → server-owned path, type/size limits, non-executable content-type, `Content-Disposition: attachment`.
9. Did you log anything? → no `Authorization`, no fragment, no token, no financial field; `actor_token_hash` only.
10. New secret/env var? → add it to `app/env_requirements.py`, classify required vs optional, update §4 of this doc in the same PR (Docs Are Code).

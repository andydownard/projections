# Plan — Clerk satellite auth for `projections` (shared session with rallytasks.com)

**Status:** PROPOSED — **needs explicit owner sign-off (see §0 Hard-Rule override) before any code.**
**Author:** staff-eng planning pass, 2026-06-27.
**Scope:** add Clerk authentication to `projections` (projections.thriftly.com) using the **same Clerk instance** that rallytasks.com (the `timpager` repo) already runs, with projections configured as a **Clerk satellite domain**. **This is a planning artifact only — no auth code ships from this PR.**

> **Read this plan against:** [CLAUDE.md](../../CLAUDE.md) "Hard rules" + "Regression registry" #11, [SECURITY.md](../../SECURITY.md) §2 (capability-token model) / §6.2 (no-CSRF) / §8 (CSP/CORS), [DATA_MODEL.md](../../DATA_MODEL.md) (`projections` table), [API_SPEC.md](../../API_SPEC.md). The cross-app contract on the primary side lives in `timpager` at `/Users/andydownard/projects/timpager/docs/identity-contract.md`.

---

## 0. THE HARD-RULE OVERRIDE (sign-off gate — read first)

This plan **intentionally overrides a documented Hard Rule.** It must not proceed to code until the owner signs off and the governing docs are amended **in the same PR as the first code change.**

CLAUDE.md "Hard rules" and the project-facts table say, verbatim:

> **Access model — No login. Capability tokens.** Owner bearer token (≥256-bit) in `localStorage`; `view_slug` (≥128-bit) is the lookup key; edit/role secrets via URL fragment. **No cookies ⇒ no CSRF** (PRD §20).
> **Capability-token auth, no cookies.** … **Do NOT introduce a cookie/session** (re-adds CSRF the PRD designs out).

Regression registry **#11**: *"Cookie/session reintroduced → Bearer-token only — no CSRF surface (§20)."*

Adding Clerk introduces **login + a Clerk session cookie (`__session`) on projections.thriftly.com**. That is a direct change to the "no login, no cookies" access model. **This plan does NOT silently violate the rule — it proposes amending it.** The technical design below (§3) preserves the *no-CSRF-on-our-API* property by keeping our FastAPI **header-Bearer-only and cookie-blind**, but the documented Hard Rule still must be rewritten and re-signed. **Precedence note:** CLAUDE.md/AGENTS.md Hard Rules and PRD §20 are authoritative today; this plan supersedes the "no login/no cookies" clause **only after** the owner approves and §6 doc edits land. Absent sign-off, the capability-token model stands and this plan is shelved.

**What the owner is signing off on (one decision):** *"Projections gains an optional, feature-flagged Clerk login for the OWNER/editor — reusing the rallytasks.com Clerk identity — while public share links (view/edit/role) stay no-login capability tokens. The Clerk session cookie may exist in the browser, but our API stays Bearer-header-only so there is still no CSRF surface on our endpoints."*

---

## 1. Recommended architecture (the decision)

**COEXIST, do not replace. Clerk gates the OWNER/editor identity; capability share-links stay for unauthenticated viewers.**

- **Clerk = the owner/editor identity.** The person who *creates and owns* projections signs in via Clerk (the same account they use on rallytasks.com). Owner-scoping is keyed on the **Clerk `userId` (and `orgId` when org-scoped)** instead of (or, during migration, in addition to) the hashed owner bearer token. The owner-scoped list (`GET /api/projections`) filters by `owner_clerk_user_id` / `owner_org_id`.
- **Capability tokens stay for everyone who does NOT log in.** `view_slug` (read), role links (board/funder/advisor), and the fragment-delivered **edit token** remain exactly as today. **The product's whole value is sharing a board/funder-ready case with people who will never create an account** — those holders MUST keep working with zero login. This is non-negotiable and is why "Clerk replaces all tokens" is rejected.
- **Satellite, not a second instance.** projections.thriftly.com is registered as a **Clerk satellite domain** of the rallytasks.com production instance, so a user already signed in on rallytasks.com is signed in on projections with no second login, and the same `pk_live_…` publishable key + same JWKS/issuer are reused.
- **The no-CSRF property is preserved by design (§3).** Our FastAPI verifies a **short-lived Clerk session JWT presented in the `Authorization: Bearer` header** (minted client-side via `clerk.session.getToken()`), verified **networklessly against Clerk's JWKS** — exactly the `timpager` `lib/clerk-jwt-verify.js` pattern. **Our API never reads the `__session` cookie.** Because our endpoints still carry no ambient browser credential, a cross-site request cannot forge an authenticated mutation → still no CSRF. The Clerk cookie exists only for the clerk-js browser SDK's own session sync, never for our API.

**Why not "Clerk replaces the owner token entirely":** boards/funders/advisors (the buyers and the people the ED shares with) must view and download the packet with no account. Forcing Clerk on them destroys the core sharing flow (SECURITY.md §3, PRD §6.2/§20). **Why not "Clerk for everything including a cookie-trusting API":** that re-adds CSRF and throws away SECURITY.md §6.2 for no benefit — the Bearer-header path gives us logged-in identity *and* keeps no-CSRF.

**Owner-scope key precedence (the new resolution order in `app/deps.py`):**
1. `Authorization: Bearer <clerk_session_jwt>` → verify via JWKS → owner = `(clerk_user_id, org_id)`. Highest scope = **owner** over rows where `owner_clerk_user_id`/`owner_org_id` match.
2. `Authorization: Bearer <capability_token>` (opaque, not a JWT) → existing SHA-256 + `hmac.compare_digest` against `owner_token_hash` → `edit_token_hash` → role hashes (unchanged).
3. `view_slug` path / role slug → read scope (unchanged).
4. else → `anonymous`.

A presented Bearer is routed to (1) vs (2) by **shape**: a Clerk session token is a JWT (three base64url segments, decodable header with `alg: "RS256"` + `kid`); a capability token is an opaque `secrets.token_urlsafe` string with no JWT structure. Misclassification fails closed (verify fails → fall through to capability compare → `anonymous`).

---

## 2. The timpager / Clerk pattern projections must mirror (research findings)

Source repo: `/Users/andydownard/projects/timpager` (this IS rallytasks.com, the **primary** Clerk domain). Key files and the exact contract:

| Concern | timpager file | What projections mirrors |
|---|---|---|
| Backend SDK | `package.json` → `@clerk/backend@^3.4.4` | projections is Python; we **do not** use `@clerk/backend`. We re-implement the **JWKS verifier** (`lib/clerk-jwt-verify.js`) in Python (`app/clerk.py`). |
| **Networkless JWKS verifier (the reuse target)** | `lib/clerk-jwt-verify.js` — `verifyClerkSessionToken`: RS256 only, finds JWK by `kid`, pins `kty=RSA/use=sig/alg=RS256`, **issuer mandatory** (`claims.iss === opts.issuer`, throws if unset), enforces `exp` (+`nbf`/`aud`/`azp` allowlists), returns `{clerkUserId: claims.sub, claims}`. JWKS at `<issuer>/.well-known/jwks.json` (`routes/identity-v1.js:525`). | `app/clerk.py.verify_clerk_session_token()` — identical checks; issuer mandatory + fail-closed; `azp` allowlist includes `https://projections.thriftly.com`. |
| Full-SDK request auth (NOT used by us) | `lib/clerk.js` — `createClerkClient({secretKey,publishableKey,jwtKey})` + `authenticateRequest(request)`, reads `__session` cookie OR `Authorization: Bearer`, `COOKIE_NAME='__session'`. | We deliberately **avoid** this path (needs `CLERK_SECRET_KEY`; reads cookie). JWKS-only, header-only. |
| Composite resolver / kill switch | `lib/session-resolver.js` — Clerk on iff `CLERK_ENABLED==='1'`; Clerk **config/SDK error fails CLOSED** (never legacy); optional `CLERK_DUAL_ACCEPT` transitional fallback. | `app/deps.py` resolution order (§1): Clerk JWT → capability token → anonymous; Clerk verify error fails closed to capability/anonymous. `CLERK_ENABLED` kill switch. |
| Env requirements | `lib/env-requirements.js` — `CLERK_ENABLED`, `CLERK_SECRET_KEY`*, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`*, **`CLERK_JWT_ISSUER` (mandatory, fail-closed)**, optional `CLERK_JWT_KEY`/`CLERK_DUAL_ACCEPT`/`CLERK_JWT_LEEWAY_SECONDS`. | projections env (§5): **`CLERK_JWT_ISSUER`, `CLERK_PUBLISHABLE_KEY`, `CLERK_ENABLED`, `CLERK_DOMAIN`, `CLERK_SIGN_IN_URL`, `CLERK_AUTHORIZED_PARTIES`** + optional leeway. **No `CLERK_SECRET_KEY`, no webhook secret** on projections (see *). |
| **Frontend API / instance domain** | CSP allowlist `lib/security.js:80` → **`https://clerk.rallytasks.com`** (prod FAPI) + `https://*.clerk.accounts.dev` (dev) + clerk-js from `https://cdn.jsdelivr.net`. Avatars `https://img.clerk.com`. | projections CSP must allowlist the SAME origins (§Phase 4). `CLERK_JWT_ISSUER=https://clerk.rallytasks.com` in prod. |
| Frontend mount | `public/js/auth-clerk.js` — vanilla `clerk-js@5` via CDN, `new Clerk(pk).load()`, `mountSignIn(node,{forceRedirectUrl:'/app'})`. Discovery endpoint `routes/auth-config.js` `GET /api/auth/config` returns `{auth_method, clerk_publishable_key}`. | projections is a **React SPA** → use **`@clerk/clerk-react` `<ClerkProvider isSatellite domain signInUrl>`** bundled by Vite (keeps `script-src 'self'` for our own JS; FAPI hot-load is allowlisted, §Phase 4). Publishable key served by a projections discovery endpoint `GET /api/auth/config`. |
| Identity mapping | `users.clerk_user_id ↔ rally_user_id` (1:1); resolve order clerk→phone→email (`lib/session-resolver.js`); `POST /api/v1/identity/resolve` (gated by `ADMIN_API_KEY` + optional Bearer JWT verify) returns canonical `rally_user_id`; `cache_ttl_seconds:300`. No org support (user-only). Superadmin from `public_metadata.role` only. | v1: projections keys its own owner scope on **`clerk_user_id`** directly (no cross-call). **Optional later:** resolve to `rally_user_id` via the primary's `/api/v1/identity/resolve` (needs a shared service token). Org support: store `org_id` now, scope on it later. |
| Security guardrail | `docs/security/2026-06-20-sso-auth-security-review.md` finding **C1: daughters/satellites never hold a Clerk secret** (JWKS-only); azp/origin enforcement gap flagged. | projections holds **no Clerk secret**; verifies JWKS-only; **enforces `azp`** (closing the gap the primary review flagged). |

\* `CLERK_SECRET_KEY` and `CLERK_WEBHOOK_SIGNING_SECRET` are **primary-only** (timpager). projections is a satellite/daughter and must **not** hold them (security finding C1).

**The exact satellite contract (frontend):**
```tsx
<ClerkProvider
  publishableKey={pk}                 // SAME pk_live_… as rallytasks.com (served by /api/auth/config)
  isSatellite                          // REQUIRED — marks this app a satellite
  domain="projections.thriftly.com"    // this satellite's host
  signInUrl="https://www.rallytasks.com/refer"  // primary hosts sign-in; satellites cannot
>
```
Unauthenticated owners are bounced to the **primary** sign-in, authenticate there, and are redirected back to projections. Per-API-call auth uses `clerk.session.getToken()` → short-lived JWT → `Authorization: Bearer`.

**The exact satellite contract (Clerk dashboard + DNS), an OPS deliverable:**
1. In the **rallytasks.com production Clerk instance** → Domains → Satellites → add `projections.thriftly.com`.
2. Add the **CNAME** records Clerk shows for the satellite (typically `clerk.projections.thriftly.com → <clerk FAPI target>`); verify until green.
3. Add `https://projections.thriftly.com` to the instance's **allowed origins** and the primary sign-in **redirect allowlist** so the post-auth bounce-back is permitted.
4. Reuse the **same production publishable key + same JWKS/issuer** — do **not** create a second instance.

---

## 3. How the core tension resolves (cookies vs no-CSRF)

| Concern | Today (capability tokens) | With Clerk satellite (this plan) |
|---|---|---|
| Owner identity | hashed owner bearer in `localStorage` | Clerk `userId`/`orgId` from a verified session JWT |
| What our API trusts | `Authorization: Bearer <opaque token>` only | `Authorization: Bearer <clerk JWT **or** opaque token>` only — **still header-only** |
| Cookie read by our API | none | **none — our FastAPI is cookie-blind by invariant** |
| CSRF surface on our API | none (no ambient credential) | **none** — Clerk's `__session` cookie is never trusted by our API; only clerk-js reads it |
| Viewers (board/funder) | `view_slug` / role link, no login | **unchanged**, no login |

**The invariant that keeps no-CSRF true (and must be a CI test):** *the projections FastAPI app reads auth ONLY from the `Authorization` header and NEVER from `request.cookies`. A request carrying a valid `__session` cookie but no `Authorization` header resolves to `anonymous`.* This is the single line that lets us add login without re-adding CSRF, and it directly answers Regression #11. clerk-js still sets `__session` for its own session-sync handshake (we cannot prevent that on a satellite), but it is inert against our endpoints.

**Residual CSRF/abuse considerations (must be documented in SECURITY.md update):**
- The owner-app routes are now reachable by a logged-in user; ensure CORS stays locked to the exact app origin (SECURITY.md §8.2) and `Access-Control-Allow-Credentials` stays **off** (we send no cookies to our API).
- The short-lived Clerk JWT in `Authorization` is XSS-exfiltratable the same way the owner token is today — XSS hardening (SECURITY.md §5, allowlist-sanitize, enforcing CSP) remains the primary defense and gets *more* important. Clerk tokens are short-lived (≈60s) which is strictly better than the long-lived owner token for blast radius.

---

## 4. Global Constraints (copied verbatim — survives compaction)

From **CLAUDE.md "Hard rules"** and **SECURITY.md** (the clauses this plan touches or must not break):

- **Capability-token auth, no cookies.** Owner ≥256-bit, `view_slug` ≥128-bit, generated with a CSPRNG (`secrets.token_urlsafe`), stored **hashed** (SHA-256), compared **constant-time** (`hmac.compare_digest`). Secrets only in `localStorage` + URL fragment; **never in path/query/logs**; scrub the fragment after read. **Do NOT introduce a cookie/session** (re-adds CSRF the PRD designs out). Lists are **owner-scoped**, never global; never allow cross-owner read/write (PRD §20). — *This plan AMENDS this clause for the owner/editor identity only (§0). It must be rewritten in the same PR as the first code change; capability tokens for viewers are PRESERVED verbatim.*
- **No CSRF — keep it that way (SECURITY.md §6.2).** Mutations authenticate via the `Authorization: Bearer` header, **not** a cookie. **Do not introduce a cookie, a session, or any ambient credential** *that our API trusts*. — *Preserved: our API stays Bearer-header-only and cookie-blind (§3).*
- **Every mutation needs `Authorization: Bearer` + `If-Match: <version>`.** Optimistic concurrency `UPDATE … SET version=version+1 WHERE id=? AND version=?`; 0 rows → **409** with current state. — *Unchanged. Clerk identity slots into the Bearer slot; If-Match/409 untouched.*
- **No secrets in paths, queries, or logs (SECURITY.md §2.5).** Never log `Authorization`. — *The Clerk JWT is an `Authorization` value: it inherits the existing redaction allowlist; add a test that a Clerk JWT never appears in logs.*
- **Boot-refuse policy (SECURITY.md §4 / config.py).** In production the server refuses to boot if a required var is unset — **no fallback chains, no silent defaults** (timpager regression #21). — *`CLERK_JWT_ISSUER` + `CLERK_PUBLISHABLE_KEY` become required-when-`CLERK_ENABLED` via the same `app/config.py` mechanism. `CLERK_SECRET_KEY` is NEVER set on projections.*
- **The browser never holds a provider key; CSP is enforcing, no inline script (SECURITY.md §8.1).** — *Clerk widens `script-src`/`connect-src`/`frame-src`/`img-src` to the Clerk FAPI origins (§Phase 4). This is a real relaxation of the day-one strict CSP and is a named security tradeoff requiring sign-off.*
- **DB discipline (CLAUDE.md).** Additive-only migrations (`ALTER TABLE ADD COLUMN`); never DROP/recreate; app-generated string PKs; no SQLite-only SQL above the `Store` interface; pre-migration Litestream snapshot; the additive-migration lint gate (`scripts/migration_lint`) must stay green. — *The `owner_clerk_user_id`/`owner_org_id` columns are additive only.*
- **TDD is the Iron Law (CLAUDE.md / AGENTS.md §6).** No production code without a prior failing test; the **Mutation Safety quad** (bearer auth, owner-scope isolation, If-Match/409, negative/abuse+rate-limit) on every mutation. — *Every phase below is RED-first; the auth-dependency change re-runs the full Mutation Safety quad with Clerk identities.*

---

## 5. Config / env additions (`app/config.py`, SECURITY.md §4)

Add to the single-source env module, gated on the `CLERK_ENABLED` kill switch (mirrors timpager's call-time read, no module-load caching, no fallback chains):

| Env var | Required when | Purpose | Notes |
|---|---|---|---|
| `CLERK_ENABLED` | optional (default off) | Kill switch. Strict truthy (`1`/`true`/`yes`). Read at call time. | Off ⇒ behavior identical to today (pure capability tokens). |
| `CLERK_JWT_ISSUER` | **required when `CLERK_ENABLED`** (prod fail-closed) | Expected `iss`; JWKS at `<issuer>/.well-known/jwks.json`. | `https://clerk.rallytasks.com` (prod) / `https://<slug>.clerk.accounts.dev` (dev). |
| `CLERK_PUBLISHABLE_KEY` | **required when `CLERK_ENABLED`** | `pk_live_…` shipped to browser via `GET /api/auth/config`. | SAME key as rallytasks.com. Not secret, but config-required. |
| `CLERK_DOMAIN` | required when `CLERK_ENABLED` | Satellite host for `<ClerkProvider domain>`. | `projections.thriftly.com`. |
| `CLERK_SIGN_IN_URL` | required when `CLERK_ENABLED` | Primary's absolute sign-in URL for `<ClerkProvider signInUrl>`. | e.g. `https://www.rallytasks.com/refer`. |
| `CLERK_AUTHORIZED_PARTIES` | required when `CLERK_ENABLED` | `azp` allowlist for JWT verify (closes timpager's flagged gap). | CSV incl. `https://projections.thriftly.com`. |
| `CLERK_JWT_LEEWAY_SECONDS` | optional | Clock-skew leeway for `exp`/`nbf` (default 10s). | Mirrors timpager default. |
| ~~`CLERK_SECRET_KEY`~~ | **NEVER on projections** | — | Primary-only (security finding C1). A boot check should **refuse to boot if it is set** on projections, as a guardrail. |
| ~~`CLERK_WEBHOOK_SIGNING_SECRET`~~ | **NEVER on projections** | — | Webhooks are the primary's job. |

(Optional future) `RALLY_IDENTITY_API_BASE` + `RALLY_IDENTITY_API_TOKEN` if/when projections resolves `clerk_user_id → rally_user_id` against the primary's `/api/v1/identity/resolve`. **Out of v1 scope** — keep owner scope keyed on `clerk_user_id` locally.

---

## 6. Files touched (the full change surface — for the implementing PRs, not this docs PR)

- **`app/clerk.py`** (NEW) — JWKS fetch+cache, `verify_clerk_session_token(token, *, issuer, authorized_parties, leeway)` → `{clerk_user_id, org_id, claims}` or raise; mirrors `timpager/lib/clerk-jwt-verify.js`.
- **`app/config.py`** — add the §5 vars to `_missing_required` (gated on `CLERK_ENABLED`); add the "refuse to boot if `CLERK_SECRET_KEY` is set" guardrail; expose `clerk_config(env)`.
- **`app/deps.py`** — extend the auth primitives: a `resolve_bearer_identity()` that shape-routes a Bearer to Clerk-JWT verify vs capability compare; expose `owner_scope_key` `(clerk_user_id|org_id)`; **never read cookies**.
- **`app/routers/projections.py`** — `_bearer`/`_is_owner`/`_require_owner` and the list/create/PATCH/rotate paths resolve owner via Clerk identity when present, else capability token; list query filters by `owner_clerk_user_id`/`owner_org_id` when Clerk-authenticated.
- **`app/routers/` discovery** (NEW small route) — `GET /api/auth/config` → `{clerk_enabled, clerk_publishable_key, clerk_domain, clerk_sign_in_url}` (public, cache 60s; mirrors timpager `routes/auth-config.js`).
- **`app/store/base.py` + `sqlite.py` + `postgres.py` stub** — `list_by_owner` / `list_card_summaries` gain a Clerk-identity variant (or a unified `owner_ref`); `create_projection` accepts `owner_clerk_user_id`/`owner_org_id`; new `claim_projection(view_slug, owner_token, clerk_user_id/org_id)`.
- **`app/store/migrations/00NN_clerk_owner.sql`** (NEW, additive) — `ALTER TABLE projections ADD COLUMN owner_clerk_user_id TEXT; ADD COLUMN owner_org_id TEXT;` + `CREATE INDEX idx_projections_clerk_owner ON projections(owner_clerk_user_id, status, updated_at DESC);` (and an `org` index). Pre-migration Litestream snapshot; passes `scripts/migration_lint`.
- **`web/package.json`** — add `@clerk/clerk-react`.
- **`web/src/main.tsx` / `App.tsx`** — wrap the owner app routes in `<ClerkProvider isSatellite domain signInUrl publishableKey>`; the publishable key/domain/sign-in URL come from `GET /api/auth/config`. **Share-link routes (`/{view_slug}`, `/edit#…`, `/r/{slug}`) stay OUTSIDE the provider / do not require sign-in.**
- **`web/src/api/projections.ts` + `client`** — replace `getOwnerToken()`/`localStorage` for the owner path with `await clerk.session.getToken()` → `Authorization: Bearer`. Keep the capability-token send path for view/edit/role pages. Keep a **claim bridge**: on first sign-in, if a legacy `localStorage` owner token exists, POST it to `claim_projection`.
- **`app/main.py`** — CSP/CORS header builder widened for Clerk origins (§Phase 4).
- **Docs (same PR as first code):** `SECURITY.md` (§2 model amended, §4 env table, §6.2 invariant, §8 CSP), `CLAUDE.md` Hard Rules + Regression #11, `DATA_MODEL.md` (`projections` columns + claim flow), `API_SPEC.md` (`/api/auth/config`, `claim`), `OPS_RUNBOOK.md` (Clerk dashboard + DNS satellite setup), `reference/PRD.md` §20 note.

---

## 7. Phased TDD tasks (RED-first; each names test, files, acceptance)

> Every phase is gated by `superpowers:test-driven-development` (write the failing test, watch it fail, minimum code to green, refactor). Mutation-touching phases re-run the **Mutation Safety quad**. Model policy per CLAUDE.md: **standard tier** for the auth-dependency/JWKS work (security-sensitive judgment), **cheapest tier** for the doc-table transcription and the additive migration, **most-capable for the whole-branch security review** at milestone end.

### Phase 0 — JWKS verifier (pure, no app wiring)
- **RED tests** (`app/tests/test_clerk_verify.py`): generate a local RSA keypair in-test; mint JWTs and assert `verify_clerk_session_token` (a) accepts a valid RS256 token with correct `iss`+`azp`+unexpired `exp` → returns `clerk_user_id=sub`, `org_id`; (b) rejects wrong `iss`; (c) rejects `alg=HS256`/`none`; (d) rejects expired (beyond leeway) and accepts within leeway; (e) rejects `azp` not in allowlist; (f) rejects unknown `kid`; (g) **issuer unset → raises** (fail-closed, mirrors timpager). Stub the JWKS endpoint (no network in tests).
- **Files:** `app/clerk.py`.
- **Acceptance:** all RED cases green; `pytest -q` clean; no network in the test; mirrors `timpager/lib/clerk-jwt-verify.js` checks 1:1.

### Phase 1 — config + boot-refuse + the cookie-blind invariant
- **RED tests** (`app/tests/test_config_clerk.py`, `app/tests/test_csrf_cookie_blind.py`): (a) prod + `CLERK_ENABLED` + missing `CLERK_JWT_ISSUER`/`CLERK_PUBLISHABLE_KEY` → `ConfigError` (boot refused); (b) `CLERK_SECRET_KEY` set on projections → boot refused (guardrail); (c) `CLERK_ENABLED` off → no Clerk vars required, boots; (d) **a request with a valid `__session` cookie but NO `Authorization` header resolves to `anonymous`** (the no-CSRF invariant); (e) the request logger never emits a Clerk JWT (redaction).
- **Files:** `app/config.py`, `app/deps.py` (cookie-blind resolution), logging redaction allowlist.
- **Acceptance:** boot-refuse matrix green; the cookie-blind test is the standing **Regression #11 guard**.

### Phase 2 — auth dependency: Clerk identity ⊕ capability token
- **RED tests** (`app/tests/test_deps_auth_resolution.py`): shape-routing — (a) a Clerk JWT Bearer → owner over rows matching `owner_clerk_user_id`; (b) an opaque capability token → existing owner/edit/role resolution unchanged; (c) a malformed/expired Clerk JWT → falls through to capability compare → `anonymous` (fail-closed, no 500); (d) org-scoped JWT → owner over `owner_org_id`; (e) cross-owner isolation — Clerk user A cannot read/list/mutate user B's projections.
- **Files:** `app/deps.py`, `app/routers/projections.py` (`_bearer`/`_is_owner`/`_require_owner`).
- **Acceptance:** Mutation Safety quad re-passes with Clerk identities; cross-owner negative tests green; existing capability-token tests stay green (coexistence).

### Phase 3 — schema migration + owner-scoped list/create/claim
- **RED tests** (`app/tests/test_store_clerk_owner.py`, `app/tests/test_claim_projection.py`): (a) additive migration adds the two columns + indexes and `migration_lint` passes (no DROP/RENAME); (b) `create_projection` with a Clerk owner persists `owner_clerk_user_id`; (c) `list_by_owner` for a Clerk identity returns only that owner's rows, never global; (d) **claim**: a signed-in Clerk user presenting a valid legacy owner token links that row's `owner_clerk_user_id` (version-checked, one revision event, audit), and afterward both the legacy token AND the Clerk identity resolve as owner (until/unless the token is rotated away); (e) claim with a wrong/!owner token → 403, no link.
- **Files:** `app/store/migrations/00NN_clerk_owner.sql`, `app/store/{base,sqlite,postgres}.py`, claim endpoint in `app/routers/projections.py`, `DATA_MODEL.md`.
- **Acceptance:** migration additive + lint-green; pre-migration Litestream snapshot documented in OPS_RUNBOOK; claim is owner-only + version-checked + audited.

### Phase 4 — CSP/CORS widening + discovery endpoint
- **RED tests** (`app/tests/test_security_headers_clerk.py`, `app/tests/test_auth_config_route.py`): (a) when `CLERK_ENABLED`, CSP `script-src`/`connect-src` include `https://clerk.rallytasks.com https://*.clerk.accounts.dev`, `frame-src` includes the FAPI, `img-src` includes `https://img.clerk.com`; **when disabled, CSP stays the strict `'self'`-only baseline** (no relaxation unless Clerk is on); (b) CORS stays exact-origin, `Allow-Credentials` off; (c) `GET /api/auth/config` returns `{clerk_enabled, clerk_publishable_key, clerk_domain, clerk_sign_in_url}` and **never** a secret; cache header present.
- **Files:** `app/main.py` (header builder), discovery route, `SECURITY.md` §8.
- **Acceptance:** CSP relaxation is conditional on the kill switch and is a named, documented tradeoff; no secret in `/api/auth/config`.

### Phase 5 — frontend satellite wiring (component tests)
- **RED tests** (`web/src/**/*.test.tsx`): (a) owner app routes render inside `<ClerkProvider isSatellite domain signInUrl>`; an unauthenticated owner hitting the list is redirected to `signInUrl` (mock Clerk); (b) the API client attaches `Authorization: Bearer <getToken()>` for owner calls; (c) **share-link pages (`/{view_slug}`, `/edit#…`, `/r/{slug}`) render with NO Clerk provider and NO sign-in** — a logged-out viewer sees the projection; (d) the claim bridge: a legacy `localStorage` owner token present at first sign-in POSTs to `claim`.
- **Files:** `web/src/main.tsx`, `App.tsx`, `api/projections.ts`, new `useClerkOwnerToken` hook.
- **Acceptance:** vitest + `tsc --noEmit` green; viewer flow provably login-free; QA at 1440/768/375 (milestone-end).

### Phase 6 — ops: Clerk dashboard + DNS satellite registration (runbook deliverable)
- **Deliverable** (`OPS_RUNBOOK.md` new section): the §2 dashboard steps (add satellite, CNAME, allowed-origins, redirect allowlist), the reuse-same-instance rule, and a verification checklist (a signed-in rallytasks user reaches projections with no second login; a JWT minted on projections verifies against the shared JWKS).
- **Acceptance:** runbook section reviewed; staging satellite verified before prod.

---

## 8. Role lenses required to close this (AGENTS.md §2)
- **`/cso` (OWASP + STRIDE)** — **mandatory and central**: new auth surface, the CSP relaxation, the cookie-blind invariant, the claim flow (account-takeover review), JWKS verification hardening (algorithm-confusion, `kid` confusion, issuer/azp enforcement). This is the gate that most matters.
- **`/review` (staff-eng bug hunt, most-capable)** — the deps resolution-order edge cases (shape mis-routing, fail-closed paths) and the migration.
- **`/design-review`** — the sign-in redirect UX and the share-link-stays-login-free guarantee (a11y of the auth boundary).
- **`/qa`** — real-browser 1440/768/375: owner sign-in, viewer no-login, claim bridge.

## 9. Golden / property tests that must exist at done
- Property: for any Bearer string, `resolve_bearer_identity` returns exactly one of {clerk-owner, capability-owner/edit/role, anonymous} and **never raises a 500** (fuzz malformed JWTs + random tokens).
- Invariant test (standing): **a cookie-only request is `anonymous`** (Regression #11 guard).
- Coexistence: the full existing capability-token test suite stays green with `CLERK_ENABLED` both on and off (no regression to the no-login share path).
- Cross-owner isolation across BOTH key types (token-owned and clerk-owned) — no cross-read/write/list.

## 10. Ops deliverable
OPS_RUNBOOK section for the Clerk satellite (dashboard + DNS + verification), the additive-migration Litestream-snapshot step, and the `CLERK_ENABLED` rollout/rollback runbook (flip off ⇒ instant revert to pure capability tokens, no data migration needed).

---

## 11. Migration & rollout

1. **Ship dark.** Land all phases behind `CLERK_ENABLED=off`. With the flag off, projections is byte-for-byte the capability-token app it is today (proven by the coexistence suite). The additive columns sit unused.
2. **Staging satellite.** Register the satellite on a staging Clerk instance / the prod instance's staging domain; verify shared-session + JWKS.
3. **Enable for owner app only.** Flip `CLERK_ENABLED=on`. New owners sign in via Clerk; their projections are stamped with `owner_clerk_user_id`. **Viewers are unaffected** (no login ever).
4. **Claim legacy workspaces.** Existing token-owned projections stay token-owned and fully functional. A signed-in user who still holds the legacy `localStorage` owner token is offered a one-click **claim** that links the row to their Clerk identity (Phase 3). Unclaimed rows keep working via the owner token indefinitely (coexistence is permanent, not a forced cutover).
5. **Rollback.** `CLERK_ENABLED=off` reverts instantly; clerk-stamped rows are still reachable by their owner token if one was kept, or remain claimable when re-enabled. No destructive migration, so rollback is config-only.
6. **Precedence with global rules.** Until the owner signs off (§0) and the §6 doc edits land, **CLAUDE.md/AGENTS.md Hard Rules and PRD §20 win** — this plan is shelved. After sign-off, the amended Hard Rule (login for owner/editor; capability tokens for viewers; API stays cookie-blind) governs.

---

## 12. Risks + open questions for the owner

**Biggest risks**
1. **Hard-Rule override (P0 governance).** This supersedes the documented "no login, no cookies" access model (CLAUDE.md, SECURITY.md §2, PRD §20, Regression #11). **Requires explicit owner sign-off** and a same-PR rewrite of those docs. Shipping code before that is a process violation.
2. **CSP relaxation (P1 security).** projections ships an *enforcing, `'self'`-only, no-inline* CSP today (SECURITY.md §8.1, a deliberate advantage over timpager). Clerk forces widening `script-src`/`connect-src`/`frame-src` to the Clerk FAPI origins — enlarging the post-XSS exfiltration surface. Mitigation: gate the relaxation on `CLERK_ENABLED`, keep `connect-src 'self'` for our own API, keep XSS sanitization strict. Must be a named, signed-off tradeoff.
3. **Account-takeover via the claim flow (P1).** Linking a legacy token-owned projection to a Clerk identity is a privilege transfer; a stolen owner token could let an attacker claim a workspace into their own Clerk account. Mitigation: claim is owner-token-gated + version-checked + audited; consider requiring rotation-after-claim. `/cso` must review.
4. **Satellite mis-config locks owners out (P2 availability).** Wrong issuer/azp/domain or missing CNAME ⇒ no one can sign in. Mitigation: `CLERK_ENABLED` kill switch (instant revert to capability tokens), staging verification first, fail-closed-to-anonymous (never 500).
5. **JWKS verification footguns (P1).** Algorithm confusion (`alg:none`/HS256), `kid` confusion, missing issuer/azp enforcement (the exact gap timpager's own security review flagged). Mitigation: Phase 0 adversarial tests pin RS256-only + issuer-mandatory + azp-allowlist.
6. **Two owner-identity systems forever (P2 complexity).** Permanent coexistence of `owner_token_hash` and `owner_clerk_user_id` is more surface to reason about. Accepted as the cost of not forcing logins on viewers.

**Open questions (need a human decision before the dependent phase)**
| Question | Blocks | Recommendation |
|---|---|---|
| **Does the owner approve overriding the "no login / no cookies" Hard Rule?** (§0) | everything | **Required sign-off.** Recommend yes, with the cookie-blind-API constraint. |
| **Org vs personal:** scope ownership on Clerk `userId` or `orgId`? | Phase 2/3 schema + list query | v1: key on `userId`, **store `org_id` now**, add org-scoped lists later. Confirm whether rallytasks orgs map to "a nonprofit's team." (Note: timpager is **user-only today** — no org support — so org-scoping would be net-new on both sides.) |
| **Do boards/funders/advisors EVER need accounts?** | the whole coexist-vs-replace decision | **No for v1** — they stay capability-token viewers. Confirm. |
| **Editors:** must a shared *editor* sign in, or keep the fragment edit token? | Phase 2 + Phase 5 | Keep the **edit token** for non-owner collaborators (no login); the *owner* uses Clerk. Confirm. |
| **Resolve to `rally_user_id` or stay on `clerk_user_id`?** | optional future | v1: stay on `clerk_user_id` (no cross-service call). Resolve to `rally_user_id` only if projections must join rallytasks data (needs a shared service token + the primary's `/api/v1/identity/resolve`). |
| **Which primary URL hosts sign-in** for `signInUrl`? | Phase 5 | Confirm the exact rallytasks.com sign-in path (timpager mounts SignIn on `/refer`). |
| **Sign-in/sign-up factors** (phone, Google OAuth) — owned by the shared Clerk dashboard | Phase 6 | Reuse the rallytasks instance's existing factors; no projections-side config. |

---

## 13. Out of scope (YAGNI fences)
- Clerk **webhooks** on projections (user.* sync is the primary's job; projections has no local user table to sync — it keys directly on `clerk_user_id`).
- Holding any **Clerk secret** (`CLERK_SECRET_KEY`, webhook secret) on projections.
- `@clerk/backend` full-SDK `authenticateRequest` (cookie-reading) path — JWKS-only by design.
- Resolving `rally_user_id` / cross-service identity joins (deferred; v1 keys on `clerk_user_id`).
- Forcing any **viewer** (board/funder/advisor) to log in — never.
- Org-scoped lists/teams UI — store `org_id`, build the UI later.
```

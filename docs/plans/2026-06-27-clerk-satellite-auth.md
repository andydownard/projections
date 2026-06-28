# Plan — Clerk satellite auth for `projections` (shared session with rallytasks.com)

**Status:** PROPOSED — **needs explicit owner sign-off (see §0 Hard-Rule override) before any code.**
**Author:** staff-eng planning pass, 2026-06-27.
**Scope:** add Clerk authentication to `projections` (projections.thriftly.com) using the **same Clerk instance** that rallytasks.com (the `timpager` repo) already runs, with projections configured as a **cross-apex Clerk satellite domain** (`thriftly.com ≠ rallytasks.com` — the harder, `pennyai`-style case, **not** the same-apex `vibe101` case; see §2A/§2B). **This is a planning artifact only — no auth code ships from this PR.**

> **Read this plan against:** [CLAUDE.md](../../CLAUDE.md) "Hard rules" + "Regression registry" #11, [SECURITY.md](../../SECURITY.md) §2 (capability-token model) / §6.2 (no-CSRF) / §8 (CSP/CORS), [DATA_MODEL.md](../../DATA_MODEL.md) (`projections` table), [API_SPEC.md](../../API_SPEC.md). The cross-app contract on the primary side lives in `timpager` at `/Users/andydownard/projects/timpager/docs/identity-contract.md`. **Reference daughters (researched for this plan):** `vibe101` (`learn.rallytasks.com`, a *same-apex* sibling — `lib/clerk.js`, `lib/clerk-jwt-verify.js`, `lib/session.js`, `lib/security.js`, `routes/sign-in.js`) and `pennyai`/Groflo (`groflo.io`/`deck.thrift.ly`, a *foreign-apex* daughter exactly like projections — `clerk_auth.go`, `server.go`, `middleware_timpager.go`, `DEPLOYMENT.md`). See **§2A** (reference set + cross-apex specifics) and **§2B** (congruence with Clerk's official satellite guidance).

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
| **Frontend API / instance domain** | CSP allowlist `lib/security.js:80` → **`https://clerk.rallytasks.com`** (prod FAPI) + `https://*.clerk.accounts.dev` (dev) + clerk-js from `https://cdn.jsdelivr.net`. Avatars `https://img.clerk.com`. | projections CSP allowlists the Clerk origins (§Phase 4 + §2A.3). **Cross-apex caveat:** on a satellite the browser's FAPI is the satellite's own `https://clerk.projections.thriftly.com`, while the JWT **`iss` stays `https://clerk.rallytasks.com`** — issuer (verify) and FAPI (CSP) are **different hosts** (§2A.3). `CLERK_JWT_ISSUER=https://clerk.rallytasks.com`. |
| Frontend mount | `public/js/auth-clerk.js` — vanilla `clerk-js@5` via CDN, `new Clerk(pk).load()`, `mountSignIn(node,{forceRedirectUrl:'/app'})`. Discovery endpoint `routes/auth-config.js` `GET /api/auth/config` returns `{auth_method, clerk_publishable_key}`. | projections is a **React SPA** → use **`@clerk/clerk-react` `<ClerkProvider isSatellite domain signInUrl>`** bundled by Vite (keeps `script-src 'self'` for our own JS; FAPI hot-load is allowlisted, §Phase 4). Publishable key served by a projections discovery endpoint `GET /api/auth/config`. |
| Identity mapping | `users.clerk_user_id ↔ rally_user_id` (1:1); resolve order clerk→phone→email (`lib/session-resolver.js`); `POST /api/v1/identity/resolve` (gated by `ADMIN_API_KEY` + optional Bearer JWT verify) returns canonical `rally_user_id`; `cache_ttl_seconds:300`. No org support (user-only). Superadmin from `public_metadata.role` only. | v1: projections keys its own owner scope on **`clerk_user_id`** directly (no cross-call). **Optional later:** resolve to `rally_user_id` via the primary's `/api/v1/identity/resolve` (needs a shared service token). Org support: store `org_id` now, scope on it later. |
| Security guardrail | `docs/security/2026-06-20-sso-auth-security-review.md` finding **C1: daughters/satellites never hold a Clerk secret** (JWKS-only); azp/origin enforcement gap flagged. | projections holds **no Clerk secret**; verifies JWKS-only; **enforces `azp`** (closing the gap the primary review flagged). |

\* `CLERK_SECRET_KEY` and `CLERK_WEBHOOK_SIGNING_SECRET` are **primary-only** (timpager). projections is a satellite/daughter and must **not** hold them (security finding C1).

**The exact satellite contract (frontend):**
```tsx
<ClerkProvider
  publishableKey={pk}                  // SAME pk_live_… as rallytasks.com (served by /api/auth/config; test vs live per env)
  isSatellite                          // REQUIRED — marks this app a satellite
  domain="projections.thriftly.com"    // this satellite's host
  signInUrl="https://accounts.rallytasks.com/sign-in"  // primary Account Portal; satellites NEVER collect creds
  allowedRedirectOrigins={[/* dev vs prod */ "https://projections.thriftly.com"]}  // Clerk-official: allowlist
  // satelliteAutoSync={false}         // OWNER DECISION — true auto-recognizes a primary session (+1 redirect on first visit)
>
```
Unauthenticated owners are bounced to the **primary** sign-in (Account Portal), authenticate there, and are redirected back to projections. **Build the redirect with `buildSignInUrl()`/`buildSignUpUrl()`** (they append `__clerk_synced`) — do **not** hardcode it. Per-API-call auth uses `clerk.session.getToken()` → short-lived JWT → `Authorization: Bearer`. **Disable passkeys** for this flow (registrable-domain-bound). See **§2B** for full Clerk-best-practice congruence.

**The exact satellite contract (Clerk dashboard + DNS), an OPS deliverable:**
1. In the **rallytasks.com production Clerk instance** → Domains → Satellites → add `projections.thriftly.com`.
2. Add the Clerk-issued **CNAME** for the satellite FAPI — `clerk.projections.thriftly.com → frontend-api.clerk.services` — **DNS-only (do NOT proxy / Cloudflare orange-cloud OFF)**; verify until green.
3. Add `https://projections.thriftly.com` to the instance's **allowed origins**, the primary sign-in **redirect allowlist**, and the SDK's **`allowedRedirectOrigins`** so the post-auth bounce-back is permitted.
4. Reuse the **same production publishable key + same JWKS/issuer** — do **not** create a second instance.

---

## 2A. The full Rally reference set — same-apex (vibe101) vs foreign-apex (pennyai)

projections is **not** the first daughter to reuse the rallytasks.com Clerk instance. Two existing apps bracket the problem, and **projections.thriftly.com sits on the harder side of the line.**

| Reference repo | Host(s) | Apex vs rallytasks.com | How the BROWSER gets a Clerk session | How the BACKEND trusts a request |
|---|---|---|---|---|
| **timpager** (primary) | `www.rallytasks.com` | — (it *is* the instance) | hosts sign-in; owns `sk_…` + webhooks | full SDK + JWKS |
| **vibe101** | `learn.rallytasks.com` | **SAME apex** (`*.rallytasks.com`) | shares the `__session` cookie set at `Domain=.rallytasks.com`; hosts its own `/sign-in` drop-in | reads `__session` cookie **or** Bearer, JWKS-only verify (no secret) + a `tp_csrf` double-submit |
| **pennyai / Groflo** | `groflo.io`, `deck.thrift.ly`, `penny.rallytasks.com` | **FOREIGN apex** (`groflo.io`/`thrift.ly`) | cookie does **not** cross the apex → needs a Clerk **satellite handshake** (redirect to `accounts.rallytasks.com`); ships **backend-verify FIRST, handshake later** | JWKS-only verify of whatever JWT is presented, fail-closed, additive |
| **projections** (this plan) | `projections.thriftly.com` | **FOREIGN apex** (`thriftly.com`) | **same as pennyai** — foreign apex, no shared cookie | **JWKS-Bearer only, cookie-blind** (stricter than pennyai) |

**projections is the pennyai case, not the vibe101 case.** Everything below turns on that.

### 2A.1 vibe101 — the `*.rallytasks.com` same-apex pattern (what projections does NOT get to use)

Files (`/Users/andydownard/projects/vibe101`):
- **`lib/clerk.js`** — JWKS-only verification; the `sk_…` secret is used *only* for session **revocation on logout**, never for verify (finding C1). The load-bearing comment: *"the `__session` cookie is set at `Domain=.rallytasks.com` and shared across subdomains."*
- **`lib/clerk-jwt-verify.js`** — the same RS256 / `kid` / **issuer-mandatory** / `exp`+`nbf`-leeway verifier the plan already mirrors (§2). `LEEWAY_SECONDS = 60`. (Note: it does **not** enforce `azp` — see §2B.)
- **`lib/session.js`** — `extractToken()` precedence is **`__session` cookie FIRST, then `Authorization: Bearer`** (line 94). Because the cookie spans the apex, vibe101 is genuinely **cookie-authenticated**, so it must also run a **CSRF double-submit** (`tp_csrf` cookie, *also* set at `Domain=.rallytasks.com`, non-HttpOnly, echoed as `X-CSRF-Token`). **This is exactly the CSRF surface projections refuses to re-add** — and it exists *only* because same-apex cookie-sharing is available to vibe101.
- **`routes/sign-in.js` + `public/js/signin-init.js`** — clerk-js is the **drop-in** (`<script data-clerk-publishable-key=… src=cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js>`) → `Clerk.load()` + `mountSignIn`. **There is NO `isSatellite` / `domain` / `signInUrl` config** — vibe101 is **not a formal Clerk satellite at all.** It is a **same-instance sibling on the shared apex** that hosts its own sign-in and lets the `.rallytasks.com` cookie do the cross-subdomain work.
- **`lib/security.js`** — the CSP Clerk allowlist projections must copy (exact origins in §2A.3).
- **`lib/env-requirements.js`** — `CLERK_JWT_ISSUER` (`https://clerk.rallytasks.com`), `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (revoke-only), `CLERK_WEBHOOK_SIGNING_SECRET`.

**Takeaway:** the vibe101 pattern (share the apex cookie, host your own sign-in, no `isSatellite`) is **unavailable to projections** because `thriftly.com ≠ rallytasks.com`. Copy only vibe101's **JWKS verifier + CSP allowlist + "daughters hold no secret" stance** — **not** its cookie-first `extractToken` and **not** its `tp_csrf` machinery (both are same-apex affordances).

### 2A.2 pennyai / Groflo — the foreign-apex pattern projections SHOULD mirror

pennyai is the production proof that a **different-apex** Rally site can adopt the shared Clerk instance. Files (`/Users/andydownard/projects/pennyai`):
- **`clerk_auth.go`** — the design note is verbatim the projections situation: *"groflo.io is a FOREIGN APEX (different eTLD+1) so it does NOT share the `.rallytasks.com` Clerk session cookie. Full apex SSO needs a Clerk SATELLITE handshake (frontend redirect to `accounts.rallytasks.com`) — a separate, larger step. THIS is only the backend foundation … verify it and map `clerk_user_id → rally_user_id`, ADDITIVELY."*
  - `verifyClerkSession`: `jwt.WithValidMethods(["RS256"])` (no alg-confusion / `none`), `jwt.WithIssuer(CLERK_JWT_ISSUER)`, `jwt.WithExpirationRequired()`, JWKS via `keyfunc` (auto-refresh on unknown `kid`), **fails closed**, **no secret** — a second-language confirmation that the projections `app/clerk.py` checks are the right set.
  - `extractClerkToken`: reads `__session` cookie **or** Bearer (see the divergence note in §2A.4 / §2B).
  - `authenticateClerk` returns **`(session, present, ok)`** — a clean three-state: **no token → fall through to legacy**; **token PRESENT but invalid/resolve-failed → fail closed (401)**, never silently downgrade. **Adopt this contract** in `app/deps.py.resolve_bearer_identity`: a *malformed* Bearer falls through to capability/anonymous, but a *well-formed-but-invalid Clerk JWT on an owner route* should **401**, not silently become `anonymous`.
- **`server.go`** — CORS is a **static origin allowlist** (`{https://vibeflourishing.com, https://deck.groflo.io, https://deck.thrift.ly}`) echoed back only on match, else a safe default; `frame-ancestors` is an explicit allowlist; `connect-src` includes the same-apex alias `https://penny.rallytasks.com`. Mirrors the plan's "CORS exact-origin, `Allow-Credentials` off."
- **`middleware_timpager.go`** — auth precedence: timpager session → **Clerk JWT (present ⇒ authenticate-or-fail-closed)** → legacy cookie. Same ordering shape as the plan's §1.
- **`DEPLOYMENT.md`** — `CLERK_JWT_ISSUER=https://clerk.rallytasks.com`, `IDENTITY_API_URL=http://timpager.railway.internal:8080` (resolve over the **internal** network), `IDENTITY_API_TOKEN` (service token / `X-API-Key`). Restates: *"full groflo.io APEX SSO still requires a Clerk SATELLITE handshake."*
- **`schema.go` / `test_helpers_test.go`** — *"Session cookies live on `.groflo.io` only. No cross-domain handoff."* The foreign apex keeps its own session island; rallytasks identity arrives only as a **verified JWT**, never a shared cookie.

**The concrete improvement pennyai demonstrates:** *ship the JWKS-Bearer backend FIRST; defer the satellite frontend handshake.* pennyai is **live with Clerk identity verified on a foreign apex without ever standing up the satellite handshake** — the backend simply trusts a presented JWT and falls through to legacy when none is present. **projections can do the same:** land Phases 0–4 (verify + cookie-blind deps + owner-scope columns + discovery/CSP) for a working owner-identity path the instant a Clerk JWT is presented, **before** any `isSatellite` frontend or DNS CNAME (Phases 5–6). The apex/DNS satellite registration is therefore **off the critical path** for the first useful increment.

### 2A.3 Exact CSP origins (from `vibe101/lib/security.js`, adjusted for a foreign-apex satellite)

| Directive | vibe101 (same-apex) Clerk origins | projections (foreign-apex satellite) must allowlist |
|---|---|---|
| `script-src` | `https://cdn.jsdelivr.net` (clerk-js), `https://clerk.rallytasks.com` (FAPI) | clerk-js source + the **satellite FAPI** `https://clerk.projections.thriftly.com` (confirm exact host in the Clerk dashboard, Phase 6). With `@clerk/clerk-react` bundled by Vite, our own JS stays `'self'`. |
| `connect-src` | `https://clerk.rallytasks.com` | satellite FAPI `https://clerk.projections.thriftly.com` **and** `https://clerk.rallytasks.com` / `https://accounts.rallytasks.com` (handshake redirect). Keep `'self'` for our own API. |
| `frame-src` | `https://clerk.rallytasks.com`, **`https://challenges.cloudflare.com`** (Clerk Turnstile bot check) | satellite FAPI + `https://challenges.cloudflare.com`. **The plan's Phase 4 list omitted Turnstile — add it**, or Clerk's bot check renders blank. |
| `img-src` | `https://img.clerk.com`, **`https://images.clerk.dev`** | both (avatars). The plan listed only `img.clerk.com`; **add `images.clerk.dev`.** |

> **Cross-apex CSP nuance the same-apex repos hide:** on a *satellite*, clerk-js talks to the **satellite's own FAPI** (`clerk.projections.thriftly.com`, via CNAME), **not** directly to `clerk.rallytasks.com` — but the session-JWT **`iss` stays the primary** (`https://clerk.rallytasks.com`). So **`CLERK_JWT_ISSUER` (verify) and the FAPI origin (CSP/browser) are different hosts.** vibe101 never hits this because its FAPI and issuer are the same `clerk.rallytasks.com`. Pin the issuer for verification; allowlist the satellite FAPI for the browser.

### 2A.4 The cross-apex specifics (projections.thriftly.com is a DIFFERENT apex)

Two **independent layers** — keep them separate:

**Layer 1 — how the browser on `projections.thriftly.com` obtains a Clerk session (frontend).** A cookie set at `Domain=.rallytasks.com` is **never** sent to `thriftly.com` (browsers scope cookies to the registrable domain), so the vibe101 trick is impossible. To get *automatic* SSO you register projections as a **formal Clerk satellite**:
  1. Clerk dashboard → rallytasks.com **production** instance → **Domains → Satellites → add `projections.thriftly.com`** (a *different-apex* satellite, not a subdomain).
  2. Add the Clerk-issued **CNAME** for the satellite's own Frontend API — `clerk.projections.thriftly.com → frontend-api.clerk.services` — **DNS-only (do NOT Cloudflare-proxy / orange-cloud OFF)**; verify until green. This is what lets Clerk set a **first-party** `__session` cookie **on `thriftly.com` itself** (not on rallytasks.com).
  3. Frontend mounts `<ClerkProvider isSatellite domain="projections.thriftly.com" signInUrl=<primary> allowedRedirectOrigins=[…]>`. A satellite **cannot host sign-in / collect credentials** — an unauthenticated owner is **redirected to the primary** (`accounts.rallytasks.com` Account Portal), authenticates there, and Clerk runs the **handshake redirect back** (the `__clerk_handshake` / `__clerk_synced` flow) which seeds the session cookie on the thriftly.com apex. **Use `buildSignInUrl()`/`buildSignUpUrl()` (which append `__clerk_synced`) rather than a hardcoded URL** (see §2B).
  4. Add `https://projections.thriftly.com` to the instance's **allowed origins** and the primary's **redirect allowlist** (and the SDK's `allowedRedirectOrigins`), or the bounce-back is refused.

**Layer 2 — how our FastAPI trusts a request (backend).** **Apex-agnostic and unchanged: JWKS-Bearer only, cookie-blind, fail-closed.** Whatever Layer 1 does (full satellite handshake, or pennyai-style "owner just presents a token"), our API only ever verifies `Authorization: Bearer <clerk JWT>` against the primary's JWKS via `clerk.session.getToken()`. It **never reads `__session`** — not even the first-party one a satellite sets on `thriftly.com`. This is what keeps Regression #11 true across the apex boundary.

**Why JWKS-Bearer is the right call for a foreign apex (not merely a preference):**
- **Cross-apex cookies don't exist for our API.** There is no `.rallytasks.com` cookie on `thriftly.com`, and we deliberately ignore the satellite's first-party `__session` too → **no ambient credential our API can be tricked into trusting → structurally no CSRF**, exactly the property the capability-token model gives us today.
- **The satellite handshake is a frontend convenience, not an auth dependency.** Per pennyai, the verifying backend works with **zero** satellite/DNS config the instant a JWT is presented. The CNAME/handshake only buys *automatic* SSO ergonomics. ⇒ **De-couple Phase 6 (satellite DNS) from Phases 0–4.**

**Cross-apex gotchas to flag for the owner:**
- **No satellite handshake ⇒ no auto-SSO, but the backend still works** — decide v1: full handshake (Phase 6) vs pennyai-style backend-first.
- **Issuer ≠ FAPI host on a satellite** (§2A.3) — pin `CLERK_JWT_ISSUER=https://clerk.rallytasks.com`, but CSP/browser must reach `clerk.projections.thriftly.com`.
- **`azp` / authorized-parties:** **neither pennyai nor vibe101 enforces `azp`** — the projections plan's `CLERK_AUTHORIZED_PARTIES` enforcement is **stricter than both** and must be **kept** (a cross-apex satellite widens the set of origins that can mint JWKS-valid tokens).
- **Don't copy pennyai's cookie read.** `extractClerkToken` reads `__session` first; harmless for pennyai only because the foreign-apex cookie never arrives. projections' **explicit cookie-blind invariant** (§3) is the cleaner guarantee the CI test must enforce.

---

## 2B. Congruence with Clerk's official satellite best practices + the reference apps

The owner supplied Clerk's official multi-domain/satellite guidance. **Cookie-native, Clerk-native satellite (Clerk's recommendation):** primary `rallytasks.com` + satellite `thriftly.com`; CNAME `clerk.thriftly.com → frontend-api.clerk.services` (DNS-only); **all auth flows run on the PRIMARY** (the satellite only *reads* an existing session, never collects creds); mark the satellite with `isSatellite`+`domain` using the **same pk/sk** (test vs live per env, env-var only); use **`buildSignInUrl()`/`buildSignUpUrl()`** (they append `__clerk_synced`) instead of hardcoded URLs; set **`allowedRedirectOrigins`** to allowlist satellite origins (separate dev/prod); **no passkeys** (bound to one registrable domain); choose **`satelliteAutoSync`** deliberately (default `false`; `true` = auto-recognize already-signed-in primary users at the cost of a redirect on first visit). Clerk states multi-domain is **best-supported on Next.js / TanStack Start / Nuxt**; **other React frameworks work only WITHOUT SSR/hydration.**

**The projections reality:** **React + Vite SPA (client-only, NO SSR) + a Python FastAPI backend.** That is precisely the "other React framework, no SSR" case — and there is **no JS server** to run Clerk's backend middleware/`authenticateRequest`.

### 2B.1 Comparison (dimension × app)

| Dimension | Clerk-official (cookie-native) | timpager (primary) | vibe101 (same-apex) | pennyai (foreign-apex) | **projections — recommended** |
|---|---|---|---|---|---|
| **API trust: cookie-native vs JWKS-Bearer** | cookie + handshake, read by a JS backend SDK | full SDK (owns instance) | cookie-first **or** Bearer; JWKS verify | **JWKS-Bearer** (also reads cookie, but it never arrives) | **JWKS-Bearer, cookie-blind** (FastAPI can't run the JS SDK; Bearer is Clerk's own API-call path via `getToken()`) |
| **CNAME `clerk.<sat>`** | required, DNS-only → `frontend-api.clerk.services` | n/a (primary FAPI `clerk.rallytasks.com`) | **none** (same apex) | not yet (handshake deferred) | **yes — `clerk.projections.thriftly.com`, DNS-only** (Phase 6, only if auto-SSO wanted) |
| **`isSatellite` + `domain`** | required on the satellite | n/a | **no** (not a satellite) | not yet | **yes** (`@clerk/clerk-react`) |
| **`buildSignInUrl()` / `__clerk_synced`** | required (don't hardcode) | n/a | mounts local SignIn | n/a yet | **yes — use the SDK helpers**, not a hardcoded `/refer` |
| **`allowedRedirectOrigins`** | required, allowlist satellite origins | n/a | n/a | n/a yet | **yes** (served via `/api/auth/config`; dev vs prod split) |
| **`satelliteAutoSync`** | deliberate (default false) | n/a | n/a | n/a yet | **owner decision** (default false = explicit owner sign-in; true = auto-recognize primary session, +1 redirect) |
| **Passkeys** | **disable** on satellites | (primary may use) | n/a | n/a | **disable as a factor** (cross-apex; shared-dashboard setting) |
| **SSR-framework requirement** | Next/TanStack/Nuxt best; others **no-SSR only** | Node SSR app | Node SSR app | Go app | **Vite SPA = no SSR ⇒ in the supported "no-SSR" lane** (clerk-react does the handshake **client-side**; no JS backend needed) |
| **Cross-apex handling** | the satellite mechanism itself | n/a | shared `.rallytasks.com` cookie | foreign apex, JWT-only, handshake deferred | **formal satellite for Layer-1 session + JWKS-Bearer for Layer-2 trust** |

### 2B.2 Verdict per reference

- **timpager — CONGRUENT (by role).** It *is* the primary: hosts sign-in, owns `sk`/webhooks. Nothing to reconcile.
- **vibe101 — N/A → CONGRUENT-by-exemption.** It is **not a satellite**; it is a same-apex sibling on the primary's registrable domain, where Clerk treats `*.rallytasks.com` as one domain and the apex cookie is shared. Clerk's *satellite* rules (CNAME, `isSatellite`, "never collect creds") **don't apply**. Its hosting its own `/sign-in` would be **INCONGRUENT for a true satellite**, but is fine same-apex. **Not a template for projections.**
- **pennyai — PARTIALLY CONGRUENT (deliberate subset).** Its **backend** JWKS-Bearer verify is the **Clerk-supported networkless pattern** (congruent, and the right call for a non-JS, foreign-apex backend). It has **not** built the official cookie-native satellite **frontend** (no CNAME / `isSatellite` / `buildSignInUrl` / `allowedRedirectOrigins`) — explicitly **deferred**, not rejected. So pennyai = "congruent backend foundation; satellite frontend not yet implemented."
- **Our plan — CONGRUENT, with fixes.** It splits cleanly into **Clerk's official satellite *frontend* (Layer 1)** + **Clerk's networkless JWKS verify for a non-JS *backend* (Layer 2)**. The **only deliberate divergence** is that our API is **cookie-blind** (never trusts `__session`) where Clerk's *JS-backend* SDK would read the cookie — but **we have no JS backend**, and `getToken()`→Bearer is exactly the Clerk-blessed path for calling a separate API. The divergence is **justified** (cross-apex, no SSR, FastAPI, CSRF-avoidance / Regression #11) and is **invisible** to Clerk's frontend flow.

### 2B.3 Where the plan as-written was INCONGRUENT with Clerk-official (fix in the implementing PRs)

1. **Hardcoded `signInUrl` (`https://www.rallytasks.com/refer`).** INCONGRUENT → use **`buildSignInUrl()`/`buildSignUpUrl()`** so `__clerk_synced` round-trips; point the base at the primary **Account Portal** (`https://accounts.rallytasks.com`), not a deep app route.
2. **`allowedRedirectOrigins` not specified.** ADD it (frontend prop + primary redirect allowlist), dev vs prod split.
3. **`satelliteAutoSync` not chosen.** ADD as an explicit owner decision (default false).
4. **Passkeys not addressed.** ADD: disable passkeys for the satellite flow (registrable-domain-bound).
5. **CNAME detail.** Make it **`clerk.projections.thriftly.com → frontend-api.clerk.services`, DNS-only** (orange-cloud off) — a real footgun.
6. **CSP gaps** — add `https://challenges.cloudflare.com` (Turnstile) and `https://images.clerk.dev` (§2A.3).

These are all **frontend/dashboard refinements**; none changes the backend JWKS-Bearer/cookie-blind design.

### 2B.4 Final recommendation (Vite-SPA + FastAPI + cross-apex)

**Adopt Clerk's official cookie-native satellite pattern for the FRONTEND, and keep the plan's JWKS-Bearer cookie-blind design for the BACKEND — they are complementary, not competing.**

- **Feasibility:** the cookie-native satellite flow **does work on a Vite SPA** *precisely because there is no SSR/hydration* — `@clerk/clerk-react` performs the handshake **client-side** against the CNAME'd satellite FAPI; **no JS backend is required** (verify against Clerk's current docs in Phase 5). This is the one Clerk constraint projections actually satisfies cleanly. (If a future Clerk release ties satellite handshakes to a JS-SSR middleware, fall back to pennyai-style **backend-first** — owner signs in on the primary, projections accepts the presented JWT — which needs no handshake at all.)
- **Match the proven sibling pattern where it's proven:** the **backend** mirrors **pennyai** (foreign-apex JWKS-Bearer, fail-closed, additive, no secret) — the only Rally pattern actually validated on a foreign apex. The **frontend** completes what pennyai deferred, following Clerk-official (`isSatellite`/`domain`/`buildSignInUrl`/`allowedRedirectOrigins`/`satelliteAutoSync`/no-passkeys/DNS-only CNAME).
- **Keep COEXIST + cookie-blind:** viewers (board/funder/advisor) stay **no-login capability tokens**; only the **owner** signs in via Clerk; the Clerk `__session` cookie may exist in the browser for clerk-react's own sync but **our FastAPI never trusts it** → still **no CSRF** (SECURITY.md §6.2, Regression #11).
- **Net:** the plan **does not contradict Clerk's official guidance** — it implements the supported no-SSR satellite frontend and the supported networkless JWT verify for a non-JS backend. The fixes in §2B.3 are the concrete deltas to make it fully congruent.

> **Official reference (confirmed + read).** Clerk's multi-domain demo is **Turborepo + pnpm** with a **plain React (non-Next, Vite) pair**: `apps/react/root-domain/` (primary, `:3002`) and `apps/react/satellite-domain/` (satellite, `:3003`), plus the Next.js pair (`:3000`/`:3001`) and Playwright e2e — i.e. Clerk itself demonstrates a **non-SSR React** satellite, exactly projections' stack. Repo: `https://github.com/clerk/clerk-multidomain-demo` (Next-only variant: `https://github.com/clerk/clerk-nextjs-multi-domain-example`). Docs: `https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains`. **Key shape read from the demo (mirrored below):** the **satellite** `<ClerkProvider>` sets `publishableKey` + `isSatellite` + `domain` + `signInUrl`; **`allowedRedirectOrigins` is set on the PRIMARY/root provider** (it allowlists which satellite origin the primary may bounce back to — the demo README's one explicit setup note). **This is the resolved architecture for projections** (verify exact prop names against current docs in Phase 5).

---

## 2C. Recommended architecture — concrete artifacts (cookie-native FRONTEND satellite ⊕ cookie-blind JWKS-Bearer BACKEND)

**These two compose — not either/or.** The `@clerk/clerk-react` satellite gives the *browser* a Clerk session across the apex (Clerk-official); the FastAPI stays cookie-blind and trusts only a short-lived `Authorization: Bearer` JWT verified against JWKS (no-CSRF, no secret). Capability share-links (`view_slug`/role) are untouched for logged-out viewers. **All snippets are illustrative references for the implementing PRs — no code ships from this docs PR.**

> Host note: projections serves at **`projections.thriftly.com`**; the satellite `domain` and CNAME track whatever host serves the SPA (if it were the bare apex `thriftly.com`, the values collapse accordingly). `signInUrl` may be the primary **Account Portal** (`https://accounts.rallytasks.com`) **or** a primary-app-rendered React-Router `/sign-in` route — the resolved direction uses the latter (primary renders `<SignIn/>`).

### 2C.1 Env (`.env`) — VITE_ prefix on the SPA, issuer/azp on the API; per-env test vs live

```dotenv
# ── PRIMARY app (rallytasks.com / timpager) ── owns sign-in, secret, webhooks
# JS server: CLERK_SECRET_KEY=sk_test_… (dev) / sk_live_… (prod)
# Primary SPA (renders <SignIn/>/<SignUp/>; allowlists the satellite to redirect back):
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…                      # pk_live_… in prod (SAME instance as satellite)
VITE_CLERK_SIGN_IN_URL=/sign-in
VITE_ALLOWED_REDIRECT_ORIGINS=https://projections.thriftly.com   # CSV; dev: http://localhost:5173

# ── SATELLITE SPA (projections.thriftly.com) ── Vite, browser-exposed (VITE_*)
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…                      # pk_live_… in prod — SAME instance key as primary
VITE_CLERK_IS_SATELLITE=true
VITE_CLERK_DOMAIN=projections.thriftly.com
VITE_CLERK_SIGN_IN_URL=https://rallytasks.com/sign-in     # dev: http://localhost:3000/sign-in

# ── SATELLITE BACKEND (projections FastAPI) ── verify-only, NO Clerk secret
CLERK_ENABLED=1
CLERK_JWT_ISSUER=https://clerk.rallytasks.com             # iss for JWKS verify (primary issuer, even on the satellite)
CLERK_AUTHORIZED_PARTIES=https://projections.thriftly.com # azp allowlist (stricter than pennyai/vibe101)
# NEVER set CLERK_SECRET_KEY or CLERK_WEBHOOK_SIGNING_SECRET on projections (finding C1; boot-refuse guardrail).
```
*Var names mirror `clerk-multidomain-demo` (`VITE_CLERK_IS_SATELLITE`, `VITE_CLERK_DOMAIN`, `VITE_CLERK_SIGN_IN_URL`, `VITE_ALLOWED_REDIRECT_ORIGINS`). The SPA reads `import.meta.env.VITE_*` only; the API never sees a `pk`/`sk`. Issuer pins the **primary** even though the browser FAPI is the satellite host (§2A.3). `allowedRedirectOrigins` lives on the **primary** (§2C.4).*

### 2C.2 Satellite `<ClerkProvider>` (projections SPA, `web/src/main.tsx`)

```tsx
// Mirrors clerk-multidomain-demo/apps/react/satellite-domain/src/main.tsx, adapted to projections.
import { ClerkProvider } from "@clerk/clerk-react";

const pk = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!pk) throw new Error("Missing Publishable Key");

<ClerkProvider
  publishableKey={pk}
  isSatellite={import.meta.env.VITE_CLERK_IS_SATELLITE === "true"}  // demo drives this from env
  domain={import.meta.env.VITE_CLERK_DOMAIN}            // projections.thriftly.com
  signInUrl={import.meta.env.VITE_CLERK_SIGN_IN_URL}    // primary renders <SignIn/>
  // allowedRedirectOrigins is set on the PRIMARY provider, NOT the satellite (§2C.4) — per the official demo.
  // satelliteAutoSync defaults to false → session syncs on user-initiated sign-in; true auto-recognizes a primary session (+1 redirect, owner decision).
>
  {/* Owner app routes only. Share-link routes (/{view_slug}, /edit#…, /r/{slug}) render OUTSIDE this provider — no login. */}
</ClerkProvider>
```

### 2C.3 Satellite sign-in button — `buildSignInUrl()` (attaches `__clerk_synced`)

```tsx
import { useClerk } from "@clerk/clerk-react";

function OwnerSignInButton() {
  const clerk = useClerk();
  // buildSignInUrl() returns the PRIMARY sign-in URL with __clerk_synced appended,
  // so the round-trip re-syncs the satellite session. NEVER hardcode this URL.
  return <button onClick={() => { window.location.href = clerk.buildSignInUrl(); }}>Sign in</button>;
  // (buildSignUpUrl() is the sign-up analogue.)
}
```

### 2C.4 PRIMARY renders sign-in/up on React-Router routes (rallytasks.com side — reference only)

```tsx
// PRIMARY entry — verbatim shape from clerk-multidomain-demo/apps/react/root-domain/src/main.tsx:
<ClerkProvider
  publishableKey={publishableKey}
  allowedRedirectOrigins={env.VITE_ALLOWED_REDIRECT_ORIGINS.split(",")}  // CSV → satellite origin(s)
  signInUrl={env.VITE_CLERK_SIGN_IN_URL}
>
  <BrowserRouter><App /></BrowserRouter>
</ClerkProvider>

// …and inside <App/>, the PRIMARY renders the auth UI on path routes:
import { SignIn, SignUp } from "@clerk/clerk-react";
import { Routes, Route } from "react-router-dom";

<Routes>
  <Route path="/sign-in/*" element={<SignIn routing="path" path="/sign-in" />} />
  <Route path="/sign-up/*" element={<SignUp routing="path" path="/sign-up" />} />
</Routes>
// allowedRedirectOrigins lives on the PRIMARY (per the demo README) — it allowlists the satellite origin
// the primary may bounce back to: VITE_ALLOWED_REDIRECT_ORIGINS="https://projections.thriftly.com" (dev: "http://localhost:5173").
// The SATELLITE provider does NOT set it.
```

### 2C.5 FastAPI cookie-blind JWKS-Bearer dependency (`app/clerk.py` + `app/deps.py` — reference)

```python
# app/clerk.py — networkless verify, mirrors timpager/lib/clerk-jwt-verify.js. NO Clerk secret.
import jwt  # PyJWT
from jwt import PyJWKClient

_jwks = PyJWKClient(f"{ISSUER}/.well-known/jwks.json")  # cached; refresh on unknown kid

def verify_clerk_session_token(token: str) -> dict:
    signing_key = _jwks.get_signing_key_from_jwt(token).key
    claims = jwt.decode(
        token, signing_key,
        algorithms=["RS256"],          # RS256 ONLY — no alg-confusion / "none"
        issuer=ISSUER,                  # iss mandatory (fail-closed if ISSUER unset)
        options={"require": ["exp", "sub"]},
        leeway=LEEWAY_SECONDS,          # exp/nbf clock-skew
    )
    azp = claims.get("azp")
    if AUTHORIZED_PARTIES and azp not in AUTHORIZED_PARTIES:   # azp allowlist (closes the gap pennyai/vibe101 leave)
        raise InvalidToken("azp not allowed")
    return {"clerk_user_id": claims["sub"], "org_id": claims.get("org_id"), "claims": claims}

# app/deps.py — COOKIE-BLIND: reads ONLY the Authorization header, NEVER request.cookies.
def resolve_bearer_identity(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        return Anonymous()                         # no header → anonymous (cookie-only request is anonymous)
    token = authorization[7:].strip()
    if looks_like_jwt(token):                       # 3 base64url segments, RS256 header
        try:
            ident = verify_clerk_session_token(token)
            return ClerkOwner(ident["clerk_user_id"], ident["org_id"])
        except InvalidToken:
            raise HTTPException(401)                 # PRESENT-but-invalid Clerk JWT → 401 (pennyai's three-state)
    return resolve_capability_token(token)          # opaque token → existing SHA-256 owner/edit/role compare
```
*Invariant (CI test, Regression #11): a request with a valid `__session` cookie but **no** `Authorization` header resolves to `anonymous`. The API never reads `request.cookies`.*

### 2C.6 Verify-the-flow (staging checklist, Phase 6)

1. Visit `https://projections.thriftly.com` signed out → owner area shows "Sign in"; **share-link routes render with no login.**
2. Click sign-in → `buildSignInUrl()` redirects to `https://rallytasks.com/sign-in` (primary renders `<SignIn/>`); URL carries `__clerk_synced`.
3. Authenticate on the **primary** → Clerk redirects **back** to `projections.thriftly.com` (must be in `allowedRedirectOrigins` + the dashboard redirect allowlist) → satellite now has an **active session** (first-party `__session` on `thriftly.com` via the `clerk.projections.thriftly.com` CNAME).
4. The SPA calls the API with `Authorization: Bearer ${await clerk.session.getToken()}`; **FastAPI verifies via JWKS** and resolves owner scope on the Clerk `userId`/`orgId`.
5. Negative: replay the same request with **only** the `__session` cookie and **no** `Authorization` header → **`anonymous`** (no-CSRF invariant holds).
6. `satelliteAutoSync=false`: confirm an already-signed-in-on-rallytasks user is **not** auto-signed-in on projections until they click sign-in (flip to `true` only if auto-recognition is wanted, accepting the first-visit redirect).

### 2C.7 Reconciliation with pennyai + vibe101 (does this match the proven pattern?)

- **Backend = pennyai, proven on a foreign apex.** §2C.5 is pennyai's `clerk_auth.go` in Python: RS256-only, issuer/exp enforced, JWKS-only, fail-closed, additive, **no secret** — the single Rally pattern actually validated cross-apex. **CONGRUENT.** projections adds **`azp` enforcement** (pennyai omits it) and **cookie-blindness** (pennyai reads `__session`, harmless only because the foreign-apex cookie never arrives) → **projections is strictly stricter; the stricter side wins.**
- **Frontend = the official Clerk satellite that pennyai deferred and vibe101 never needed.** pennyai shipped backend-first and left the handshake as "a separate, larger step"; vibe101 is same-apex and uses no satellite at all. **Neither sibling contradicts this frontend — they simply hadn't built it.** §2C.2–2C.4 complete it per Clerk-official, so the combined approach is **CONGRUENT with Clerk-official (frontend) AND with the JWKS-Bearer hardening (backend).**
- **Where they diverge, and which wins:** vibe101's cookie-first `extractToken` + `tp_csrf` double-submit is a **same-apex** affordance that **re-introduces a CSRF surface** — **projections must NOT copy it** (Regression #11); the cookie-blind Bearer design wins. pennyai's deferral of the frontend is fine for its phasing, but projections wants owner SSO, so it builds the frontend now (or ships backend-first too — see the §12 phasing question).

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
| `CLERK_DOMAIN` (⇒ `VITE_CLERK_DOMAIN`) | required when `CLERK_ENABLED` | Satellite host for `<ClerkProvider domain>`. | `projections.thriftly.com`. |
| `CLERK_SIGN_IN_URL` (⇒ `VITE_CLERK_SIGN_IN_URL`) | required when `CLERK_ENABLED` | Primary's sign-in URL for `<ClerkProvider signInUrl>`; redirects built with **`buildSignInUrl()`** (§2C.3). | `https://rallytasks.com/sign-in` (or Account Portal `https://accounts.rallytasks.com`). **Not** a deep route like `/refer`. |
| `CLERK_AUTHORIZED_PARTIES` | required when `CLERK_ENABLED` | `azp` allowlist for JWT verify (stricter than pennyai/vibe101, which omit it). | CSV incl. `https://projections.thriftly.com`. |
| *(primary-side)* `VITE_ALLOWED_REDIRECT_ORIGINS` | on the **primary** SPA | `allowedRedirectOrigins` allowlist of satellite origins (§2C.4). | `https://projections.thriftly.com` (dev `http://localhost:5173`). **Set on rallytasks, not projections.** |
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
- **`web/src/main.tsx` / `App.tsx` / `web/src/env.ts`** — wrap the owner app routes in the satellite `<ClerkProvider isSatellite domain signInUrl publishableKey>` (concrete code + env-typed module in **§2C.2**; `VITE_*` vars in **§2C.1**); add the `buildSignInUrl()` sign-in button (**§2C.3**). Provider values come from `import.meta.env.VITE_*` (and/or `GET /api/auth/config`). **`allowedRedirectOrigins` is configured on the PRIMARY (rallytasks) provider, not here (§2C.4).** **Share-link routes (`/{view_slug}`, `/edit#…`, `/r/{slug}`) stay OUTSIDE the provider / do not require sign-in.**
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
- **RED tests** (`app/tests/test_security_headers_clerk.py`, `app/tests/test_auth_config_route.py`): (a) when `CLERK_ENABLED`, CSP `script-src`/`connect-src` include the **satellite FAPI** `https://clerk.projections.thriftly.com` + `https://clerk.rallytasks.com`/`https://accounts.rallytasks.com` (handshake) + `https://*.clerk.accounts.dev` (dev), `frame-src` includes the FAPI **and `https://challenges.cloudflare.com`** (Clerk Turnstile bot check), `img-src` includes `https://img.clerk.com https://images.clerk.dev` (exact origins in §2A.3); **when disabled, CSP stays the strict `'self'`-only baseline** (no relaxation unless Clerk is on); (b) CORS stays exact-origin, `Allow-Credentials` off; (c) `GET /api/auth/config` returns `{clerk_enabled, clerk_publishable_key, clerk_domain, clerk_sign_in_url}` and **never** a secret; cache header present.
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
| **Which primary URL hosts sign-in** for `signInUrl`? | Phase 5 | For a *cross-apex satellite*, point at the primary **Account Portal** `https://accounts.rallytasks.com` (the host pennyai references for the handshake) and build redirects with **`buildSignInUrl()`** (`__clerk_synced`) — not a hardcoded deep route. (timpager also mounts `<SignIn>` on `/refer`.) See §2B.3. |
| **Full satellite handshake in v1, or pennyai-style backend-first?** | Phase 6 vs Phases 0–4 | **Recommend backend-first**: ship JWKS-Bearer verify with **no** DNS/`isSatellite`; add the CNAME + handshake later. pennyai runs in production this way; only auto-SSO is deferred. |
| **`satelliteAutoSync` — auto-recognize a primary session?** (Clerk-official) | Phase 5 | Default **false** (explicit owner sign-in). Set **true** only if "already signed in on rallytasks ⇒ signed in on projections" is wanted, accepting a redirect on first visit. Owner decision. |
| **Passkeys** on the satellite flow | Phase 6 | **Disable** — passkeys are bound to one registrable domain and break cross-apex (Clerk-official). Shared-dashboard setting. |
| **Vite-SPA feasibility of the cookie-native satellite** | Phase 5 | Confirmed lane: a Vite SPA is **no-SSR**, which is Clerk's supported case for non-Next/TanStack/Nuxt React; clerk-react does the handshake **client-side** (no JS backend). **Verify against Clerk's current docs in Phase 5**; fall back to backend-first if a release ties it to JS-SSR middleware. See §2B.4. |
| **Sign-in/sign-up factors** (phone, Google OAuth) — owned by the shared Clerk dashboard | Phase 6 | Reuse the rallytasks instance's existing factors; no projections-side config. |

---

## 13. Out of scope (YAGNI fences)
- Clerk **webhooks** on projections (user.* sync is the primary's job; projections has no local user table to sync — it keys directly on `clerk_user_id`).
- Holding any **Clerk secret** (`CLERK_SECRET_KEY`, webhook secret) on projections.
- `@clerk/backend` full-SDK `authenticateRequest` (cookie-reading) path — JWKS-only by design.
- Resolving `rally_user_id` / cross-service identity joins (deferred; v1 keys on `clerk_user_id`).
- Forcing any **viewer** (board/funder/advisor) to log in — never.
- Org-scoped lists/teams UI — store `org_id`, build the UI later.

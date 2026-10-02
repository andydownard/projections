# Rally auth — design spec

**Date:** 2026-10-02
**Status:** approved by owner, pending implementation plan

## Context

This project shipped two prior access models: capability tokens (owner/edit
bearer secrets), then an optional Clerk satellite login layered on top
(`CLERK_ENABLED`, `app/clerk/`). On 2026-09-13 the owner decided to eliminate
auth entirely, and that work was built, tested, and opened as PR #392 — but
never merged.

On 2026-10-02, while that PR sat open, `clerk.thriftly.com` (the Clerk
satellite's Frontend API) started hanging mid-request. The deployed app's
`ClerkOwnerGate` blocks the whole React tree from rendering until Clerk's
script loads, so the site went fully blank in production. Diagnosed via a
live browser session: TLS handshake to `clerk.thriftly.com` succeeds, but the
HTTP response never arrives.

The owner's direction, given across several follow-up messages, converged on:
**don't remove auth, and don't keep relying on Clerk — build a real,
self-hosted username/password system.** PR #392 is closed unmerged. This spec
is for the replacement.

The production outage itself is being handled separately and immediately
(clear `VITE_CLERK_PUBLISHABLE_KEY`, rebuild the unmodified `main` branch) —
that is a reversible stopgap, independent of this spec's timeline, not part
of this build.

## Goals

- Real accounts: email + password, hashed at rest.
- Open signup, with email verification before a new account can create
  projections.
- Each user owns their own projections (replaces the capability-token/Clerk
  owner-scoping already in the codebase — not a new concept, a new identity
  underneath the same shape).
- Login, logout, forgot-password, reset-password.
- Server-side sessions (revocable), not stateless JWTs.
- Rally-branded login/signup/reset pages using the real wordmark asset
  (`rally_wordmark.svg`, color `#35644F`).
- Hosted at `projections.rallytasks.com` (a Railway custom domain, set up
  separately — not part of this spec).

## Non-goals (out of scope for this spec)

- OAuth/social login of any kind.
- Multi-factor auth.
- Organizations/teams/shared ownership — one user owns one projection, same
  as the single-owner capability-token model today. (The old Clerk
  "share_grants"/editable-shares-follow-an-account feature is **not**
  rebuilt here.)
- Role-based share links (`/r/{role_slug}`, board/funder/advisor view) —
  unaffected by this change, left exactly as-is.
- Anything about `projections.rallytasks.com`'s DNS/Railway domain setup —
  tracked separately.
- Migrating existing Clerk-owned or token-owned projections to the new
  `users` table. Existing rows keep their current (now-unreachable-via-login)
  ownership columns; nothing is deleted or backfilled. A follow-up migration
  tool is a later decision, not part of this build.

## Data model

New migration `m0015_accounts.py` (additive only, per `app/store/migration_safety.py`):

```sql
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  email_verified_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,   -- the session token itself, HASHED (see below)
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS email_verifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

ALTER TABLE projections ADD COLUMN owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projections_owner_user ON projections(owner_user_id);
```

Same hashing discipline the codebase already uses elsewhere
(`hashlib.sha256` + `hmac.compare_digest`) applies to session/verification/
reset tokens — the plaintext token lives only in the cookie or the emailed
link, never at rest.

Passwords are hashed with **bcrypt** (via `bcrypt` package — new dependency,
justified: it's the standard, and this project has no existing password
hashing to reuse). Not SHA-256 — passwords are low-entropy human secrets,
unlike this codebase's existing high-entropy capability tokens, so a slow,
salted KDF is required here (this is the one place in the codebase where
that distinction matters).

## Flows

**Signup** (`POST /api/auth/signup`): email + password → validate (email
shape, password min-length) → reject if email already registered (generic
error, don't leak which emails exist) → create `users` row
(`email_verified_at = NULL`) → mint an `email_verifications` row → send a
verification email via Resend → respond 201 (no session yet — must verify
first).

**Verify email** (`GET /api/auth/verify?token=...`): look up by
`sha256(token)`, check not expired/used, stamp `email_verified_at`, mark the
verification row used, redirect to login with a success banner.

**Login** (`POST /api/auth/login`): email + password → constant-time-safe
bcrypt compare → reject unverified accounts (403, "check your email") →
mint a session (`secrets.token_urlsafe(32)`, stored hashed, 30-day expiry) →
set an HttpOnly, Secure, `SameSite=Lax` cookie → respond with the user's own
projection list.

**Logout** (`POST /api/auth/logout`): revoke the session row
(`revoked_at`), clear the cookie.

**Forgot password** (`POST /api/auth/forgot-password`): email → always
respond 200 regardless of whether the email exists (no user enumeration) →
if it does exist, mint a `password_resets` row, email a reset link via
Resend (1-hour expiry).

**Reset password** (`POST /api/auth/reset-password`): token + new password →
look up by hash, check not expired/used → update `password_hash`, mark the
reset row used, **revoke every existing session for that user** (a password
reset is a compromise-response action — every other logged-in device gets
signed out).

## Session & CSRF design

This is a real architecture change from the codebase's current "cookie-blind"
invariant (Regression #11), which existed specifically because there was no
session to forge. Introducing one real session cookie means CSRF becomes a
real threat class again, so the mitigation has to be explicit:

- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`. `Lax` (not `Strict`) so a
  normal top-level navigation to the app from an external link still carries
  the session — `Strict` would silently log the user out on every external
  link click, which is a worse failure mode for this low-value target than
  the CSRF risk `Lax` leaves open for top-level GET navigations.
- Every mutating request (`POST`/`PATCH`/`DELETE`) additionally verifies the
  `Origin` header matches `config.app_origin()` server-side — this is the
  real CSRF defense, not the cookie attribute alone (per this project's
  global `SESSION` rule: "Verify the Origin header on every mutating
  request"). A missing or mismatched `Origin` on a mutating request is
  rejected (403) before touching the database.
- Session lookup happens in a new `app/auth.py` dependency
  (`resolve_session(request) -> User | None`), reading the cookie, hashing
  it, looking up `sessions WHERE id = ? AND revoked_at IS NULL AND
  expires_at > now()`. This is the only place that reads `request.cookies`
  in the codebase — everywhere else stays cookie-blind, since nothing else
  needs identity.

## What gets removed

- `app/clerk/` (the whole package).
- `CLERK_ENABLED`, `clerk_enabled()`, `clerk_config()`, and the Clerk CSP
  widening in `app/middleware.py`.
- The frontend's `web/src/auth/Clerk*` components and
  `web/src/auth/OwnerAuthControls.tsx`.
- The capability-token bearer-resolution path in `app/deps.py`
  (`resolve_bearer_identity`, `ClerkOwner`, `CapabilityBearer`) — replaced by
  the new session dependency.

## What stays, unchanged

- `If-Match`/`version`/HTTP 409 optimistic concurrency.
- Per-IP rate limiting (`app/ratelimit.py`).
- `GET /api/metrics`'s independent `METRICS_TOKEN` gate.
- `/api/r/{role_slug}` read-only role links.
- Read-only share access via `view_slug` for logged-out visitors (viewing
  and exporting a specific projection someone shared the link to still
  needs no account — only *creating* and *owning* projections requires one).
- The existing `owner_token_hash`/`edit_token_hash`/`owner_clerk_user_id`/
  `owner_org_id`/`role_tokens_json` columns and the `share_grants` table —
  left in place, unused, per the additive-only migration constraint (same
  reasoning as PR #392's now-moot plan for them).

## Email delivery (Resend)

New dependency: `resend` (or plain `httpx` calls to Resend's REST API —
implementer's choice, `httpx` is already a dependency so it may be simpler
to avoid adding another package for two API calls). New required env var:
`RESEND_API_KEY`. New optional env var: `RESEND_FROM_ADDRESS` (default
something like `noreply@rallytasks.com` — needs a verified sending domain in
the Resend dashboard, which is an **owner-side setup step**, not something
this build can do). Email sending is **best-effort but not silently
swallowed on the signup/forgot-password path** — unlike the GitHub feedback
integration's "never fail the user's request" pattern, a signup or
forgot-password call that can't send its email must surface a real error
(503), because the flow is unusable without it. Follows `app/config.py`'s
existing boot-refuse pattern: production refuses to boot without
`RESEND_API_KEY` set.

## Frontend

New pages: `/login`, `/signup`, `/forgot-password`, `/reset-password`,
replacing the deleted Clerk sign-in UI. Each carries `rally_wordmark.svg`
(copied into `web/public/`) at the top, color `#35644F`. A top-bar
account menu (logged-in email + "Log out") replaces the old
`OwnerAuthControls`/`UserMenu`.

The existing `ListPage`/`ProjectionDetail`/etc. components already assume an
"owner" concept from the capability-token days — they get re-pointed at the
new session-based identity rather than rewritten from scratch where
possible.

## Security checklist (for the implementation plan's test list)

- Password hashing uses bcrypt with a real cost factor (not a toy work
  factor in prod; tests use a lower factor for speed — document that split
  explicitly, like this codebase's LibreOffice-pinning precedent).
- Login is rate-limited per IP **and** per attempted email (a flood against
  one target email from many IPs is still capped).
- Signup is rate-limited per IP.
- No user-enumeration: forgot-password always returns the same response
  shape regardless of whether the email exists; signup's "email already
  registered" error is the one deliberate exception (needed for UX; accepted
  trade-off, documented here rather than silently inconsistent).
- Session tokens: `secrets.token_urlsafe(32)` (≥256-bit), hashed at rest,
  compared via `hmac.compare_digest` — same discipline as the capability
  tokens being replaced.
- Verification/reset tokens: same CSPRNG + hash-at-rest + constant-time
  compare discipline, single-use (`used_at` checked), short expiry.
- `Origin` header check on every mutating request (see Session & CSRF design
  above) — this is the new code's one load-bearing security property that
  has no precedent elsewhere in this codebase and needs its own adversarial
  test (forged `Origin`, missing `Origin`, same-origin success).
- Password reset revokes all other sessions for that user.
- A regression-registry row gets added for "no CSRF defense beyond
  cookie-blindness" (Regression #11) once this ships — the invariant
  changes from "no cookie is ever trusted" to "the one session cookie is
  trusted only alongside a verified Origin."

## Testing plan

Follows this project's `TDD`/`Mutation Safety Quad` conventions, adapted:
every new mutating endpoint (`signup`, `login`, `logout`, `forgot-password`,
`reset-password`) gets a positive test, a negative/abuse test (bad
credentials, expired/reused token, rate-limit trip), and — where relevant —
an idempotency test (double-submit doesn't double-create). The `Origin`
check gets its own dedicated adversarial test file, since it's the one
genuinely new security mechanism here. Existing `test_projections_*` tests
that assumed capability-token ownership get updated to use session-based
login instead of `create_projection()`'s old token tuple — same shape of
work as the (now-abandoned) PR #392's test-cleanup pass, but pointed at
sessions instead of "no auth."

## Open questions (not blocking — flag in the plan, resolve during build)

- Exact bcrypt cost factor for production (12 is a reasonable default;
  confirm against Railway's CPU budget).
- Whether `RESEND_FROM_ADDRESS`'s domain verification is done before or
  after this ships (if not done in time, email sending 503s — signup/reset
  simply don't work until the owner finishes that Resend dashboard step;
  this should be called out loudly at ship time, not discovered later).
- Minimum password length/complexity rule (recommend: length-only, ≥12
  chars, no composition rules — composition rules are a known anti-pattern;
  confirm with owner during planning if they want something stricter).

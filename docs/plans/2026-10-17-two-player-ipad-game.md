# Two-player iPad game: plan

**Date:** 2026-10-17
**Status:** draft for owner review. Nothing here is built. Open decisions are listed first.

## What we are building

A head-to-head thrift store game. Two players each run a pretend store for a short "season" (12 rounds, one per month). Both make choices each round (prices, staff, hours, marketing, which donations to take). The existing engine decides what happens. Best cash at the end wins. It must run on iPads, be safe for kids, and always have someone to play: a friend, a stranger, or a bot.

Devices to support (CSS pixels, portrait):

| Device | Width x height |
|---|---|
| iPad mini | 744 x 1133 |
| iPad Pro 11" | 834 x 1194 |
| iPad Pro 13" (largest) | 1032 x 1376 |

Both orientations work. iPhone works as a bonus, not a target.

## Open decisions (need the owner before any build)

1. **Game design.** The request did not say what the game is. This plan assumes the sim described above, with the engine as referee. If the owner has a different game in mind, phases 1 and 2 still hold. Phases 3 and 4 change.
2. **Where it lives.** Recommendation: a separate deployable (new Railway service, new repo or `apps/game/`) that imports `engine/`. Reason: `AGENTS.md` scopes this repo to first-store nonprofit operators and a board-ready financial case. A kids' game adds child-data law (COPPA), realtime load, and a different tone. Mixing them raises risk for the paid product. Engine reuse keeps one math authority.
3. **Auth.** The 2026-10-02 Rally auth spec (email + password, open signup) is approved but not built, and Clerk host-gating is live today. Kids usually have no email. Needs a decision on whether players are child profiles under a parent account (recommended) and whether to build on the Rally auth work.
4. **Age range.** Under 13 means COPPA (US). Recommendation: design for 8 to 12, require a parent account, collect no child PII.
5. **Classroom mode.** Join codes for a teacher? Out of scope for v1 unless the owner wants it.

## Principles

- **Server-authoritative** (`SERVER`, `NO-CLIENT-MATH`). The client sends choices. The server runs the engine and returns results. Same rule as the main app.
- **Fair.** Both players get the same seeded random events each round.
- **Honest bots.** A bot is always labeled as a bot (`AI` rule: never pose as a human).
- **No free text between players.** No chat, no usernames typed by kids. Fixed emotes only. This removes most moderation and safety work.
- **Minimal data.** Parent email is the only personal data. Kids have a generated display name and an avatar.

## Phases

### Phase 0: Decisions and game design (blocks everything)
Settle the open decisions. Write a one-page rules sheet: round structure, choices, scoring, event deck, season length (target 8 to 10 minutes). Pin the scoring to engine outputs.
Done when: owner signs off on the rules sheet and the three decisions above.

### Phase 1: iPad and mobile shell (ships on its own value, and also helps the existing app)
- Responsive layout tuned at 744, 834, 1032 and 375 widths, portrait and landscape.
- Touch rules: tap targets 48px minimum for the game (kids), `touch-action: manipulation`, no hover-only controls, safe-area insets, `100dvh` not `100vh`.
- PWA: web manifest, standalone display, home-screen icon, so it launches full screen with no App Store.
- Tests: Playwright WebKit with iPad mini, iPad Pro 11 and an iPad gen 7 descriptor, plus a 13" custom viewport. Screenshots at each size reviewed by eye before any deploy (per the visual-review rule).
- A real-device pass on the owner's two iPads before shipping.
Done when: the main app and a stub game screen render cleanly at all four widths in both orientations, and the manual iPad pass is signed off.

### Phase 2: Player accounts with kid-friendly passwords
- **Parent account:** email + password with email verification (reuse the Rally auth design). Parent creates up to N child profiles and can reset a child's password, rename, or delete a child (full data deletion).
- **Child login:** pick avatar, then enter a picture password: choose 3 pictures in order from a grid of 12. Alternative for readers: a three-word phrase from a curated, filtered word list (for example `blue-tiger-pizza`). Both give roughly 30+ bits, which is fine with the lockout below.
- **Abuse limits:** per-IP and per-account rate limit, lockout with a parent-reset path, argon2id hashing, constant-time compare, server-side revocable sessions.
- **Display names:** generated from adjective + animal lists. Kids never type a public name.
- **Consent:** parent confirms consent at signup. Privacy notice in plain English (`STYLE`).
- Mutation Safety Quad on every write, negative cross-account tests (`TENANT`: a child can never see another child's data).
Done when: a parent can create two kids, each kid can log in on a different iPad, and the cross-account tests pass.

### Phase 3: Two-player match engine and friend codes
- Match record with a state machine: waiting, active, finished, abandoned. Stored in SQLite on `/data`.
- Realtime by WebSocket on one FastAPI instance, with a polling fallback. Actions carry an idempotency key and the match version (`If-Match` style, 409 on stale), so a double tap or a retry never duplicates a move.
- Simultaneous rounds with a timer (about 30 seconds). If a player misses the timer, the last choice repeats.
- Reconnect handling for iPad Safari, which drops sockets when the screen sleeps: resume by match id, 60 second grace, then a bot takes over the seat.
- **Friend code first:** a 4-symbol emoji code so two iPads in one room can pair in seconds. This is the main use for the owner's two iPads, so it ships before open matchmaking.
- Engine call per round reuses `engine/` with a new thin "season" adapter. Any math change bumps `model_version` and goldens as usual.
Done when: two iPads pair with a code and finish a full season, with a forced disconnect and rejoin mid-match.

### Phase 4: The bot
- Same engine, same rules, same event deck. The bot only chooses actions.
- Start with a rules-based policy at three difficulty levels. No LLM needed, which keeps it cheap, deterministic and testable.
- Difficulty follows the player's rating, so it feels close.
- Always labeled ("Robo Rae, practice bot"). Bot games count for practice stats, not the ranked rating.
Done when: a bot finishes a season against a scripted player, and a simulated 1,000-season run shows each difficulty's win rate is in the intended range.

### Phase 5: Matchmaking queue
- "Play" adds the kid to a queue. Match the closest rating within a widening window.
- Wait up to about 15 seconds, then offer a bot ("No one is free. Play Robo Rae?"). Never silently swap in a bot.
- Simple rating (Elo) per child, human games only.
- Atomic claim of queue entries (no check-then-act race, `MUTATION`).
Done when: with 2 queued players they match each other, with 1 they get the bot offer, and a race test shows no player lands in two matches.

### Phase 6: Hardening and launch
- Load test with simulated matches on one instance. Decide whether SQLite and a single instance hold, or whether Postgres is needed (the `Store` interface already keeps that open).
- Accessibility pass (WCAG AA, VoiceOver order, reduced motion).
- Security review of auth, WebSocket origin checks, rate limits (`/cso`).
- Privacy review for COPPA with counsel before any public launch.
- Restore drill for the match database.
Done when: all review lenses are green with evidence in the PR.

## Risks

1. Child data law. A mistake here is serious and slow to fix. Mitigation: parent-gated accounts, no child PII, counsel review before launch.
2. Realtime on iPad Safari (sleeping sockets, background tabs). Mitigation: resume protocol and bot takeover from day one.
3. Scope. This is a new product. Phase 0 exists to stop work before it starts if the design is not clear.
4. A single instance with SQLite may not scale past a few hundred concurrent matches. Acceptable for a first release.

## Suggested order

Phase 0, then Phase 1 (useful even if the game never ships), then 2, 3, 4, 5, 6. Phase 3 with friend codes is the first point where the owner can play on two iPads.

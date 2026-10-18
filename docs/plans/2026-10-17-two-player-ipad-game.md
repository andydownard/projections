# Time Clash: two-player iPad plan

**Date:** 2026-10-17 (rewritten the same day after the owner shared the real game)
**Status:** draft for owner review. Nothing here is built.

> The first draft of this plan assumed a thrift store sim. That was wrong. The game is **Time Clash**, and it stays as designed. This plan only adds real two-player play on two iPads, accounts, matching and a bot.

## What Time Clash is today

Source: the "Time Clash UI & Environment Suite" Design canvas (12 artboards, each 1600 x 900, landscape). It is a design prototype only. There is no game code yet.

- A kids' battle game: a past castle side (Player 1) against a future base side (Player 2), with a hoverboard, a repair bot and knights.
- Before each shot a player answers a **Math** or **Reading** question for their grade (K to 8). Two shots per turn. Right answers load the shot.
- Between fights: a **Forge** (weapons, past and future versions) and **Upgrade Base**.
- A battle ends with **Base Destroyed**. The copy says nobody is hurt, the building just blows up. Explosions already exist on that screen.
- **Setup** takes two names and two grades on one screen. Today both players share one device ("hot seat").

## What changes

Each player uses their own iPad. The game rules, art and screens stay as they are. Each iPad shows its own player's side, and the other player's turn shows as "waiting", which the Math and Reading screens already draw.

## Open decisions (need the owner)

1. **Where the code lives.** Recommendation: a new repo for Time Clash. The `projections` repo is a thrift store financial tool for nonprofit boards. They share nothing, and a kids' game brings child-data law with it. The issues filed on 2026-10-17 as #396 to #402 are in the wrong repo and should move once the new repo exists.
2. **Is there any game code yet,** beyond the canvas? If not, Phase 1 builds it.
3. **Question bank.** Where do the grade K to 8 math and reading questions come from? Written by hand, generated and reviewed, or licensed? They need to be original and checked for age fit.
4. **Fairness across grades.** Each player gets questions at their own grade, so a 2nd grader can fairly beat a 6th grader. Confirm this is wanted.
5. **Age range and consent.** Under 13 means COPPA (US). Recommendation: a parent account is required and the child profile holds no personal data.

## Principles

- **The server is the referee.** The iPad sends answers. The server holds the questions' correct answers, scores shots and decides outcomes. A kid cannot read the answer out of the page.
- **Same moment on both iPads.** Hits, the Base Destroyed explosion and results play from a server signal so both players see them together.
- **No typed names, no chat.** Names come from the child profile. Players can send fixed emotes only.
- **Honest bots.** A bot is always labeled.
- **Reduced motion and flashing.** Explosions follow the existing reduced-motion rules and stay under 3 flashes a second.

## Devices

| Device | Landscape size (CSS px) |
|---|---|
| iPad mini | 1133 x 744 |
| iPad Pro 11" | 1194 x 834 |
| iPad Pro 13" (largest) | 1376 x 1032 |

The artboards are 16:9 at 1600 x 900. The 13" iPad is nearly 4:3, so it would show bars. The mini scales the art to about 0.71, which would shrink the 16 px labels to about 11 px. So the screens need a real responsive pass, not just scale to fit.

Decision: **landscape only.** The battle scenes are wide. In portrait, show a "turn your iPad" screen.

## Base builder (new screen, owner request 2026-10-17)

The owner described this by voice. It sits in "Upgrade Your Base" and must come before the battle. Today the Upgrade artboards are a shop only (buy upgrades with gold, wood, stone or credits). They have no building and no saved bases.

What the owner asked for:
- **Build as creatively as you like.** Looks do not matter. Nobody judges.
- **Drag bricks with a finger** from a tray and drop them on the build plot.
- **Turn bricks** (rotate) before or after placing, and place them on walls too, not only on the ground.
- **Buy stuff, use stuff you already bought, and build.** Owned pieces show in the tray. Locked pieces show a price.
- **Up to three saved bases per player.** Pick one before a battle.

Design notes and open questions:
- Touch first: a drag handle at least 48 px, a rotate button (and a two-finger twist), snap to a grid with a "free place" toggle, undo, clear. No hover.
- Does the built base take hits in the battle (bricks have health and fall out when hit)? Recommendation: yes. It ties the builder to the new hit and fall effects. Needs owner confirmation.
- Past side builds a castle from stone and wood. Future side builds a base from panels. Same tools, different pieces.
- Saved bases belong to the child profile (Phase 3) and sync to both iPads before a match (Phase 4).
- Add two artboards to the canvas: "Base Builder (Past)" and "Base Builder (Future)", and a "Pick a base (1 of 3)" row on Setup.

## Phases

### Phase 0: Decisions
Settle the five decisions above. Pick the stack. Recommendation: React + TypeScript + Vite as an add-to-home-screen web app (PWA), with a small Python or Node server for accounts, matches and the question bank.

### Phase 1: Build the one-device game from the canvas
Turn the artboards (and the new Base Builder) into a working game: Setup, Loading, Battle, Math, Reading, Forge, Upgrade, Base Destroyed. Question engine by grade. Hot-seat mode first. This is the base for everything else.
Done when two kids can play a whole battle on one iPad.

### Phase 2: iPad layouts
Responsive landscape layouts for the three iPad sizes, minimum text size of 16 px on device, 48 px touch targets, no hover-only controls, safe-area insets, rotate-to-landscape screen, PWA manifest. Playwright WebKit tests with iPad mini, Pro 11 and a 13" viewport. Screenshots reviewed by eye. A real-device pass on the owner's two iPads.

### Phase 3: Accounts and kid-friendly passwords
- A parent account (email, verified) creates child profiles. A profile has a generated display name, an avatar and a grade.
- A child signs in with a picture password (3 pictures in order from a grid of 12) or a three-word phrase.
- argon2id hashing, per-IP and per-account rate limits, lockout with a parent reset, parent-controlled deletion, tests that one child can never see another's data.
- Replaces typed names on the Setup screen.

### Phase 4: Two iPads, one battle
- A match with a server-held state: waiting, active, finished, abandoned.
- Pairing by a short emoji code, so two iPads in the same room join in seconds. This is the first time the owner can play on two iPads.
- WebSocket sync of turns, answers, shots and the destroyed animation. Each action carries an id so a double tap or a retry never counts twice.
- Reconnect handling for iPad Safari, which drops connections when the screen sleeps: 60 second grace, then the seat is handed to a bot.

### Phase 5: The bot
A labeled opponent ("Robo Knight") that uses the same rules. It answers questions at a believable rate for the player's grade, with a human-like delay, and aims for close games. Tuned by simulating thousands of battles.

### Phase 6: Matchmaking
"Play" joins a queue. Match players close in grade and skill. After about 15 seconds with no match, offer the bot. Never swap one in silently. Bot games are practice and do not count toward ranking.

### Phase 7: Hardening and launch
Load test, accessibility pass (VoiceOver, contrast, reduced motion), security review of sign-in and the WebSocket, counsel review of child-data handling before any public launch, backup and restore drill.

## Risks

1. Child data law (COPPA). Slow and costly to fix late.
2. iPad Safari drops connections when the screen sleeps.
3. Small-screen readability of the current art on the iPad mini.
4. Question quality and age fit for K to 8.

## Suggested order

0, 1, 2, then 3, 4. Phase 4 with codes is the first time two iPads can play each other. Bot and matchmaking come after.

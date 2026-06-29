The merged design spec is written. Below is the complete spec.

---

# Design Spec — Editable AI Narrative Canvas + Fly-out AI Chat

**Surface:** Projection detail page, Tab 1 (Projection). **Status:** design spec, merged from Google/Shopify/Apple staff-UX panel. **Brand tokens:** ENGINEERING_HANDOFF §6 (PRD Appendix D). **Authority docs:** PRD §13/§14/§15/§17/§19.3/§21, API_SPEC §1.3/§1.4/§4.4/§6.1, SECURITY §5/§6, DATA_MODEL `narratives`, CLAUDE.md (no client math).

> One sentence the whole spec defends: **the engine is the only math authority and `edited=true` is sacred** — the AI proposes, the server computes, the human applies, and nothing mutates real numbers or board prose without a reviewable, reversible confirm.

---

## 0. Two spec gaps the build must close first (blocking)

The panel assumes two server affordances that **do not exist in API_SPEC today**. They are required and must be added before this UI is buildable.

1. **Dry-run / preview compute endpoint.** The chat's "reviewable diff before apply" is impossible without a server-computed preview that does **not** mutate, **not** increment `version`, and **not** write a revision. Add:
   `POST /api/projections/{view_slug}/preview` — body identical to the `PATCH §4.4` editable-surface partial (`inputs`/`assumptions`/`overrides.set|clear`); auth owner/edit (Bearer); **no `If-Match`** (read-only); returns a **diffed view-model** `{ before, after, changed:[{label,was,now,sign}], reco_before, reco_after }` plus the same `422 node_not_pinnable` / `422 input_out_of_domain` the real PATCH would raise. **Same engine, same DAG, same rejections** — only persistence is skipped. This is what binds the diff card to real numbers.
2. **Chat / proposal endpoint.** `POST /api/projections/{view_slug}/assist` — body `{ message, transcript_ref? }`; auth owner/edit; returns `{type:"answer",text}`, `{type:"narrative_proposal",body_md}`, or `{type:"projection_proposal",change_set}`. Runs the LLM tool-call (NL → change set) under SECURITY §6 LLM-safety invariants (untrusted-data framing, injection-marker stripping, extract-only). **The LLM returns intent + change set only — never a computed figure.** The app then calls `/preview` for numbers. Rate-limited like `:regenerate`.

**Hard rule binding both:** the diff/proposal card renders **only** values returned by `/preview` (the engine). The LLM is never permitted to emit a computed figure as fact (CLAUDE.md, PRD §13).

---

## 1. Spatial grammar (resolves the drawer-collision conflict)

The prototype fixes the **Override Inspector on the RIGHT** (`right:0; width:420px; z-index:51`, scrim `rgba(11,27,20,.32)` `z-index:50`, top bar `z-index:30`, `translateX(100%)→0`). Therefore:

| Edge | Surface | Role | Verb |
|---|---|---|---|
| LEFT | **AI chat** | generative — converse / draft / propose mutations | "change / draft" |
| CENTER | **Narrative canvas** | the artifact — board prose that flows into the packet | "the document" |
| RIGHT | **Override Inspector** (exists) | forensic — audit / reset pins | "inspect" |
| TOP BAR | feedback lightbulb (exists) | bug capture | — |

The chat flies from the LEFT by deliberate mirror of the right Inspector: `translateX(-100%)→0`.

**z-index (explicit):** top bar `30` < chat scrim `51` / chat panel `52` (one above the Inspector's `50/51` so a later-opened chat never renders under it). On desktop both are non-modal so scrims are suppressed (no double-dim). Feedback modal keeps `70/71`.

**Coexistence / mutual exclusion (airtight breakpoint rule):**
- **≥1180px:** chat (380px left, **non-modal**) and Inspector (420px right, non-modal) may both be open; center ≥ ~600px; siblings with loose focus traps (`aria-modal=false`); opening the chat does not steal focus from an open Inspector; only one active focus ring at a time.
- **<1180px:** both become **modal full-screen sheets, mutually exclusive** — opening one **closes the other and announces it** (`aria-live=polite` "Override inspector minimized"); focus returns cleanly. No two-scrim / two-trap fight. QA-gated at 768/375.

---

## 2. Narrative canvas (center column)

**Placement:** LAST primary card on the Projection tab — below Sensitivity, directly above Export Board Packet / Download `.xlsx` (PRD §19.3; replaces the "Narrative (secondary)" stub). An **in-page editable canvas, NOT a modal/drawer** — board prose is a first-class document.

**Layout:** warm-white `#ffffff` card on `#faf9f6`; hairline `#ededed` border; **1px brand `#35644f` left rule** marks it the board-facing artifact; 13–14px body, generous leading, **max ~68ch**, system-sans. **Header:** "Board narrative" · provenance chip "Drafted by AI · grounded to your numbers" (sparkle + text) · status pill · "Last saved 2:03 PM" · kebab (Regenerate, Revert to AI draft, Copy, View source facts) · sparkle **"Revise with AI"** (opens chat pre-scoped to Narrative with `body_md` context). **Footer:** docx-linkage line "This is the prose your Board Packet (.docx/.pdf) will contain" + **"Preview in packet →"** (`GET …/packet`, terms-gated — routes through terms acceptance if unaccepted) + provider/model footnote.

**Edit affordance — inline, in place (no editor swap):** the rendered markdown IS the editor; click to caret, same metrics so **text never reflows/jumps**; always editable with owner/edit token (no mode toggle on desktop). Format bar on selection = **bold, italic, list, link only**, `href` ∈ `http|https|mailto` — **the visible contract for the server `bleach` allowlist** (`p`, headings, `ul/ol/li`, `strong`, `em`, `blockquote`, `code`, `a[http|https|mailto]`; SECURITY §5). No raw HTML/color/style. Disallowed paste markup stripped client-side (DOMPurify, belt-and-suspenders) + toast "Some formatting was removed to keep this safe to share." View-only holders → read-only with "Editing needs the edit link" (never a dead-end 403).

**Save & the sacred `edited` flag:** autosave, **no Save button** — debounced PUT `…/narrative` on blur/settle (~400ms) with `If-Match`; server sanitizes `body_md` and returns `edited:true`; pill "Saving…" → "All changes saved". **`edited=true` is sacred (PRD §17): regenerate is never silent; never auto-overwrite.** Offline → retry pill + local draft. 409 → band with **[Reload latest]/[Keep mine (overwrite)]/[Save as copy]** (PRD §19.4); every save writes a revision; the discard-warning band links to Revisions.

**States (icon + text + shape, never color alone):**

| State | Condition | Treatment |
|---|---|---|
| **Clean / AI draft** | `edited=false` | "Drafted by AI · grounded"; pill hidden or "Saved" + check. |
| **Edited** | `edited=true` | Pill "Edited by you" + pencil glyph, tan `#cbb7a9` dot; overflow gains "Revert to AI draft"; guarantees regenerate warns-before-replace. |
| **Saving** | PUT in flight | "Saving…" + ring; reduced-motion → static. |
| **Stale** ⭐ | `GET` → `stale:true` + `stale_diff` (`computed_hash` ≠ live) | Non-destructive **warning band** at card top: `#fef3c7` fill, `#b45309` triangle + "The numbers changed since this narrative was written" + **was→now diff list** straight from `stale_diff`. Actions **[Show what changed] / [Regenerate] (`:regenerate`) / [Keep my version]** (→ collapses to a persistent "out of date" chip, never fully hidden, stays `edited`). If `edited=true`: Regenerate demoted to secondary + "Regenerating will discard your edits — we'll keep a copy in Revisions" behind a confirm. **Never blocks reading/editing; never auto-regenerates.** Same diff vocabulary as chat + Inspector. |
| **Regenerating** | `:regenerate` in flight | Body dims ~60%, **one** opacity-pulse shimmer (NOT moving gradient); reduced-motion → static "Regenerating…"; streams in; Stop available; `aria-live=polite`; on success `edited=false` (server). |
| **Grounding rejection** | `409 grounding_failed` + `ungrounded_figures[]` | **Fails closed:** prior narrative untouched. "We couldn't verify a figure in the new draft, so we kept your current narrative" + ungrounded list with jump links. **Framed as catching a hallucination — a trust feature.** [Try again]/[Keep current]. |
| **AI disabled** | `ai_disabled:true` (PRD §21) | Sparkle/Regenerate → quiet note; manual edit + Save fully functional; empty state if no narrative; grounded-figure validation still runs (local, not an AI call). |
| **AI unavailable** | `503 ai_unavailable` | "Couldn't reach the AI writer — your saved narrative is unchanged. Try again." Manual + compute/`.xlsx` work. |

**Grounded-figure validation (trust spine, PRD §15/§17):** read mode → each `computed_json` figure gets a faint dotted underline (`#257648`) + "ƒ" glyph; popover "Sales per sq ft (Y1) · $60.99 · from the model" links to the row. Edit mode → a hand-typed figure not in `computed_json` gets a warning wavy underline (`#b45309`) + "Not a model figure — won't be verifiable in the packet." **Save blocked** while ungrounded figures remain; foot banner lists each with one-click **"use the model's value"** — mirrors server `grounding_failed`/`ungrounded_figures[]`. **Client check is courtesy; server is authority on PUT/regenerate.** **Anti-false-positive contract:** match against a **server-emitted canonical figure list + display variants** (`$277,990` ↔ `$278k`), not a client regex.

**Mobile-375:** full-width; read-only by default + sticky **"Edit narrative"** (44px) → full-screen editor sheet with [Done]; format bar → sticky bottom toolbar above keyboard; stale diff stacked; popovers tap; save state in a thin top strip.

**A11y:** `role=region` "Board narrative", `aria-describedby` pill; Tab→Enter edits→Esc blurs (**Esc = blur, not discard**); format bar = `toolbar` roving tabindex + AA focus rings; grounded popovers keyboard-reachable; status/errors `aria-live=polite`, hard save-block `assertive`; AA amber `#b45309`/`#fffbeb`, error `#dc2626`/`#fef2f2`; reduced-motion kills shimmer/slide.

---

## 3. AI chat (fly-out, LEFT)

**Collapsed FAB:** stars/sparkle bottom-LEFT, content-inset (never overlaps table scrollbar/primary actions), 48px, brand `#35644f` on white pill, **label "Ask AI"** (`aria-label="Ask AI about this projection"`); auto-hides on scroll, reappears on scroll-up; Enter/Space opens, `aria-expanded`, `aria-haspopup=dialog`; count badge **only** for a pending proposal awaiting review or a completed background answer.

**Open layout:** `translateX(-100%)→0`. **≥1180px: 380px non-modal** (center stays interactive, dim ~8% only). **<1180px: full-screen modal sheet, focus-trapped.** Header: sparkle + "AI assistant" · **disclosure line reflecting the ACTUAL provider** ("Sends this projection's figures to Anthropic" / "…to OpenAI" on fallback) + info popover (fallback + opt-out, PRD §21) · × close · New chat. Footer composer: multiline input + send + always-visible **scope chip "Editing: Narrative" / "Editing: Projection"** + suggestion chips. Esc closes → focus to FAB.

**Message model — two clearly-typed actions, never blended:** transcript `aria-live=polite`; user right (`#35644f` tint), assistant left (white); assistant **restates intent in the first line**. (1) **Narrative** → **prose diff card** (additions green, deletions struck), [Apply to narrative]/[Discard]; Apply → PUT `…/narrative` (sanitized + grounded; `ungrounded_figures` blocks). Can also answer questions with source-tagged figures. (2) **Projection** → the core trust flow (§3.4). Header literally says **"Changes the narrative wording"** vs **"Changes the projection (Capital, Break-even…)."**

**Core trust pattern — reviewable diff before apply:** chat **must NOT compute.**
1. User asks in NL. 2. `POST …/assist` → tool-call → **change set only** (`{assumptions:{labor_pct:0.55}}` / `{overrides:{set:[{node:"Payroll",year:2,value:850000}]}}` / scenario delta). 3. `POST …/preview` → **server** recomputes via the same DAG, no mutation → diffed view-model. 4. **Proposed Change Card renders only after preview** (skeleton "Calculating…" until then): header "Proposed change — preview, nothing saved yet"; "what you're changing" line (for a pin: **calc vs override** like the Inspector + editable note); **Before→After table** of the affected rows AND decision metrics (Capital, Break-even, Cash gap, Net margin, Net profit, **Recommendation chip**) each **was→now**, negatives `($8,400)` `#dc2626` + glyph + parens (never color alone); footer **"Calculated by the model engine · `model_version`"**; **guardrail badges** ("requires a justification note in the packet"); destructive proposals get an extra confirm line; **non-pinnable asks → `422 node_not_pinnable`** answered in plain language ("Net profit is a calculated total… want to set Labor % instead?"), **no Apply**; actions **[Apply change]** (disabled until preview returns) / **[Discard]**; **what-if defaults to non-applied** ([Apply] + [Keep as a scenario only]). 5. **Apply = the ONLY mutation:** real `PATCH §4.4` + edit token + `If-Match` → recompute, `version++`, one revision; auto-clear-on-equal + `"{node}#{year}"` are the server's; guardrail justification prompted inline before Apply.

**Confirm/undo:** toast "Applied — saved as a revision" + **[Undo]** (inverse PATCH or `revisions/{id}/restore`); **Undo = "restore prior revision as a new revision," not erase**; revision granularity isolates the AI delta. **409 on Apply** → "re-check before applying" + **[Re-preview]**.

**Streaming:** text streams + Stop; tool/preview steps show "Asking the engine to recompute with labor 55%…"; **projection proposals never stream a fake number** (skeleton until `/preview`); reduced-motion → single settled render.

**Error/AI-off:** disabled → muted FAB + Settings deep-links; **chat is never the only path to a change.** `503` → "Both AI writers unavailable — numbers + manual editing still work"; **in-flight proposal preserved as still-Appliable** (its numbers came from the engine, not the LLM). `grounding_failed`/`429`/parse-failure handled with plain language, no mutation.

**A11y:** `role=dialog`, labelled, loose trap (`aria-modal=false` desktop), Esc→FAB; transcript `log`, proposal cards announce a **concise summary** not the whole table; Before→After is a real `<table>`; deltas use glyphs + parens; AA throughout.

**Mobile-375:** full-screen sheet; composer above keyboard; chips horizontally scrollable; diff card stacks **fully reviewable inline**; Apply/Discard sticky 44px bar; **preferred path for bounded numeric changes on phone — but still requires explicit Apply.**

---

## 4. The critical coupling — three surfaces, one truth

Numbers flow **one way: engine → canvas.** The chat is another input device for the same PATCH/PUT, never a second source of truth.

- **4.1 Projection change → narrative stale:** any `computed_json` change (chat OR manual) flips the canvas to **Stale** with `stale_diff` + Regenerate. **Must flip on ANY source** (PRD §17). Chat offers a one-tap "The numbers moved — update the narrative?" follow-up; it never auto-rewrites.
- **4.2 Convergence with Inspector:** a chat-applied pin is **identical** to a manual pin (`"{node}#{year}"`, calc-vs-override, affected chips, note, Reset). Inspector live-updates + announces "1 override added by AI."
- **4.3 Focus on apply:** focus returns to the recompute target; `aria-live=polite` on the decision banner ("Recommendation changed to Revise") so SR/keyboard users aren't stranded.
- **4.4 `edited` classification:** full regenerate → `edited=false`; chat-applied targeted tweak the user accepts → `edited=true`. Needs an **explicit server contract for "chat-assisted partial edit"** on the PUT path or §17 fails.
- **4.5 Shared vocabulary:** **was→now** is identical across stale diff, projection card, and Inspector; **"Calculated by the model engine"** provenance is identical on canvas + chat figures.

---

## 5. Risk register → enforced mitigation (priority order)

1. **Chat as second math authority** → card binds only to `/preview`; skeleton-until-engine; engine-provenance footer; LLM never emits a figure. Enforced in code.
2. **Mutating without review** → every change through diff card + explicit Apply; auto-apply forbidden; no auto-apply toggle.
3. **Stale not surfaced after chat change** → flip on any `computed_json` change; `computed_hash` covers the chat PATCH path.
4. **Ungrounded figure in .docx** → server validates on PUT + `:regenerate`; client is courtesy.
5. **Stored XSS = token theft** → server `bleach` authority; toolbar = visible allowlist.
6. **Silent overwrite of hand edits** → `edited=true` gates every AI overwrite behind explicit confirm + Revisions copy.
7. **Edit-token dead-end** → Apply disabled with "Editing needs the edit link," never a raw 403.
8. **Two panels / two scrims / two traps** → <1180px mutually exclusive modal (one closes other, announced); ≥1180px non-modal; single focus-owner; documented z-order; QA 768/375.
9. **409 on Apply** → `If-Match` + [Re-preview]/reload/overwrite/save-as-copy.
10. **Confirmation fatigue** → heavy confirm only for reco-flip / override-touching changes; batch proposals; never auto-apply.
11. **Client grounding drift** → match server canonical figure list + variants; defer to `grounding_failed`.
12. **Undo perceived as data loss** → "restore prior revision as a new revision"; isolate the AI delta.
13. **Prompt injection via projection content** → untrusted-data framing + post-gen grounding (SECURITY §6.3); chat prose passes the same validator.
14. **Provider-disclosure drift** → disclosure reflects actual provider, visible at point of sending.
15. **Reduced-motion / AA / mobile-keyboard** → static fallbacks; icon+text on AA surfaces; toolbar never under keyboard; QA at 375 + screen reader.

---

## 6. Build dependencies (for engineering)
- **NEW:** `POST …/preview` (dry-run compute; no mutation/version/revision; diffed view-model; mirrors PATCH 422s).
- **NEW:** `POST …/assist` (LLM NL→change-set / narrative-proposal / answer; SECURITY §6 invariants; rate-limited like `:regenerate`).
- **Server must emit:** canonical grounded-figure list + display variants (anti-false-positive, §2.5).
- **Server contract:** explicit "chat-assisted partial edit" vs "regenerate" signal on narrative PUT so `edited` is set right (§4.4).
- **Reuses as-is:** PATCH §4.4 (overrides.set/clear, `If-Match`, 409, auto-clear-on-equal, `node_not_pinnable`), narrative GET/PUT/`:regenerate` §6.1 (`stale`/`stale_diff`/`grounding_failed`/`ai_disabled`/`ai_unavailable`), revisions §5, packet §6.4, `bleach` §5, brand tokens §6.

---

**Spec saved to:** `/Users/andydownard/.claude/plans/shimmering-dreaming-sphinx-agent-ac93d9904f2afc40e.md`

**Key conflict resolutions made:** (a) LEFT chat / CENTER canvas / RIGHT Inspector spatial split with an explicit ≥1180px-coexist vs <1180px-mutually-exclusive rule and documented z-order grounded in the prototype's real tokens (`right:0; width:420; z-index:50/51`); (b) inline-in-place edit (no modal/mode-toggle) on desktop, full-screen editor sheet on mobile-375 (Apple's mobile concession adopted over desktop's always-inline for touch ergonomics); (c) the diff card binds **only** to a new server `/preview` dry-run — surfaced as a **blocking API gap** since neither `/preview` nor a chat endpoint exists in API_SPEC today; (d) `edited`-flag classification for chat-applied partial edits flagged as needing an explicit server contract. The two new endpoints and the canonical-figure-list emission are the load-bearing build prerequisites.
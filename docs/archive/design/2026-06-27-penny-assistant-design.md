# Design: Penny — Agentic Projection Assistant (Spec B)

**Date:** 2026-06-27 · **Status:** Approved design (pre-plan) · **Spec:** B of 2
**Depends on:** `2026-06-27-create-projection-wizard-and-pre-opening-design.md` (Spec A — cost-schedule data model, pre-opening engine, full-page wizard, the shared `TopBar`).
**Reconciles with:** the prior `epic:N` cut (`docs/design/ai-narrative-assistant.md`, issues N1/N2/N8/N9/N10/N13). See §13.

> One sentence the whole spec defends: **Penny is another input device for the same server-authoritative mutation path — she recommends, narrates, applies through `PATCH`/`If-Match`, and every edit is an `actor:penny` revision that is reversible per-field and in the global history; she never computes a number and never mutates outside server validation.**

---

## 1. What Penny is

**Penny** is an AI assistant (custom avatar `penny-avatar.png`) presented in a **left slide-out drawer**, available on **two surfaces**:

1. **The Create-Projection wizard** (Spec A's full-page `/wizard`) — a **full draft assistant**: she can help with any wizard field (name, address resolution, households, donor shares) and **build the cost schedule from an uploaded consultant proposal**. Conversation is **draft-scoped / ephemeral** (no projection exists yet) and edits mutate the in-memory wizard draft, narrated + per-field undoable, until **Generate** persists the projection.
2. **The projection detail page** — an agentic editor over a saved projection: she changes inputs, assumptions, overrides (pins), and the cost schedule. Conversation **persists per projection** (a new transcript store, §7).

Penny is **never a second source of truth and never computes.** Numbers come only from the engine via the normal mutation/recompute path. She mirrors the existing **right-edge Override Inspector** by flying in from the **LEFT** (`translateX(-100%)→0`).

**AI-disabled fallback:** when AI is opt-out or no provider key is configured, **Penny is hidden** (FAB muted with a Settings deep-link, never a dead-end), and **every manual path remains fully intact** — the wizard, the cost-schedule editor, the Override Inspector, and all exports work with zero AI calls (PRD §21; CLAUDE.md rule "AI opt-out must work end-to-end").

---

## 2. Interaction model — apply-immediately + narrate + per-field undo

**Decided (2026-06-27): apply-immediately, NOT a propose→approve gate.** This is the deliberate departure from the prior `epic:N` "propose → preview → diff card → Apply" flow (N10). Rationale: for a non-finance ED the approve-every-diff gate is friction; trust comes instead from (a) Penny stating intent *before* she acts, (b) stating the result *after*, and (c) cheap, obvious, per-field reversal.

Every Penny edit follows the **narrate → act → narrate** shape:

1. **Recommend + state intent.** Penny names what she is about to do in plain language, in the transcript: *"I'll set the donor-market share to 8% for Year 1 — that's the benchmark for a first store."*
2. **Act.** She calls the matching tool (§6), which routes through the **normal mutation path** (`PATCH` + `Bearer` + `If-Match` → recompute → version++ → one revision tagged `actor:penny`). On the wizard, the equivalent acts on the draft.
3. **State completion.** Penny reports what changed and the engine's effect: *"Done. Year-1 share is now 8%. Break-even moved from month 7 to month 6."* Decision-metric deltas she quotes are read back from the **recomputed view-model**, never invented.

There is **no diff card to approve.** The reversal affordance is the **per-field undo** (§3) plus the **global revision history** (Revisions / restore).

---

## 3. Change UX — recent change, previous value, per-field undo

When Penny (or the user, manually) changes a field, the field renders a three-part affordance, inline on the projection detail page and on wizard fields:

| Element | Treatment | Purpose |
|---|---|---|
| **Recent change** | the **current value is visually prominent** — a brief highlight ring/badge ("changed by Penny", icon + text, never color alone) that persists for the session until acknowledged or superseded | draw the eye to what just moved |
| **Previous value** | shown **subtly** next to the field (muted, smaller, e.g. "was 6%") | one-glance context for the change |
| **Per-field undo** | a **small undo icon** adjacent to the previous value; activating it reverts **that one field** to its previous value | cheap, surgical reversal without touching anything else |

**Semantics of per-field undo:**
- Per-field undo is a **forward operation, not history erasure.** It issues a normal `PATCH` setting the field back to its prior value → recompute → version++ → **a new revision** (tagged `actor:penny_undo` or `actor:user_undo`). It never rewrites or deletes the revision that introduced the change. (Mirrors the existing "Undo restores prior revision as a NEW revision, never erase" rule from N10.)
- The "previous value" tracked per field is the value **immediately before the most recent change to that field** (single-step inline undo). Deeper history is the **global revision timeline**, not the inline affordance.
- After a per-field undo, the field shows the *new* recent-change state ("reverted — was 8%") so the action is itself visible and re-undoable.

**Coexistence with the global revision history:**
- The **global revision history** (existing Revisions panel / restore) is the **complete, multi-step, whole-projection** timeline. Every Penny edit AND every per-field undo appears there as its own revision, tagged with `actor` (`penny` / `penny_undo` / `user` / `user_undo`) so the audit trail attributes each change.
- **Per-field inline undo** is the **fast path for the last change to one field**; **restore-a-revision** is the path for "take the whole projection back to a known state." They never conflict because both are just forward `PATCH`es producing new revisions — the engine/version is always the single source of truth.
- The inline "recent change / was X" affordance is **derived from the diff between the current `computed_json` and the immediately-prior revision's `computed_json`** (server-emitted `changed[]` with `{node, was, now}` per the existing was→now formatter), so the client renders it without computing anything.

---

## 4. Agentic edits — full, bounded by the server

Penny can change **inputs, assumptions, overrides (pins), and the cost schedule**. Every edit is bounded by exactly the same authority the manual UI is bounded by — there is **no privileged Penny path**:

- **Auth + concurrency:** each edit is a `PATCH /api/projections/{view_slug}` carrying the caller's **`Bearer` edit token** and the current **`If-Match: <version>`**. A `409` (someone else moved the version) is surfaced to Penny, who re-reads and retries or tells the user.
- **Capability-gated:** a **view-only** caller's Penny **cannot mutate** — she degrades to answer-only ("you'd need the edit link to change this"). Penny's reach is exactly the caller's token capability.
- **Server validation is the wall:** override-DAG topological rules, **non-pinnable cells rejected `422 node_not_pinnable`** (derived rows / totals / KPIs), input domain checks, and cost-schedule validation (`month ≥ 1`, `amount ≥ 0`, `opening_month_number ≥ 1`) all apply unchanged. If Penny proposes an illegal edit the server rejects it and Penny relays the rejection in plain language and offers the legal alternative ("Net profit is a total I can't pin — want me to set Labor % instead?").
- **Audit:** every applied edit writes a revision with `actor:penny` (and the originating transcript turn id) so the provenance is auditable and shows in the revision timeline.
- **No client math, no LLM figures:** Penny's tool calls carry **intents** (set this input to this value). She never asserts a computed figure; the server strips any literal computed money/percent the model emits in a tool argument that isn't a user-provided input value (extends the N2 strip rule).

---

## 5. Surface & layout

### 5.1 Detail page (drawer)
- **Collapsed FAB:** Penny avatar, bottom-**LEFT**, content-inset (never over the table scrollbar / primary actions), 48px, brand `#35644f` pill, label "Ask Penny" (`aria-label` "Ask Penny about this projection"), `aria-haspopup=dialog`, `aria-expanded`. Auto-hides on scroll-down, returns on scroll-up. Enter/Space opens.
- **Open layout:** flies `translateX(-100%)→0`. **≥1180px:** 380px **non-modal** left panel (center stays interactive); may coexist with the right Override Inspector (§10). **<1180px:** full-screen modal sheet, focus-trapped, mutually exclusive with the Inspector (§10).
- **Header:** Penny avatar + "Penny" · provider disclosure line reflecting the **actual** provider (Anthropic/OpenAI, from §8) + info popover (fallback + opt-out) · New chat · × close.
- **Transcript:** `aria-live=polite` log; assistant restates intent (line 1) before acting; streaming prose with Stop; **never streams a number** (decision-metric deltas appear only after the engine recomputes). Reduced-motion → single settled render.
- **Composer:** multiline input + send + suggestion chips + a **proposal upload** affordance (PDF) that routes to `parse_proposal` (§6, §9).

### 5.2 Wizard (full-page draft assistant)
- Penny appears as the **same left drawer** within the full-page `/wizard` (Spec A chose a full-page wizard specifically so this drawer composes cleanly). Because there is no projection, edits act on the **wizard draft state** and the transcript is **ephemeral/draft-scoped**.
- She can fill or refine **any** wizard field (Store name, address → triggers the Places resolve, households, Year-1/2/3 shares) and **build the §5 cost schedule** from an uploaded proposal (§9). All draft edits are **narrated + per-field undoable** exactly as on the detail page.
- On **Generate**, the draft (including any Penny-built schedule with provenance) is persisted as the projection; the ephemeral transcript is discarded (or optionally seeded as the first detail-page transcript turn — implementation detail, default discard).

---

## 6. Tool surface + server tool-use loop

### 6.1 The loop
`POST …/penny` runs a **bounded server-side tool-use loop**: send the system prompt + grounding context + transcript + user message to the provider; the model replies with either prose (an answer / narration) or one or more **tool calls**; the server executes each tool, appends the tool result, and re-invokes the model; repeat until the model emits a final assistant message or a **hard cap** is hit. Caps: **max tool iterations per turn**, **max input/output tokens**, and **per-turn / per-projection / per-token+IP cost & rate limits** (429 with `retry_after_seconds`). Grounding context = the current `computed_json` facts + the editable surface; the user message and any proposal text are wrapped as **untrusted DATA** with extract-only / ignore-embedded-instructions framing and injection-marker stripping (SECURITY §6.3).

### 6.2 The tools (no additions/removals from the confirmed set)

| Tool | Kind | Behavior |
|---|---|---|
| `read_projection` | read | Returns the current grounded facts (`computed_json` view-model rows, decision metrics, editable surface, current cost schedule). The only way Penny "knows" numbers. |
| `parse_proposal` | read / extract | Given the uploaded consultant proposal (PDF, untrusted data), **extract-only**: pull candidate cost line-items, tiers, and phase descriptions. **Numbers must come from the document**; nothing invented. Returns structured candidates for `edit_cost_schedule` (§9). |
| `set_input` | mutate | Set a wizard/projection **input** (name, address, households, target opening date, opening month #). Routes via `PATCH`/`If-Match` (or draft on wizard). |
| `set_assumption` | mutate | Set an **assumption** (donor shares, labor %, supplies %, marketing %, rent, escalator, …). Same mutation path; server domain-validates. |
| `set_override` | mutate | **Pin** a DAG node (`{node}#{year}`) to a value with a note. Server enforces non-pinnable rejection + DAG rules. |
| `clear_override` | mutate | Remove a pin (`{node}#{year}`); auto-clear-on-equal stays server-owned. |
| `edit_cost_schedule` | mutate | Add / edit / remove timed cost rows (`{category, month, amount}`) and set the opening anchor, with AI-populated **provenance** on rows she creates. Server-validated (§5 of Spec A). |

All `mutate` tools converge on the **same server mutation/recompute path** used by the manual UI — they are not a parallel writer. Each returns the **recomputed view-model diff** (`changed[]` was→now) so Penny can narrate the engine's effect truthfully.

---

## 7. Transcript store (per-project)

A new **`penny_transcripts`** store (additive migration, no DROP; app-generated string PK; `Store`-interface clean so the Postgres path stays drop-in):

- `id` (ULID) · `projection_id` (FK; NULL for ephemeral wizard drafts — those are **not persisted**) · `created_at` · `updated_at`.
- `turns`: ordered list of `{role: user|assistant|tool, content, tool_name?, tool_args?, tool_result_ref?, revision_id?, provider?, ts}`. `revision_id` links a turn that mutated to the revision it produced (provenance ↔ §4 audit).
- Scoped + owner-scoped read: `GET …/penny/transcript` returns the persisted transcript for a projection (owner/edit token). Wizard-draft transcripts live only in client state until Generate and are never written.
- Retention/size: cap stored turns per projection; truncate oldest tool payloads (keep the human-readable summary). No financial leakage beyond what the projection already contains for that owner.

---

## 8. Model & provider policy

- **Primary:** the **most capable Anthropic model available** (per CLAUDE.md "AI: Anthropic primary"). Tool-use loop runs against Anthropic first.
- **Fallback:** **OpenAI** equivalent when Anthropic errors/at-capacity; the response/disclosure line reflects the **actual** provider used (`{provider: anthropic|openai}`).
- **AI-disabled:** opt-out or no key → **zero provider calls**, Penny hidden, manual paths intact (`409 ai_disabled` if the endpoint is hit directly). `503 ai_unavailable` when both providers fail.
- Keys are **server-side env only** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); never to the client, never in a URL/log (CLAUDE.md rule 7).

> Model-id note: resolve the concrete "most capable" Anthropic model id at build time against the current model line; do not hard-code a snapshot that silently ages. Capture the chosen id + the OpenAI fallback id in the plan.

---

## 9. Proposal → cost-schedule flow (and month mapping)

The "work with AI to build the schedule" behavior (moved out of the wizard's manual scope into Penny):

1. **Upload** the consultant proposal PDF in the Penny composer (wizard or detail page).
2. **`parse_proposal` (extract-only):** Penny extracts candidate line-items, **tiers/packages**, and **phase descriptions** ("Phase 1: design & permitting", "Phase 2: build-out", "Soft open"). PDF is **untrusted data** — no embedded instruction is obeyed; every dollar figure must be traceable to the document.
3. **Disambiguation:** when the proposal offers **multiple tiers or optional line-items**, Penny **asks which** ("This proposal has Standard and Premium build-out — which should I use?") before populating anything.
4. **Phase → month # mapping (infer + confirm):** Penny maps each phase description to a **project month #** relative to the opening anchor, by inference (sequence + any stated durations/dates in the proposal), then **states the mapping and asks for confirmation** ("I read three phases over ~4 months before opening, so I placed them in months 1–4 with grand opening at month 5 — look right?"). The user confirms or corrects; Penny adjusts via `edit_cost_schedule`.
5. **Populate:** Penny writes the rows via `edit_cost_schedule` with **AI-populated provenance** on each row; the user edits afterward in the normal cost-schedule editor. Per-field undo + revision history apply.

The result feeds Spec A's pre-opening engine unchanged — Penny only fills the schedule the engine already consumes.

---

## 10. Spatial grammar & coexistence (supersedes N9)

| Edge | Surface | Role |
|---|---|---|
| **LEFT** | **Penny** drawer | converse / draft / apply edits |
| **CENTER** | projection detail (tables/chart/narrative) or wizard step | the artifact |
| **RIGHT** | **Override Inspector** (exists, z `50/51`) | forensic — audit / reset pins |
| **TOP BAR** | Idea Fab lightbulb (exists) | feedback |

- **z-index:** top bar `30` < Penny scrim `51` / Penny panel `52` (one above the Inspector's `50/51` so a later-opened Penny never renders under it); feedback modal `70/71` on top.
- **≥1180px:** Penny (380px left, **non-modal**) and Inspector (420px right, non-modal) may both be open; center ≥ ~600px; loose focus traps (`aria-modal=false`); opening Penny does **not** steal focus from an open Inspector; exactly one focus ring; desktop scrims suppressed (no double-dim).
- **<1180px:** both become **modal full-screen sheets, mutually exclusive** — opening one closes the other and announces it (`aria-live=polite`); focus returns cleanly.
- **Wizard:** the wizard is full-page (no right Inspector), so Penny is the only side panel there; same breakpoint behavior (non-modal ≥1180, modal sheet below).

---

## 11. AI-safety (CI-blocking) — extends N12

All edits are undoable revisions; on top of that, the existing AI-safety CI suite (N12) is extended with **Penny-specific invariants**, run with **stubbed providers**, **CI-blocking**:

- **Grounding:** any decision-metric/figure Penny states in prose must exist in the post-edit `computed_json` (read back via `read_projection`); a fabricated figure fails closed.
- **Extract-only / proposal injection:** a proposal PDF containing "ignore previous instructions" / "system:" / a planted bogus number is treated as data — markers stripped, instructions not obeyed, and no number not present in the document enters a tool argument.
- **Figure-strip in tool args:** a stubbed model that puts a *computed* money/percent into a mutate-tool argument (vs. a user-provided input value) is stripped/rejected server-side (extends the N2 rule to the tool loop).
- **Capability-gating:** a **view-only** caller's Penny cannot mutate (mutate tools refuse without an edit token); a **non-pinnable** target → `422`, relayed in plain language, no mutation.
- **DAG / domain guards:** illegal override or out-of-domain input proposed by Penny is rejected by the same server validation the manual path uses (single rejection authority).
- **AI-off / rate / fallback:** `ai_opt_out` → zero provider calls (`409`); both providers down → `503`; LLM bucket rate-limit → `429 retry_after_seconds`; provider parse-failure degrades to a plain answer, never a `500`.

---

## 12. API endpoints

| Endpoint | Auth | Body / notes |
|---|---|---|
| `POST /api/projections/{view_slug}/penny` | owner/edit Bearer | `{ message, proposal_ref? }`. Runs the §6 tool-use loop; **mutations happen inside the loop** via the normal `PATCH`/`If-Match` path (so version bumps + `actor:penny` revisions are produced as a side effect). Returns `{ turns_appended[], provider, applied_revisions[], narration }`. No top-level `If-Match` (the loop's internal PATCHes carry it). Errors: `409 ai_disabled`, `503 ai_unavailable`, `429 rate_limited`, `422` for rejected edits relayed to the model. |
| `GET /api/projections/{view_slug}/penny/transcript` | owner/edit Bearer | Returns the persisted per-project transcript (§7). |
| `POST /api/penny/draft` | edit Bearer (no projection yet) | Wizard-draft variant: `{ message, draft_state, proposal_ref? }`. Same loop, but **acts on the supplied draft** and returns the mutated draft + narration; **nothing persisted** (ephemeral transcript stays client-side). |
| `POST /api/penny/proposal` (upload) | owner/edit Bearer | Accepts the proposal PDF (server-side, untrusted), returns a `proposal_ref` for `parse_proposal`. SSRF/size/type guarded; never executed/rendered. |

`PATCH /api/projections/{view_slug}` (Spec A / existing) is **unchanged** — it gains only the `actor:penny` revision tag when the caller is the Penny loop. The per-field "recent change / was X / undo" affordance reads the existing `changed[]` was→now diff (no new compute).

Docs-Are-Code: add `/penny`, `/penny/transcript`, `/penny/draft`, `/penny/proposal` to `API_SPEC`; add the seven tool schemas + the loop's untrusted-data framing to `SECURITY §6.3`; add `penny_transcripts` + the cost-schedule `provenance` field + the `actor` enum on revisions to `DATA_MODEL`.

---

## 13. Reconciliation with the prior `epic:N` cut

The prior `epic:N` AI work split into a **narrative-canvas** half (N1, N3–N7, N11 — editable board prose) and an **assistant** half (N2, N8, N9, N10, N13). Penny **supersedes the assistant half** with the apply-immediately model and a tool-use loop, and **reuses the safety spine**:

| Prior issue | Disposition under Penny |
|---|---|
| **N2** — `…/assist` single NL→change-set, propose-only, no figures | **Superseded.** The new `…/penny` **tool-use loop** (PE-LOOP) + **tool surface** (PE-TOOLS) generalize it (multi-tool, agentic, applies via PATCH). N2's figure-strip + untrusted-data rules are **carried forward**. Close, cross-link. |
| **N8** — fly-out chat UI, propose/diff/Apply | **Superseded** by the Penny drawer (PE-DRAWER): same LEFT-edge fly-out, but **apply-immediately + narrate + per-field undo** instead of a diff-card Apply gate. Close, cross-link. |
| **N9** — spatial grammar / LEFT-chat ↔ RIGHT-Inspector coexistence | **Superseded** by PE-COEXIST (§10) — same z-order/breakpoint rules, restated for Penny + the wizard. Close, cross-link. |
| **N10** — proposed-change → preview → diff card → Apply | **Superseded / dropped.** The whole approve-every-diff gate is **replaced** by apply-immediately + per-field undo + revision history. The dependent dry-run endpoint **N1** (`…/preview`) is **no longer required by the assistant** (note on N1). Close N10, cross-link. |
| **N13** — mobile-375 + a11y for chat | **Superseded** by PE-A11Y — mobile drawer sheet + per-field-undo screen-reader review. Close, cross-link. |
| **N12** — AI-safety hardening (grounding/injection/rate/opt-out) | **Reused & extended.** Stays the base CI gate; PE-SAFETY adds the Penny tool-loop cases (§11). **Keep open**, add `epic:penny`, reference. |
| **N1** — `…/preview` dry-run | Built only for N10's diff gate. With N10 gone, **not required by Penny** (apply-immediately needs no dry-run). **Note** on N1; close unless the narrative-canvas half wants it. |
| **N3–N7, N11** — editable narrative canvas | **Out of Penny's scope** — distinct feature (board-prose editing). Left on `epic:N` untouched; Penny only *links to* the narrative (a "revise the narrative with Penny" entry can reuse it later). |

---

## 14. Assets

- **`penny-avatar.png`** — Penny's avatar, added to the app (FAB + drawer header). Lives at `web/public/penny-avatar.png` (served statically; referenced by the drawer + FAB components). Provide @1x/@2x or an SVG companion for crispness; respects reduced-motion (no animated avatar when reduced-motion is set).

---

## 15. Components & files (anticipated)

- **Frontend:** `web/public/penny-avatar.png`; `PennyDrawer.tsx` (drawer shell, FAB, transcript, composer, streaming, AI-disabled state); `PennyTranscript.tsx`; `ProposalUpload.tsx`; a **`FieldChange`** affordance (recent-change badge + "was X" + per-field undo icon) wired into the cost-schedule editor, wizard fields, and the detail-page editable cells; coexistence/z-order wiring shared with the Override Inspector; wizard integration in `CreateProjectionPage.tsx`.
- **Backend:** `app/routers/penny.py` (`/penny`, `/penny/transcript`, `/penny/draft`, `/penny/proposal`); `app/penny/loop.py` (tool-use loop driver + caps); `app/penny/tools.py` (the seven tools → existing mutation/recompute services); `app/penny/providers.py` (Anthropic primary / OpenAI fallback / disabled); `app/penny/proposal.py` (extract-only PDF parse, untrusted-data framing); `app/store/` migration for `penny_transcripts` + revision `actor` enum + cost-schedule `provenance`.
- **Docs:** `API_SPEC`, `SECURITY §6.3`, `DATA_MODEL` (Docs-Are-Code, same PR as the code).

---

## 16. Testing

- **Safety (CI-blocking, stubbed providers):** all §11 invariants.
- **Backend:** tool-loop happy path (each mutate tool → PATCH → version++ → `actor:penny` revision); capability-gating (view-only cannot mutate); non-pinnable → 422 relayed; cost-schedule validation via `edit_cost_schedule`; transcript persistence + owner-scoped read; wizard-draft variant persists nothing; provider fallback + `ai_disabled`/`ai_unavailable`/`429`; proposal parse extract-only + tier disambiguation.
- **Frontend:** per-field "recent change / was X / undo" (undo issues a forward PATCH → new revision, never erases); coexistence with the Override Inspector at 1180/below; FAB a11y + AI-disabled muted state; wizard draft assistant fills fields + builds schedule, all undoable; proposal upload → month-mapping confirm loop.
- **E2E:** detail-page — "Penny, set Year-1 share to 8%" → narrated apply → break-even moves → per-field undo reverts; wizard — upload a proposal → tier choice → month-mapping confirm → schedule populated → Generate persists with provenance.

## 17. Risks / open considerations

- **Apply-immediately blast radius:** mitigated by per-field undo + revisions + `actor:penny` audit + server validation as the wall; consider a soft cap on number-of-edits-per-turn that Penny narrates and confirms for large batches.
- **Month-mapping inference errors:** always confirm the phase→month mapping before/after populating; never silently guess.
- **Cost/rate control on the loop:** hard iteration + token caps and per-projection/per-token rate limits are required, not optional.
- **Model-id drift:** resolve "most capable Anthropic" at build time; don't pin an aging snapshot.

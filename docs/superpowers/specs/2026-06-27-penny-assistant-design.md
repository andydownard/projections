# Design Stub: Penny — Agentic Projection Assistant (Spec B)

**Date:** 2026-06-27 · **Status:** Decisions captured; full brainstorm pending after Spec A ships · **Depends on:** `2026-06-27-create-projection-wizard-and-pre-opening-design.md` (cost-schedule data model + pre-opening engine)

This is a placeholder capturing decisions already made, so the next brainstorm starts from them. Not yet a complete design.

## What Penny is

An AI assistant named **Penny** (custom avatar `penny-avatar.png`, to be added to the app) presented in a **left slide-out drawer**, available in the **Create-Projection wizard** and the **projection detail page**.

## Decisions made so far

- **Per-projection.** Chat + context are scoped to one projection; conversation persists per projection on the detail page (new assistant-message store). In the wizard (no projection yet) the conversation is draft-scoped/ephemeral until Generate.
- **Model:** the most capable model available (Anthropic primary per project rules; OpenAI fallback). Works-with-AI-disabled → Penny hidden, all manual paths intact.
- **Proposal parsing:** upload the consultant proposal PDF → Penny parses it (extract-only; numbers must come from the doc; PDF is untrusted data — no injection), asks **which tier / which line-items** when there are multiple options, then populates the §5 cost schedule (user edits after). This is the "work with AI to build the schedule" behavior, moved here from the wizard.
- **Agentic edits (full):** Penny can change assumptions, overrides, and the cost schedule, but always **recommends first, states what she will do, then does it, then states what she did**. Edits route through the normal mutation path (Bearer + If-Match → audit revision tagged `actor: penny`), bounded by server validation (override-DAG, non-pinnable cells) and the caller's token capability.
- **Change UX (per field):** the most recent change(s) are **visually prominent**; the **previous value is shown subtly** next to the field with a **small undo icon** that reverts **that field** to its previous value (per-field inline undo), independent of the global revision/restore.
- **Safety:** grounding + extract-only + injection-resistance enforced by CI tests (extending the existing AI-safety suite); every Penny edit is an undoable revision.

## Confirmed (2026-06-27)

- **Apply model:** apply immediately + narrate intent and completion + per-field undo (not a propose-approve gate).
- **Wizard scope:** **full draft assistant** — Penny can help with any wizard field (name, address resolution, households, shares) and build the cost schedule from a proposal, all narrated + undoable on the draft.
- **Tool set:** as listed below — no additions/removals requested.

## Open (for the Spec B brainstorm)

- Tool surface + server tool-use loop shape; transcript storage schema; rate/cost controls.
- Exact per-field "recent change / previous value / undo" interaction + how it coexists with the global revision history.
- How proposal parsing maps phase descriptions → month #s (inference + confirmation).
- Detail-page vs wizard capability differences.

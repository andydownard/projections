// web/src/pages/CreateProjectionPage.tsx — the full-page Create-Projection wizard.
//
// A full-page route rather than a modal, so Spec B's left-slide Penny drawer composes
// cleanly. One step is visible at a time over a prominent breadcrumb under a subtle
// "CREATE PROJECTION" eyebrow (owner Decision 17). State lives in the shared
// useWizardState hook. The step order (owner Decision 11) is Address → Square footage
// → Households → Donor market share → Startup costs; there is NO Review step. On the
// last step the primary button is "Generate projections": it shapes the collected
// inputs to the flat backend body, POSTs, and — on success — lands DIRECTLY on
// /p/<slug>/edit (owner Decision 12; no "projection ready" interstitial). Terms
// acceptance is IMPLICIT (owner Decision 5 — the disclaimer still shows + stamps
// artifacts). NO client math — the server computes (PRD §13 / CLAUDE.md hard rule).
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useToast } from "../components/Toast";

import {
  PennyError,
  sendPennyDraftMessage,
  uploadProposal,
  type PennyDraftApplied,
  type PennyDraftState,
} from "../api/penny";
import { newSessionToken, placesAutocomplete, placesResolve } from "../api/places";
import { researchRent } from "../api/research";
import type { ViewModel } from "../api/viewModel";
import { setEditToken, setOwnerToken } from "../api/projections";
import { authHeader } from "../api/authHeader";
import { PennyDraftAssistant } from "../components/PennyDrawer";
import { SidePanelProvider } from "../components/sidePanels";
import {
  buildCreatePayload,
  DEFAULT_OPENING_MONTH_NUMBER,
  toServerCreateBody,
  type CostScheduleRow,
  type WizardDraft,
} from "../wizard/shareHelper";
import { StepIndicator } from "../wizard/StepIndicator";
import { StepSelectAddress } from "../wizard/StepSelectAddress";
import { StepSquareFootage } from "../wizard/StepSquareFootage";
import { StepConfigureDonations } from "../wizard/StepConfigureDonations";
import { StepStartupCosts } from "../wizard/StepStartupCosts";
import { useWizardState, type WizardState } from "../wizard/useWizardState";
import {
  pathForStep,
  stepFromPath,
  STEP_LABELS,
  STEPS,
  type StepKey,
} from "../wizard/steps";

// Human labels for the server `draft_state` field keys Penny mutates (Spec §6.2),
// shown on each per-field FieldChange affordance in the wizard drawer. UI copy never
// says "trade area" (owner Decision 8); `target_opening_date` is gone (Decision 13).
const DRAFT_FIELD_LABELS: Record<string, string> = {
  name: "Store name",
  org_name: "Store name",
  city: "Address",
  address: "Address",
  households: "# of households",
  share_y1: "Year-1 donor share",
  share_y2: "Year-2 donor share",
  share_y3: "Year-3 donor share",
  share_y4: "Year-4 donor share",
  share_y5: "Year-5 donor share",
  basket: "Average basket",
  donation_value: "Donation value",
  occupancy_annual: "Annual occupancy",
  opening_month_number: "Opening month",
  cost_schedule: "Cost schedule",
};

function labelDraftField(field: string): string {
  return DRAFT_FIELD_LABELS[field] ?? field;
}

/** Mint an EPHEMERAL session Bearer for the wizard's /penny/draft calls. There is no
 *  projection (and no owner/edit token) yet, so this is only a rate-limit id; it is
 *  never persisted, never put in a URL/log, and dropped when the wizard unmounts. */
function makeWizardDraftToken(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return `wizdraft-${c.randomUUID()}`;
  return `wizdraft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Plain-language copy for a proposal upload / parse failure (#32). The manual grid +
 *  drag stay fully working, so this never blocks — it just tells the operator why
 *  Penny couldn't help and to lay the schedule out by hand. */
function friendlyProposalError(err: unknown): string {
  if (err instanceof PennyError) {
    if (err.kind === "ai_disabled")
      return "Penny is unavailable right now — set the schedule out by hand below.";
    if (err.kind === "ai_unavailable")
      return "Penny couldn’t reach her reader just now — try again, or set the schedule below.";
    if (err.kind === "rate_limited")
      return "Too many requests right now — please try again in a moment.";
    if (err.status === 413) return "That PDF is too large — try a smaller file.";
    if (err.status === 415) return "That file isn’t a PDF — attach the proposal as a PDF.";
    if (err.serverMessage) return err.serverMessage;
  }
  return "Couldn’t read that proposal — set the schedule out by hand below.";
}

/** Shape the live wizard state as the server `draft_state` Penny reads + mutates
 *  (Spec §5.2/§12). Pure field shaping — NO client math (mirrors shareHelper). */
function wizardToDraftState(wiz: WizardState): PennyDraftState {
  return {
    name: wiz.draft.name,
    inputs: {
      city: wiz.draft.city,
      org_name: wiz.draft.name,
      opening_month_number: wiz.draft.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER,
      target_opening_date: null,
    },
    assumptions: {
      share_y1: String(wiz.draft.shareY1),
      share_y2: String(wiz.draft.shareY2),
      share_y3: String(wiz.draft.shareY3),
      share_y4: String(wiz.draft.shareY4),
      share_y5: String(wiz.draft.shareY5),
      basket: String(wiz.draft.basket),
      donation_value: String(wiz.draft.donationValue),
      occupancy_annual: String(wiz.draft.occupancyAnnual),
    },
    trade_area: { households: String(wiz.householdsValue ?? wiz.draft.households ?? "") },
    cost_schedule: (wiz.draft.costSchedule ?? []).map((r) => ({ ...r })),
  };
}

export interface CreateProjectionPageProps {
  aiOff?: boolean;
  // Epic B (#261): the active step parsed from the route (/wizard/<step-slug>) by
  // the App shell. null = the bare /wizard or an unknown slug → redirect to the
  // current/first step. The page keeps the URL and the wizard cursor in sync so
  // browser Back/Forward navigate between steps and each step is deep-linkable;
  // the draft survives because this page never unmounts while on a /wizard route.
  step?: StepKey | null;
}

/** The step the cursor should START on, read from the deep-linked /wizard/<slug>
 *  URL so the right step renders on the first paint (no flicker). Non-wizard or
 *  unknown slugs start at the first step (the mount effect canonicalizes the URL). */
function initialStepFromUrl(): number {
  const s = stepFromPath(window.location.pathname);
  return s ? STEPS.indexOf(s) : 0;
}

export function CreateProjectionPage({ aiOff = false, step = null }: CreateProjectionPageProps) {
  const wiz = useWizardState(undefined, initialStepFromUrl());
  const { showToast } = useToast();

  // --- route ↔ step-cursor sync (Epic B #261) --------------------------------
  // The wizard cursor and the URL are kept in lock-step: a Next/Back/jump pushes a
  // new /wizard/<slug> history entry (so browser Back/Forward navigate steps), and
  // a browser Back/Forward (an external URL change → a new `step` prop) drives the
  // cursor. The draft lives in useWizardState above and is never unmounted across
  // this navigation, so no input is lost. Each guarded by an equality check so the
  // two directions converge instead of looping.
  const stepContainerRef = useRef<HTMLDivElement | null>(null);
  const mirrorInitRef = useRef(false);
  const adoptInitRef = useRef(false);
  const prevStepRef = useRef(wiz.step);
  const [stepAnnounce, setStepAnnounce] = useState("");
  const wizStepKey = wiz.stepKey;
  const wizStep = wiz.step;

  // Mount: canonicalize a bare/unknown /wizard URL to the current step's path. The
  // cursor already started on the deep-linked step (initialStepFromUrl), so a valid
  // slug is a no-op; a bare /wizard or unknown slug is REPLACED (no junk history
  // entry) with the current step — the invalid-slug redirect guard.
  useEffect(() => {
    const target = pathForStep(wizStepKey) + window.location.search;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState(null, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cursor → URL: when the cursor advances/retreats (Next/Back/jump), push a NEW
  // history entry and move focus to the new step heading + announce it (WCAG
  // 2.4.3 / 4.1.3). The first run (mount) is skipped so initial load never steals
  // focus and the mount effect owns canonicalization.
  useEffect(() => {
    if (!mirrorInitRef.current) {
      mirrorInitRef.current = true;
      prevStepRef.current = wizStep;
      return;
    }
    const target = pathForStep(wizStepKey) + window.location.search;
    if (window.location.pathname + window.location.search !== target) {
      window.history.pushState(null, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    if (prevStepRef.current !== wizStep) {
      const heading = stepContainerRef.current?.querySelector<HTMLElement>(
        ".wizard-step__heading",
      );
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
      setStepAnnounce(`Step ${wizStep + 1} of ${STEPS.length}: ${STEP_LABELS[wizStepKey]}`);
    }
    prevStepRef.current = wizStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizStep]);

  // URL → cursor: a browser Back/Forward (or a typed URL) changes the route `step`
  // prop. Adopt it into the cursor. A null prop (bare/unknown slug) is canonicalized
  // back to the current step. The first run (mount) is skipped — the cursor already
  // started on the right step via initialStepFromUrl.
  useEffect(() => {
    if (!adoptInitRef.current) {
      adoptInitRef.current = true;
      return;
    }
    if (step == null) {
      const target = pathForStep(wizStepKey) + window.location.search;
      if (window.location.pathname + window.location.search !== target) {
        window.history.replaceState(null, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      return;
    }
    const idx = STEPS.indexOf(step);
    if (idx !== -1 && idx !== wizStep) wiz.goTo(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const [busy, setBusy] = useState(false);
  // Task 2.5 (audit P0): a failed Generate (network reject, non-2xx response, or a
  // malformed body missing view_slug) must never navigate — it surfaces this alert
  // with a Retry that re-invokes Generate against the still-intact draft.
  const [generateError, setGenerateError] = useState<string | null>(null);
  // #32 — the contextual proposal upload on the startup-costs step.
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  // One ephemeral Bearer for the whole wizard session's /penny/draft calls.
  const draftToken = useRef<string>(makeWizardDraftToken());

  // A polite live region that announces the blocking Generate transition to assistive
  // tech (the only async transition that warrants a between-steps spinner, #15).
  const generateStatus = busy ? "Generating your projection…" : "";

  // #245 — pre-fill rent (shown on the startup-costs step) from the server research
  // endpoint (extract-only, off the compute hot path). Fires once per resolved-location
  // + size + lease-basis key (a ref guards against refetch loops) as soon as an address
  // resolves, so the rate is pre-filled by the time the operator reaches the cost step.
  // With AI disabled or no resolved location we skip the call and the field stays the
  // anchored benchmark / manual entry. A failure degrades to manual — research NEVER
  // blocks the wizard (API_SPEC §19.2).
  const researchedKey = useRef<string | null>(null);
  const { resolved, draft, applyRentResearch, onRentResearchStart, onRentResearchError } = wiz;
  const buildingSqft = draft.buildingSqft;
  const leaseType = draft.leaseType;
  useEffect(() => {
    if (aiOff || !resolved || !(buildingSqft > 0)) return;
    const basis = leaseType === "gross" ? "gross" : "nnn";
    const key = `${resolved.location.place_id}|${buildingSqft}|${basis}`;
    if (researchedKey.current === key) return;
    researchedKey.current = key;
    onRentResearchStart();
    researchRent({
      buildingSqft,
      location: {
        geography_name: resolved.trade_area.geography_name,
        formatted_address: resolved.location.formatted_address,
      },
      basis,
    })
      .then((r) => applyRentResearch(r))
      .catch(() => onRentResearchError());
  }, [
    resolved,
    buildingSqft,
    leaseType,
    aiOff,
    applyRentResearch,
    onRentResearchStart,
    onRentResearchError,
  ]);

  // --- Penny (DRAFT mode) ↔ wizard bridge (Spec §5.2) ------------------------
  // She fills/refines any wizard field and builds the cost schedule by mutating the
  // in-memory draft via /penny/draft; her returned edits are mapped straight onto
  // the live wizard inputs (no client math) and persist nowhere until Generate.

  // When Penny sets the address, kick off the SAME Places→Census resolve the manual
  // combobox uses (households stay server-derived; the key never reaches the client).
  async function resolveDraftAddress(address: string) {
    if (!address.trim()) return;
    try {
      const session = newSessionToken();
      const preds = await placesAutocomplete(address, session);
      if (preds.length === 0) {
        wiz.onResolveError("location_not_found");
        return;
      }
      const resolved = await placesResolve(preds[0].place_id, wiz.basis, session);
      wiz.onResolved(resolved);
    } catch {
      wiz.onResolveError("network");
    }
  }

  // Map ONE server `draft_state` field key → the matching wizard setter. Used both to
  // apply Penny's edits and to undo a single field (a forward draft edit). Coercion
  // only — the projection numbers still come from the server on Generate (PRD §13).
  function applyDraftField(field: string, value: unknown) {
    switch (field) {
      case "name":
      case "org_name":
        wiz.set("name", String(value ?? ""));
        break;
      case "city":
      case "address":
        wiz.set("city", String(value ?? ""));
        void resolveDraftAddress(String(value ?? ""));
        break;
      case "households":
        wiz.setHouseholds(Number(value));
        break;
      case "share_y1":
        wiz.set("shareY1", Number(value));
        break;
      case "share_y2":
        wiz.set("shareY2", Number(value));
        break;
      case "share_y3":
        wiz.set("shareY3", Number(value));
        break;
      case "share_y4":
        wiz.set("shareY4", Number(value));
        break;
      case "share_y5":
        wiz.set("shareY5", Number(value));
        break;
      case "basket":
        wiz.set("basket", Number(value));
        break;
      case "donation_value":
        wiz.set("donationValue", Number(value));
        break;
      case "occupancy_annual":
        wiz.set("occupancyAnnual", Number(value));
        break;
      case "opening_month_number":
        wiz.set("openingMonthNumber", Number(value));
        break;
      case "cost_schedule":
        wiz.set("costSchedule", (value as CostScheduleRow[]) ?? []);
        break;
      default:
        break; // an unmapped field is ignored (the manual path is unaffected)
    }
  }

  // Apply EXACTLY what Penny changed this turn (named in `applied`), reading values
  // from the returned draft. Avoids clobbering fields the user is editing manually.
  function onApplyDraft(next: PennyDraftState, applied: PennyDraftApplied[]) {
    let scheduleTouched = false;
    for (const entry of applied) {
      if (entry.tool === "edit_cost_schedule") scheduleTouched = true;
      for (const c of entry.changed ?? []) applyDraftField(c.field, c.now);
    }
    if (scheduleTouched) {
      const sched = (next as { cost_schedule?: unknown }).cost_schedule;
      if (Array.isArray(sched)) applyDraftField("cost_schedule", sched as CostScheduleRow[]);
    }
  }

  // #32 — hand a consultant proposal PDF to Penny: upload the untrusted bytes, then ask
  // her (DRAFT mode) to read it and lay out the cost schedule + grand-opening month. Her
  // edits flow through the SAME draft bridge (onApplyDraft → cost_schedule +
  // opening_month_number) onto the live grid; nothing persists until Generate. Penny is
  // LIVE (owner Decision 1) so this is the shipped path, but it degrades gracefully — on
  // any failure the manual grid + draggable opening stay fully usable (no crash).
  async function handleProposalUpload(file: File) {
    setProposalBusy(true);
    setProposalError(null);
    try {
      const { proposalRef } = await uploadProposal({ token: draftToken.current, file });
      const resp = await sendPennyDraftMessage({
        token: draftToken.current,
        message:
          "I uploaded a consultant proposal PDF. Please read it and set up the timed startup " +
          "cost schedule and the grand-opening month from it.",
        draftState: wizardToDraftState(wiz),
        proposalRef,
      });
      onApplyDraft(resp.draft, resp.applied);
    } catch (err) {
      setProposalError(friendlyProposalError(err));
    } finally {
      setProposalBusy(false);
    }
  }

  // Generate: POST the create body and land DIRECTLY on the editable detail page
  // (owner Decision 12 — no in-page result view, no "projection ready" interstitial).
  // Task 2.5 (audit P0): a network reject, a non-2xx response, or a malformed body
  // missing view_slug must NEVER navigate (the /p/undefined/edit bug) and must never
  // fail silently — the draft stays intact and generateError drives the alert+Retry.
  async function onGenerate(d: WizardDraft) {
    setBusy(true);
    setGenerateError(null);
    try {
      const body = toServerCreateBody(buildCreatePayload(d));
      // Attach the Places->Census provenance so the server persists + emits it
      // (location for the detail map; trade_area + evidence for the panel).
      if (wiz.resolved) {
        const alt = wiz.resolved.trade_area.alternatives[wiz.basis];
        body.location = {
          query: body.location.query,
          place_id: wiz.resolved.location.place_id,
          lat: wiz.resolved.location.lat,
          lng: wiz.resolved.location.lng,
          formatted_address: wiz.resolved.location.formatted_address,
        };
        body.trade_area = {
          basis: body.trade_area.basis,
          households: body.trade_area.households,
          geography_name: alt?.geography_name ?? wiz.resolved.trade_area.geography_name,
          geography_fips: alt?.fips ?? wiz.resolved.trade_area.geography_fips,
          acs_vintage: wiz.resolved.trade_area.acs_vintage,
          households_source: wiz.householdsSource === "user_edited" ? "user_edited" : "census_acs",
          moe: alt?.moe ?? wiz.resolved.trade_area.moe,
        };
      } else {
        body.trade_area = { ...body.trade_area, households_source: "manual" };
      }
      // Send the owner identity (B3 data-loss fix): a signed-in Clerk owner sends
      // their JWT; an EXISTING capability owner sends their localStorage token so a
      // 2nd+ create JOINS that same workspace instead of minting a fresh token that
      // would orphan the prior projection. Capture whether any owner identity already
      // existed BEFORE this create so we only persist a genuinely new token.
      const owner = await authHeader();
      const hadOwnerIdentity = Boolean(owner.Authorization);
      const resp = await fetch("/api/projections", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...owner },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        setGenerateError(
          "Couldn't generate your projection — please try again.",
        );
        return;
      }
      const created = (await resp.json()) as ViewModel & {
        owner_token?: string;
        edit_token?: string;
      };
      // A 2xx with no view_slug is still a failure to navigate on (the
      // /p/undefined/edit bug) — treat it the same as a non-ok response.
      if (!created.view_slug) {
        setGenerateError(
          "Couldn't generate your projection — please try again.",
        );
        return;
      }
      // Persist a minted owner token ONLY when the request went out anonymous (no
      // pre-existing owner). Never overwrite an existing owner token — that single
      // localStorage slot is the only handle on the prior projection, and clobbering
      // it orphans that projection (the B3 data-loss bug). A Clerk-owned create also
      // returns a token, but the row is Clerk-scoped, so we likewise do not store it.
      if (created.owner_token && !hadOwnerIdentity) {
        setOwnerToken(created.owner_token);
      }
      // EPIC SHARE (Decision 12): retain the one-time edit token so the Share panel can
      // later build the editable deep link. The server returns it once and keeps only a
      // hash, so this localStorage slot (owner's device) is the only handle on it. Same
      // secrecy posture as the owner token — never a URL path/query, never logged.
      if (created.edit_token && created.view_slug) {
        setEditToken(created.view_slug, created.edit_token);
      }
      // Task 2.6: the draft became a real projection — clear the persisted local draft
      // so a return to /wizard starts clean (nothing left to resume). Success path ONLY.
      wiz.clearDraft();
      showToast("Projection created.");
      // Land directly on the editable projection (owner Decision 12).
      window.history.pushState(null, "", `/p/${created.view_slug}/edit`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      // A network reject (offline, DNS, CORS, aborted) or a JSON parse failure —
      // the draft is untouched (we never cleared it), so Retry just re-POSTs it.
      setGenerateError(
        "Couldn't generate your projection — check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Subtle back-nav to the owner's projections list (route "/"). A plain left-click
  // SPA-navigates; modified clicks (new tab/window) fall through to the real href.
  function backToProjections(e: MouseEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // A polite live region — kept mounted across the Generate transition so a screen
  // reader hears that the projection is being produced before the route swaps (#203).
  const liveRegion = (
    <div
      data-testid="generate-status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {generateStatus}
    </div>
  );

  return (
    <>
      {liveRegion}
      <div className="wizard wizard--full">
        <header className="wizard__intro">
          {/* The ONLY leave affordance on step 1 (owner Decision 7): the bottom Back
              button is hidden on the first step; this top link leaves the wizard. */}
          <a
            href="/"
            data-testid="back-to-projections"
            className="wizard__back-link"
            onClick={backToProjections}
          >
            <span aria-hidden="true">←</span> Back to projections
          </a>
          {/* Subtle all-caps eyebrow over the prominent breadcrumb (owner Decision 17).
              Kept a heading so the page still has a labelled landmark. */}
          <h1 className="wizard__eyebrow">Create projection</h1>
        </header>

        {/* Task 2.6: a prior, unfinished draft was restored from localStorage. Resume
            adopts it; Start fresh discards it. Shown only when the stored draft actually
            diverges from a pristine wizard (useWizardState.resumeAvailable). */}
        {wiz.resumeAvailable && (
          <div
            className="wizard__resume"
            role="region"
            aria-label="Resume your draft"
            data-testid="wizard-resume"
          >
            <p>You have an unfinished projection saved on this device.</p>
            <div className="wizard__resume-actions">
              <button type="button" className="btn btn--primary" onClick={wiz.resumeDraft}>
                Resume
              </button>
              <button type="button" className="btn" onClick={wiz.dismissResume}>
                Start fresh
              </button>
            </div>
          </div>
        )}

        <StepIndicator current={wiz.step} furthestReached={wiz.furthestReached} onJump={wiz.goTo} />

        <form
          className="wizard__form"
          // #149: widen the step content beyond the shared 20rem field column so cost
          // rows lay out and the step reads as a real full-page wizard.
          style={{ maxWidth: "44rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (wiz.isLast) {
              if (wiz.canGenerate) void onGenerate(wiz.draft);
            } else {
              wiz.goNext();
            }
          }}
        >
          {/* The active step. display:contents keeps the wrapper layout-transparent
              while giving the route→step focus effect a stable element to query. */}
          <div ref={stepContainerRef} style={{ display: "contents" }}>
            {wiz.stepKey === "address" && <StepSelectAddress state={wiz} />}
            {wiz.stepKey === "square-footage" && <StepSquareFootage state={wiz} />}
            {wiz.stepKey === "configure-donations" && <StepConfigureDonations state={wiz} />}
            {wiz.stepKey === "startup-costs" && (
              <StepStartupCosts
                state={wiz}
                // Penny is LIVE (Decision 1); when AI is off the affordance is omitted
                // and the manual grid + drag is the path (graceful degradation).
                onUploadProposal={aiOff ? undefined : handleProposalUpload}
                proposalBusy={proposalBusy}
                proposalError={proposalError}
              />
            )}
          </div>

          {/* Announce the new step to assistive tech on route change (#261 a11y). */}
          <div
            data-testid="wizard-step-status"
            aria-live="polite"
            aria-atomic="true"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0 0 0 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {stepAnnounce}
          </div>

          <div className="wizard__actions">
            {/* Back is bottom-left on every step EXCEPT the first (owner Decision 7). */}
            {!wiz.isFirst && (
              <button type="button" className="btn" onClick={wiz.goBack} disabled={busy}>
                Back
              </button>
            )}

            {wiz.isLast ? (
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || !wiz.canGenerate}
              >
                Generate projections
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || !wiz.canProceed}
              >
                Next
              </button>
            )}
          </div>

          {/* Task 2.5 (audit P0): a failed Generate must never navigate to
              /p/undefined/edit or fail silently. The draft above is untouched, so
              Retry simply re-POSTs it. */}
          {generateError && (
            <div className="wizard__generate-error" role="alert" data-testid="generate-error">
              <p>{generateError}</p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void onGenerate(wiz.draft)}
              >
                Retry
              </button>
            </div>
          )}
        </form>

        {/* A between-steps spinner for the one blocking transition (#15): Generate.
            Plain-English caption so the operator knows what is happening. */}
        {busy && (
          <div className="wizard-spinner" role="status" data-testid="wizard-spinner">
            <span className="wizard-spinner__dot" aria-hidden="true" />
            <span>Generating your projection…</span>
          </div>
        )}

        {/* Penny — the LEFT slide-out assistant in DRAFT mode (Spec §5.2). She fills/
            refines any wizard field + builds the cost schedule by mutating the in-memory
            draft via /penny/draft; her edits flow into the live inputs above and persist
            NOTHING until Generate. With ?ai=off she degrades to the muted FAB and the
            whole manual wizard stays intact (CLAUDE.md "AI opt-out works end-to-end"). */}
        <SidePanelProvider>
          <PennyDraftAssistant
            token={draftToken.current}
            aiEnabled={!aiOff}
            buildDraftState={() => wizardToDraftState(wiz)}
            onApplyDraft={onApplyDraft}
            onRevertField={applyDraftField}
            labelField={labelDraftField}
          />
        </SidePanelProvider>
      </div>
    </>
  );
}

export default CreateProjectionPage;

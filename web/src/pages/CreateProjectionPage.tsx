// web/src/pages/CreateProjectionPage.tsx — the full-page Create-Projection wizard.
//
// A full-page route (titled "Create Projection") rather than a modal, so Spec B's
// left-slide Penny drawer composes cleanly. One step is visible at a time with a
// step indicator, Back/Next, and Generate on the final step. A subtle "Back to
// projections" link returns to the owner list. State lives in the shared
// useWizardState hook (validation gates Next; a future step inserts without
// rework). On Generate the collected
// inputs are shaped to the flat backend body and POSTed; the server computes and
// returns the Appendix-D view-model, which renders the decision banner + KPI
// strip + monthly cash-flow. NO client math — every figure is the server's
// { display } string (PRD §13 / CLAUDE.md hard rule).
import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { PennyDraftApplied, PennyDraftState } from "../api/penny";
import { newSessionToken, placesAutocomplete, placesResolve } from "../api/places";
import { researchRent } from "../api/research";
import { type ViewModel, xlsxHref } from "../api/viewModel";
import { setOwnerToken } from "../api/projections";
import { CashflowChart } from "../components/CashflowChart";
import { DecisionBanner } from "../components/DecisionBanner";
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
import { StepStore } from "../wizard/StepStore";
import { StepTradeArea } from "../wizard/StepTradeArea";
import { StepSpace } from "../wizard/StepSpace";
import { StepDonorMarket } from "../wizard/StepDonorMarket";
import { StepCostSchedule } from "../wizard/StepCostSchedule";
import { StepReview } from "../wizard/StepReview";
import { useWizardState, type WizardState } from "../wizard/useWizardState";

// Human labels for the server `draft_state` field keys Penny mutates (Spec §6.2),
// shown on each per-field FieldChange affordance in the wizard drawer.
const DRAFT_FIELD_LABELS: Record<string, string> = {
  name: "Store name",
  org_name: "Store name",
  city: "Store address",
  address: "Store address",
  households: "Trade-area households",
  share_y1: "Year-1 donor share",
  share_y2: "Year-2 donor share",
  share_y3: "Year-3 donor share",
  basket: "Average basket",
  donation_value: "Donation value",
  occupancy_annual: "Annual occupancy",
  opening_month_number: "Opening month",
  target_opening_date: "Target opening date",
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

/** Shape the live wizard state as the server `draft_state` Penny reads + mutates
 *  (Spec §5.2/§12). Pure field shaping — NO client math (mirrors shareHelper). */
function wizardToDraftState(wiz: WizardState): PennyDraftState {
  return {
    name: wiz.draft.name,
    inputs: {
      city: wiz.draft.city,
      org_name: wiz.draft.name,
      opening_month_number: wiz.draft.openingMonthNumber ?? DEFAULT_OPENING_MONTH_NUMBER,
      target_opening_date: wiz.draft.targetOpeningDate ?? null,
    },
    assumptions: {
      share_y1: String(wiz.draft.shareY1),
      share_y2: String(wiz.draft.shareY2),
      share_y3: String(wiz.draft.shareY3),
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
}

export function CreateProjectionPage({ aiOff = false }: CreateProjectionPageProps) {
  const wiz = useWizardState();
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [busy, setBusy] = useState(false);
  // One ephemeral Bearer for the whole wizard session's /penny/draft calls.
  const draftToken = useRef<string>(makeWizardDraftToken());

  // #203 — on Generate the form (incl. the focused Generate button) unmounts and
  // the result view mounts. Move focus to the result heading so a keyboard user
  // isn't dropped to <body>/top-of-document, and announce the busy→ready transition
  // via the polite live region below so a screen-reader user hears the projection
  // was produced (WCAG 2.4.3 / 4.1.3).
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (vm) resultHeadingRef.current?.focus();
  }, [vm]);
  const generateStatus = vm ? "Projection ready." : busy ? "Generating your projection…" : "";

  // #245 — pre-fill rent on the Space & rent step from the server research endpoint
  // (extract-only, off the compute hot path). Fires once per resolved-location +
  // size + lease-basis key (a ref guards against refetch loops). With AI disabled,
  // or no resolved location, we skip the call and the field stays the anchored
  // benchmark / manual entry (CLAUDE.md "AI opt-out works end-to-end"). A failure
  // degrades to manual — research NEVER blocks the wizard (API_SPEC §19.2).
  const researchedKey = useRef<string | null>(null);
  const { stepKey, resolved, draft, applyRentResearch, onRentResearchStart, onRentResearchError } =
    wiz;
  const buildingSqft = draft.buildingSqft;
  const leaseType = draft.leaseType;
  useEffect(() => {
    if (stepKey !== "space" || aiOff || !resolved || !(buildingSqft > 0)) return;
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
    stepKey,
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
      case "target_opening_date":
        wiz.set("targetOpeningDate", String(value ?? ""));
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

  async function onGenerate(d: WizardDraft) {
    setBusy(true);
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
      const resp = await fetch("/api/projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = (await resp.json()) as ViewModel & { owner_token?: string };
      // Persist the minted owner token so the owner-scoped list (PRD §20) finds it.
      if (created.owner_token) {
        setOwnerToken(created.owner_token);
      }
      setVm(created);
    } finally {
      setBusy(false);
    }
  }

  // Open the just-created projection's full editable surface (3-year table, evidence,
  // trade-area map, Settings sliders) so the create → review → refine loop closes
  // here instead of forcing a trip through Home. The owner token minted on Generate
  // is already persisted (setOwnerToken), so /p/<slug>/edit is owner-authorized with
  // no secret in the URL — the same path the owner list's Edit uses (#143). A modified
  // click (new tab/window) or non-primary button falls through to the real href.
  function openProjection(e: MouseEvent<HTMLAnchorElement>, slug: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.history.pushState(null, "", `/p/${slug}/edit`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // Subtle back-nav to the owner's projections list (route "/"). A plain left-click
  // SPA-navigates; modified clicks (new tab/window) fall through to the real href.
  function backToProjections(e: MouseEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // A polite live region kept at the SAME fragment position in BOTH the form and
  // result trees, so it stays mounted across the Generate swap and a screen reader
  // hears the text change (busy→ready) rather than a fresh, silent subtree (#203).
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

  if (vm) {
    return (
      <>
        {liveRegion}
        <div className="wizard">
          <div className="wizard__result">
            {/* #203 — the result view used to start with the DecisionBanner (a
                <section> whose headline is a <p>), so there was no heading to land
                on and focus reverted to <body>. A focusable result h1 (tabindex=-1)
                receives focus on mount and names the projection. */}
            <h1
              ref={resultHeadingRef}
              tabIndex={-1}
              style={{
                outline: "none",
                margin: "0 0 1rem",
                fontSize: "var(--text-lg)",
                lineHeight: 1.25,
              }}
            >
              {vm.name?.trim() ? `${vm.name} — projection ready` : "Your projection is ready"}
            </h1>
            <DecisionBanner reco={vm.reco} metrics={vm.metrics} milestones={vm.milestones} />

          <div className="kpis" data-testid="kpi-strip">
            {vm.kpis.map((k) => (
              <div
                key={k.label}
                className="kpi"
                data-testid={/^total revenue$/i.test(k.label) ? "kpi-revenue" : `kpi-${k.label}`}
              >
                <span className="kpi__label">{k.label}</span>
                <span className="kpi__value">{k.value.display}</span>
              </div>
            ))}
          </div>

          <CashflowChart
            monthly={vm.monthly}
            breakevenMonth={vm.breakevenMonth}
            milestones={vm.milestones}
          />

          <div className="wizard__result-actions">
            {/* Close the create → review → refine loop: the primary action opens the
                full editable projection (3-year table + Settings sliders) so the ED
                can act on a "Revise"/"Find cheaper rent" verdict without hunting the
                Home list. The .xlsx export stays as the secondary action. */}
            <a
              className="btn btn--primary"
              data-testid="open-projection"
              href={`/p/${vm.view_slug}/edit`}
              onClick={(e) => openProjection(e, vm.view_slug)}
            >
              Open full projection
            </a>
            <a
              className="btn"
              role="button"
              data-testid="download-xlsx"
              href={xlsxHref(vm.view_slug)}
              download
            >
              Download .xlsx
            </a>
          </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {liveRegion}
      <div className="wizard wizard--full">
      <header className="wizard__intro">
        {/* Subtle back-nav to the owner's projections list (route "/"). A real
            anchor (keyboard-focusable, right-click/new-tab works); a plain left
            click SPA-navigates so there is no full reload. */}
        <a
          href="/"
          data-testid="back-to-projections"
          onClick={backToProjections}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            margin: "0 0 0.5rem",
            fontSize: "var(--text-base)",
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
        >
          <span aria-hidden="true">←</span> Back to projections
        </a>
        <h1>Create Projection</h1>
      </header>

      <StepIndicator current={wiz.step} onJump={wiz.goTo} />

      <form
        className="wizard__form"
        // #149: the shared .wizard__form caps at 20rem, which leaves the full-page
        // wizard's step content cramped in a ~320px column inside the 44rem panel.
        // Widen it here so cost rows lay out 3-up and the review list uses the
        // panel width — reading as a real full-page wizard.
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
        {wiz.stepKey === "store" && <StepStore state={wiz} />}
        {wiz.stepKey === "trade-area" && <StepTradeArea state={wiz} />}
        {wiz.stepKey === "space" && <StepSpace state={wiz} />}
        {wiz.stepKey === "donor-market" && <StepDonorMarket state={wiz} />}
        {wiz.stepKey === "cost" && <StepCostSchedule state={wiz} />}
        {wiz.stepKey === "review" && <StepReview state={wiz} />}

        <div className="wizard__actions">
          <button
            type="button"
            className="btn"
            onClick={wiz.goBack}
            disabled={wiz.isFirst || busy}
          >
            Back
          </button>

          {wiz.isLast ? (
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !wiz.canGenerate}
              aria-describedby={wiz.blockReason ? "wizard-block-reason" : undefined}
            >
              Generate
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !wiz.canProceed}
              aria-describedby={wiz.blockReason ? "wizard-block-reason" : undefined}
            >
              Next
            </button>
          )}
        </div>

        {/* #147: state WHY the Next/Generate button is disabled, right beside it.
            role=status + aria-live=polite announces the reason to assistive tech
            when it changes; the submit button references this via aria-describedby.
            Always rendered (empty when the step is satisfiable) so the live region
            is stable, and the cue is TEXT (with a non-color icon), never color-only. */}
        <p
          id="wizard-block-reason"
          role="status"
          aria-live="polite"
          style={
            wiz.blockReason
              ? {
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-start",
                  margin: "0.75rem 0 0",
                  maxWidth: "52ch",
                  fontSize: "var(--text-base)",
                  lineHeight: 1.45,
                  color: "var(--text-muted)",
                }
              : { margin: 0 }
          }
        >
          {wiz.blockReason && (
            <>
              <span
                aria-hidden="true"
                style={{ flex: "0 0 auto", fontWeight: 700, color: "var(--brand-primary)" }}
              >
                ⓘ
              </span>
              <span>{wiz.blockReason}</span>
            </>
          )}
        </p>
      </form>

      {/* Penny — the LEFT slide-out assistant in DRAFT mode (Spec §5.2). She fills/
          refines any wizard field + builds the cost schedule by mutating the in-memory
          draft via /penny/draft; her edits flow into the live inputs above and persist
          NOTHING until Generate (which sends the draft, incl. any Penny-built schedule
          WITH provenance). With ?ai=off she degrades to the muted Settings FAB and the
          whole manual wizard stays intact (CLAUDE.md "AI opt-out works end-to-end"). */}
      {/* The wizard is full-page with NO Override Inspector, so Penny is the only
          side panel here (Spec B §10, issue #129). Wrapped in the shared coordinator
          for identical breakpoint behaviour (non-modal ≥1180px, modal sheet below)
          and the shared polite live region. */}
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

// web/src/pages/CreateProjectionPage.tsx — the full-page Create-Projection wizard.
//
// A full-page route (titled "Create Projection") rather than a modal, so Spec B's
// left-slide Penny drawer composes cleanly. One step is visible at a time with a
// step indicator, Back/Next, and Generate on the final step; "Start from example"
// remains available. State lives in the shared useWizardState hook (validation
// gates Next; a future step inserts without rework). On Generate the collected
// inputs are shaped to the flat backend body and POSTed; the server computes and
// returns the Appendix-D view-model, which renders the decision banner + KPI
// strip + monthly cash-flow. NO client math — every figure is the server's
// { display } string (PRD §13 / CLAUDE.md hard rule).
import { useState } from "react";

import { fetchProjection, type ViewModel, xlsxHref } from "../api/viewModel";
import { CashflowChart } from "../components/CashflowChart";
import { DecisionBanner } from "../components/DecisionBanner";
import { buildCreatePayload, toServerCreateBody, type WizardDraft } from "../wizard/shareHelper";
import { StepIndicator } from "../wizard/StepIndicator";
import { StepStore } from "../wizard/StepStore";
import { StepTradeArea } from "../wizard/StepTradeArea";
import { StepDonorMarket } from "../wizard/StepDonorMarket";
import { StepCostSchedule } from "../wizard/StepCostSchedule";
import { StepReview } from "../wizard/StepReview";
import { useWizardState } from "../wizard/useWizardState";

const EXAMPLE_SLUG = "example";

export interface CreateProjectionPageProps {
  aiOff?: boolean;
}

export function CreateProjectionPage({ aiOff = false }: CreateProjectionPageProps) {
  const wiz = useWizardState();
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [busy, setBusy] = useState(false);

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
        localStorage.setItem("projections.owner_token", created.owner_token);
      }
      setVm(created);
    } finally {
      setBusy(false);
    }
  }

  async function startFromExample() {
    setBusy(true);
    try {
      await fetchProjection(EXAMPLE_SLUG); // warm the cache / surface fetch errors
      const qs = aiOff ? "?ai=off" : "";
      window.history.pushState(null, "", `/p/${EXAMPLE_SLUG}${qs}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } finally {
      setBusy(false);
    }
  }

  if (vm) {
    return (
      <div className="wizard">
        <div className="wizard__result">
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
    );
  }

  return (
    <div className="wizard wizard--full">
      <header className="wizard__intro">
        <h1>Create Projection</h1>
      </header>

      <StepIndicator current={wiz.step} onJump={wiz.goTo} />

      <form
        className="wizard__form"
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
            >
              Generate
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

          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void startFromExample()}
          >
            Start from example
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateProjectionPage;

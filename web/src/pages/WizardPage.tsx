// web/src/pages/WizardPage.tsx — the create wizard route (M2 "M2 IS the product").
//
// The multi-step CreateWizard (store/location → building/lease → trade area →
// donations & demand → source of funds → review) gathers inputs with NO server
// record until Generate (handoff D2 AC). On Generate the nested CreatePayload is
// adapted to the flat backend body and POSTed; the server computes and returns the
// Appendix-D view-model, which renders the decision banner + KPIs + monthly cash-
// flow. "Start from example" loads the seeded `example` projection so the demo flow
// needs no data entry. NO client math: every figure shown is the server's.
import { useState } from "react";

import { fetchProjection, type ViewModel, xlsxHref } from "../api/viewModel";
import { DecisionBanner } from "../components/DecisionBanner";
import { CashflowChart } from "../components/CashflowChart";
import { CreateWizard } from "../wizard/CreateWizard";
import { toServerCreateBody, type CreatePayload } from "../wizard/shareHelper";

const EXAMPLE_SLUG = "example";

export interface WizardPageProps {
  aiOff?: boolean;
}

export function WizardPage({ aiOff = false }: WizardPageProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [busy, setBusy] = useState(false);

  async function onGenerate(payload: CreatePayload) {
    const resp = await fetch("/api/projections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toServerCreateBody(payload)),
    });
    const created = (await resp.json()) as ViewModel & { owner_token?: string };
    // Persist the minted owner token so the owner-scoped list (PRD §20) can find it.
    if (created.owner_token) {
      localStorage.setItem("projections.owner_token", created.owner_token);
    }
    setVm(created);
  }

  async function startFromExample() {
    setBusy(true);
    try {
      // Navigate to the seeded projection's view_slug route so the result is
      // reopenable by URL (the happy-path "reopen shows identical numbers" flow).
      // The SPA shell re-renders on popstate, so emit one after pushing state.
      await fetchProjection(EXAMPLE_SLUG); // warm the cache / surface fetch errors
      // Preserve the AI opt-out flag across the navigation so the read view keeps
      // the manual-rent path (AI-disabled flow, PRD §21).
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
          <DecisionBanner reco={vm.reco} metrics={vm.metrics} />

          <div className="kpis" data-testid="kpi-strip">
            {vm.kpis.map((k) => (
              <div
                key={k.label}
                className="kpi"
                data-testid={
                  /^total revenue$/i.test(k.label) ? "kpi-revenue" : `kpi-${k.label}`
                }
              >
                <span className="kpi__label">{k.label}</span>
                <span className="kpi__value">{k.value.display}</span>
              </div>
            ))}
          </div>

          <CashflowChart monthly={vm.monthly} breakevenMonth={vm.breakevenMonth} />

          {aiOff && (
            <label className="wizard__rent">
              Monthly rent (manual)
              <input aria-label="Rent" defaultValue="10000" />
            </label>
          )}

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
    <div className="wizard">
      <CreateWizard onGenerate={onGenerate} />
      <div className="wizard__shortcut">
        <button type="button" className="btn" disabled={busy} onClick={() => void startFromExample()}>
          Start from example
        </button>
      </div>
    </div>
  );
}

export default WizardPage;

// web/src/pages/WizardPage.tsx — the create route (M2 "M2 IS the product").
//
// An EXPRESS create form: the design-parity House of Hope inputs are pre-filled so
// the operator only confirms the trade-area households + the three EXPLICIT Y1/Y2/Y3
// shares (PRD §7.1 — never an auto-midpoint) and hits Generate. On Generate the
// draft is shaped to the flat backend body and POSTed; the server computes and
// returns the Appendix-D view-model, which renders the decision banner + KPI strip
// + monthly cash-flow. "Start from example" loads the seeded `example` projection so
// the demo flow needs no data entry. NO client math: every figure shown is the
// server's { display } string (PRD §13).
import { useState } from "react";

import { fetchProjection, type ViewModel, xlsxHref } from "../api/viewModel";
import { DecisionBanner } from "../components/DecisionBanner";
import { CashflowChart } from "../components/CashflowChart";
import { PlacesAutocomplete } from "../components/PlacesAutocomplete";
import type { ResolveErrorKind, TradeAreaResolved } from "../api/places";
import { buildCreatePayload, toServerCreateBody, type WizardDraft } from "../wizard/shareHelper";

const EXAMPLE_SLUG = "example";

// The express draft seeds the design-parity House of Hope inputs (mirrors the
// seeded `example` projection) so Generate needs only the trade-area + shares.
const EXPRESS_DEFAULT: WizardDraft = {
  name: "House of Hope",
  city: "Longview",
  state: "TX",
  basis: "city",
  households: 31798,
  buildingSqft: 10000,
  salesfloorPct: 70,
  leaseType: "nnn",
  donationValue: 74,
  basket: 17.08,
  donationsPerHh: 3,
  shareY1: 6,
  shareY2: 8,
  shareY3: 10,
  occupancyAnnual: 120000,
  cash: 300000,
  grant: 0,
  loan: 0,
  termsAccepted: true,
};

// The three explicit donor-market shares (PRD §7.1 — never an auto-midpoint),
// rendered by one map. Store name and the Census-derived households are bespoke.
type ShareKey = "shareY1" | "shareY2" | "shareY3";
const SHARES: ReadonlyArray<{ key: ShareKey; label: string }> = [
  { key: "shareY1", label: "Year 1 share (%)" },
  { key: "shareY2", label: "Year 2 share (%)" },
  { key: "shareY3", label: "Year 3 share (%)" },
];

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(n);

export interface WizardPageProps {
  aiOff?: boolean;
}

export function WizardPage({ aiOff = false }: WizardPageProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<WizardDraft>(EXPRESS_DEFAULT);

  const [resolved, setResolved] = useState<TradeAreaResolved | null>(null);
  const [basis, setBasis] = useState<"city" | "county">("city");
  const [householdsSource, setHouseholdsSource] = useState<"census" | "edited" | null>(null);
  const [resolveError, setResolveError] = useState<ResolveErrorKind | null>(null);

  function set<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // Apply one geography's Census household count (City/County) from a resolve.
  function applyBasis(b: "city" | "county", result: TradeAreaResolved) {
    const alt = result.trade_area.alternatives[b];
    if (!alt) return;
    setBasis(b);
    set("basis", b);
    set("households", alt.households);
    setHouseholdsSource("census");
  }

  function handleResolved(result: TradeAreaResolved) {
    setResolved(result);
    setResolveError(null);
    applyBasis(result.trade_area.basis === "county" ? "county" : "city", result);
  }

  // Places/Census failed: drop provenance and let the operator type households.
  function handleResolveError(kind: ResolveErrorKind) {
    setResolveError(kind);
    setResolved(null);
    setHouseholdsSource(null);
  }

  async function onGenerate(d: WizardDraft) {
    setBusy(true);
    try {
      const resp = await fetch("/api/projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toServerCreateBody(buildCreatePayload(d))),
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
      <header className="wizard__intro">
        <h1>New projection</h1>
        <p className="wizard__lede">
          Find your store’s address — we pull the trade-area households from the
          U.S. Census — then set three annual donor-market shares and generate a
          board-ready decision.
        </p>
      </header>

      <form
        className="wizard__form"
        onSubmit={(e) => {
          e.preventDefault();
          void onGenerate(draft);
        }}
      >
        <label className="wizard__field">
          Store name
          <input
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>

        <PlacesAutocomplete
          label="Store address"
          basis={basis}
          onResolved={handleResolved}
          onError={handleResolveError}
        />

        <div className="wizard__field places__households">
          <label className="places__households-label" htmlFor="wizard-households">
            Households (trade area)
          </label>
          {resolved && (
            <div className="places__basis" role="group" aria-label="Trade-area basis">
              {(["city", "county"] as const).map((b) =>
                resolved.trade_area.alternatives[b] ? (
                  <button
                    key={b}
                    type="button"
                    className={
                      basis === b
                        ? "places__basis-btn places__basis-btn--on"
                        : "places__basis-btn"
                    }
                    aria-pressed={basis === b}
                    onClick={() => applyBasis(b, resolved)}
                  >
                    {b === "city" ? "City" : "County"}
                  </button>
                ) : null,
              )}
            </div>
          )}
          <input
            id="wizard-households"
            type="number"
            value={draft.households}
            onChange={(e) => {
              set("households", Number(e.target.value));
              if (resolved) setHouseholdsSource("edited");
            }}
          />
          {resolved && householdsSource === "census" && (
            <p className="places__provenance">
              {fmtInt(draft.households)} households · {resolved.trade_area.geography_name} ·
              U.S. Census ACS {resolved.trade_area.acs_vintage} · estimate
            </p>
          )}
          {householdsSource === "edited" && (
            <p className="places__provenance places__provenance--edited">
              Edited — overrides the Census estimate.
            </p>
          )}
          {resolveError && (
            <p className="places__provenance places__provenance--error">
              Couldn’t look up that location automatically — enter households manually.
            </p>
          )}
        </div>

        {SHARES.map((f) => (
          <label key={f.key} className="wizard__field">
            {f.label}
            <input
              type="number"
              value={draft[f.key]}
              onChange={(e) => set(f.key, Number(e.target.value))}
            />
          </label>
        ))}

        <div className="wizard__actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Generate
          </button>
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

export default WizardPage;

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

export interface WizardPageProps {
  aiOff?: boolean;
}

/**
 * SPA navigation without a router dependency: push the new path and emit a
 * popstate so the App shell (useSyncExternalStore) re-renders the new route.
 * Mirrors the existing startFromExample push-state + popstate pattern.
 */
function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function WizardPage({ aiOff = false }: WizardPageProps) {
  const [vm, setVm] = useState<ViewModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<WizardDraft>(EXPRESS_DEFAULT);
  // The edit-secret minted on create. It rides in the URL fragment only — never
  // the path/query/logs (SECURITY.md §2.5) — so "Open full projection" can deep
  // link straight into the editable detail view.
  const [editSecret, setEditSecret] = useState<string | null>(null);

  function set<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onGenerate(d: WizardDraft) {
    setBusy(true);
    try {
      const resp = await fetch("/api/projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toServerCreateBody(buildCreatePayload(d))),
      });
      const created = (await resp.json()) as ViewModel & {
        owner_token?: string;
        edit_token?: string;
        tokens?: { owner_token?: string; edit_token?: string };
      };
      // Persist the minted owner token so the owner-scoped list (PRD §20) finds it.
      const ownerToken = created.owner_token ?? created.tokens?.owner_token;
      if (ownerToken) {
        localStorage.setItem("projections.owner_token", ownerToken);
      }
      // Capture the edit secret for the deep link into the editable detail view.
      // Fall back to the owner token if the server returns only that (legacy shape).
      setEditSecret(
        created.edit_token ?? created.tokens?.edit_token ?? ownerToken ?? null,
      );
      setVm(created);
    } finally {
      setBusy(false);
    }
  }

  /** Return to the prefilled form with the draft intact (keep draft, clear vm). */
  function editAssumptions() {
    setVm(null);
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
      navigate(`/p/${EXAMPLE_SLUG}${qs}`);
    } finally {
      setBusy(false);
    }
  }

  if (vm) {
    // Preserve the AI opt-out flag across navigation (AI-disabled flow, PRD §21).
    const qs = aiOff ? "?ai=off" : "";
    // The edit secret rides in the fragment only (SECURITY.md §2.5), after any query.
    const frag = editSecret ? `#${editSecret}` : "";
    return (
      <div className="wizard">
        <div className="wizard__result">
          {/* Persistent return-to-form affordance: clears the result but keeps the
              draft in state so the operator can tweak assumptions and re-generate. */}
          <button
            type="button"
            className="link wizard__edit-assumptions"
            data-testid="edit-assumptions"
            onClick={editAssumptions}
          >
            ← Edit assumptions
          </button>

          <p className="wizard__lede" data-testid="result-lede">
            Here's your decision. Open the full projection to see the evidence behind
            every number, or share a read-only view with your board.
          </p>

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

          <div className="wizard__result-actions">
            {/* PRIMARY: open the canonical, reopenable editable projection the
                server just minted (push state + popstate, mirroring startFromExample). */}
            <button
              type="button"
              className="btn btn--primary"
              data-testid="open-full-projection"
              onClick={() => navigate(`/p/${vm.view_slug}/edit${qs}${frag}`)}
            >
              Open full projection
            </button>
            {/* SECONDARY: the read-only view is the link a board member receives. */}
            <button
              type="button"
              className="btn"
              data-testid="share-board"
              onClick={() => navigate(`/p/${vm.view_slug}${qs}`)}
            >
              Share with your board
            </button>
            {/* SECONDARY: the board packet is exported from the read view. */}
            <button
              type="button"
              className="btn"
              data-testid="export-packet"
              onClick={() => navigate(`/p/${vm.view_slug}${qs}`)}
            >
              Export Board Packet
            </button>
          </div>

          {/* TERTIARY: the raw spreadsheet, demoted to a plain text link. */}
          <a
            className="wizard__xlsx-link"
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
      <header className="wizard__head">
        <h1>Thrift Store Projection</h1>
        <p className="wizard__lede">
          Confirm your trade area and the three annual donor-market shares, then
          generate a board-ready decision.
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
            aria-label="Store name"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>

        <label className="wizard__field">
          Households (trade area)
          <input
            aria-label="Households"
            type="number"
            value={draft.households}
            onChange={(e) => set("households", Number(e.target.value))}
          />
        </label>

        <label className="wizard__field">
          Year 1 share (%)
          <input
            aria-label="Year 1 share"
            type="number"
            value={draft.shareY1}
            onChange={(e) => set("shareY1", Number(e.target.value))}
          />
        </label>

        <label className="wizard__field">
          Year 2 share (%)
          <input
            aria-label="Year 2 share"
            type="number"
            value={draft.shareY2}
            onChange={(e) => set("shareY2", Number(e.target.value))}
          />
        </label>

        <label className="wizard__field">
          Year 3 share (%)
          <input
            aria-label="Year 3 share"
            type="number"
            value={draft.shareY3}
            onChange={(e) => set("shareY3", Number(e.target.value))}
          />
        </label>

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

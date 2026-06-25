// web/src/wizard/CreateWizard.tsx — the multi-step create wizard (handoff §3 D2).
//
// Steps: store & location → building & lease → trade area (City/County/Manual —
// no radius/ZIP in v1) → donations & demand (3 EXPLICIT shares Y1/Y2/Y3 + a live
// "X% → D donations/week → $R revenue" helper + benchmark presets + even-ramp) →
// source of funds → review → Generate.
//
// HARD RULES:
//   - NO server record until Generate (handoff D2 AC). The wizard persists the
//     in-progress draft to localStorage AFTER step 1 only and offers recovery on
//     mount; nothing hits the server until the final Generate.
//   - NO client projection math (PRD §13). The share helper is a pre-create
//     ESTIMATE only — the authoritative numbers come back from the server compute
//     on POST. buildCreatePayload just shapes the request body (API_SPEC §4.2).
//   - Terms acceptance before Generate (PRD §21).
//   - Brand/semantic tokens only — no inline hex (handoff §6 / tokens.css).
import { useMemo, useState } from "react";

import {
  PRESETS,
  SHARE_BENCHMARK_NOTE,
  buildCreatePayload,
  evenRampY2,
  shareHelper,
  type CreatePayload,
  type LeaseType,
  type TradeAreaBasis,
  type WizardDraft,
} from "./shareHelper";
import { clearDraft, loadDraft, saveDraft } from "./draft";

const STEPS = [
  "Store & location",
  "Building & lease",
  "Trade area",
  "Donations & demand",
  "Source of funds",
  "Review",
] as const;

const DONATIONS_PER_HH = 3;
const DEFAULT_BASKET = 17.08;

const DEFAULT_DRAFT: WizardDraft = {
  name: "",
  city: "",
  state: "TX",
  basis: "city",
  households: 31800,
  buildingSqft: 10000,
  salesfloorPct: 70,
  leaseType: "nnn",
  donationValue: 74,
  basket: DEFAULT_BASKET,
  donationsPerHh: DONATIONS_PER_HH,
  shareY1: 6,
  shareY2: 8,
  shareY3: 10,
  occupancyAnnual: 90000,
  cash: 250000,
  grant: 0,
  loan: 0,
  termsAccepted: false,
};

export interface CreateWizardProps {
  /** Called on the final Generate with the server-shaped create payload. */
  onGenerate: (payload: CreatePayload) => Promise<void>;
}

export function CreateWizard({ onGenerate }: CreateWizardProps) {
  const [recoverable] = useState(() => loadDraft());
  const [showRecovery, setShowRecovery] = useState(() => recoverable !== null);
  const [step, setStep] = useState(0);
  const [d, setD] = useState<WizardDraft>(DEFAULT_DRAFT);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) {
    setD((prev) => ({ ...prev, [key]: value }));
  }

  function persistPastStepOne(nextStep: number, draft: WizardDraft) {
    // Draft recovery starts AFTER step 1 (handoff D2): step 1 is the entry point,
    // so we only persist once the user has committed to advancing.
    if (nextStep >= 1) saveDraft(nextStep, draft);
  }

  function next() {
    const target = Math.min(step + 1, STEPS.length - 1);
    persistPastStepOne(target, d);
    setStep(target);
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  function applyPreset(shares: [number, number, number]) {
    setD((prev) => ({
      ...prev,
      shareY1: shares[0],
      shareY2: shares[1],
      shareY3: shares[2],
    }));
  }

  function resumeDraft() {
    if (recoverable) {
      setD({ ...DEFAULT_DRAFT, ...recoverable.draft });
      // Resume from the first step so the operator can review every restored input
      // on the way back to where they left off (the values are all preserved).
      setStep(0);
    }
    setShowRecovery(false);
  }

  function discardDraft() {
    clearDraft();
    setShowRecovery(false);
  }

  async function generate() {
    setBusy(true);
    try {
      await onGenerate(buildCreatePayload(d));
      clearDraft(); // it is now a server record — no recoverable copy
    } finally {
      setBusy(false);
    }
  }

  const helperY1 = useMemo(
    () =>
      shareHelper({
        households: d.households,
        sharePct: d.shareY1,
        donationsPerHh: d.donationsPerHh,
        basket: d.basket,
      }),
    [d.households, d.shareY1, d.donationsPerHh, d.basket],
  );

  return (
    <div className="wizard">
      {showRecovery && recoverable && (
        <div className="wizard__recovery" data-testid="draft-recovery" role="status">
          <span>
            You have an unfinished projection
            {recoverable.draft.name ? ` — “${recoverable.draft.name}”` : ""}.
          </span>
          <div className="wizard__recovery-actions">
            <button type="button" className="btn btn--primary" onClick={resumeDraft}>
              Resume
            </button>
            <button type="button" className="btn" onClick={discardDraft}>
              Discard
            </button>
          </div>
        </div>
      )}

      <header className="wizard__head">
        <h1>{STEPS[step]}</h1>
        <span className="chip" data-testid="wizard-step">
          Step {step + 1} / {STEPS.length}
        </span>
      </header>

      <form
        className="wizard__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < STEPS.length - 1) next();
        }}
      >
        {step === 0 && (
          <fieldset className="wizard__step">
            <label>
              Store name
              <input
                aria-label="Store name"
                value={d.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label>
              City
              <input
                aria-label="City"
                value={d.city}
                onChange={(e) => set("city", e.target.value)}
              />
            </label>
            <label>
              State
              <input
                aria-label="State"
                value={d.state}
                onChange={(e) => set("state", e.target.value)}
              />
            </label>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset className="wizard__step">
            <label>
              Building area (sq ft)
              <input
                aria-label="Building area"
                type="number"
                value={d.buildingSqft}
                onChange={(e) => set("buildingSqft", Number(e.target.value))}
              />
            </label>
            <label>
              Sales-floor %
              <input
                aria-label="Sales-floor percent"
                type="range"
                min={0}
                max={100}
                value={d.salesfloorPct}
                onChange={(e) => set("salesfloorPct", Number(e.target.value))}
              />
              <span className="num">{d.salesfloorPct}%</span>
            </label>
            <div
              role="group"
              aria-label="Lease type"
              className="wizard__choices"
            >
              {(["gross", "nnn"] as LeaseType[]).map((t) => (
                <label key={t} className="wizard__choice">
                  <input
                    type="radio"
                    name="leaseType"
                    value={t}
                    checked={d.leaseType === t}
                    onChange={() => set("leaseType", t)}
                  />
                  {t === "gross" ? "Gross" : "NNN"}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset className="wizard__step">
            <div
              role="group"
              aria-label="Trade-area basis"
              className="wizard__choices"
            >
              {(["city", "county", "manual"] as TradeAreaBasis[]).map((b) => (
                <label key={b} className="wizard__choice">
                  <input
                    type="radio"
                    name="basis"
                    value={b}
                    checked={d.basis === b}
                    onChange={() => set("basis", b)}
                  />
                  {b === "city" ? "City" : b === "county" ? "County" : "Manual"}
                </label>
              ))}
            </div>
            <label>
              Households (trade area)
              <input
                aria-label="Households"
                type="number"
                value={d.households}
                onChange={(e) => set("households", Number(e.target.value))}
              />
            </label>
          </fieldset>
        )}

        {step === 3 && (
          <fieldset className="wizard__step">
            <p className="wizard__note">{SHARE_BENCHMARK_NOTE}</p>
            <div className="wizard__presets" role="group" aria-label="Benchmark presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="btn"
                  onClick={() => applyPreset(p.shares)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <label>
              Year 1 share (%)
              <input
                aria-label="Year 1 share"
                type="number"
                value={d.shareY1}
                onChange={(e) => set("shareY1", Number(e.target.value))}
              />
            </label>
            <p className="wizard__helper" data-testid="share-helper-y1">
              {helperY1.text}
            </p>

            <label>
              Year 2 share (%)
              <input
                aria-label="Year 2 share"
                type="number"
                value={d.shareY2}
                onChange={(e) => set("shareY2", Number(e.target.value))}
              />
            </label>

            <label>
              Year 3 share (%)
              <input
                aria-label="Year 3 share"
                type="number"
                value={d.shareY3}
                onChange={(e) => set("shareY3", Number(e.target.value))}
              />
            </label>

            <button
              type="button"
              className="btn"
              onClick={() => set("shareY2", evenRampY2(d.shareY1, d.shareY3))}
            >
              Even ramp (fill Year 2)
            </button>
          </fieldset>
        )}

        {step === 4 && (
          <fieldset className="wizard__step">
            <label>
              Cash on hand ($)
              <input
                aria-label="Cash"
                type="number"
                value={d.cash}
                onChange={(e) => set("cash", Number(e.target.value))}
              />
            </label>
            <label>
              Grants ($)
              <input
                aria-label="Grant"
                type="number"
                value={d.grant}
                onChange={(e) => set("grant", Number(e.target.value))}
              />
            </label>
            <label>
              Loan ($)
              <input
                aria-label="Loan"
                type="number"
                value={d.loan}
                onChange={(e) => set("loan", Number(e.target.value))}
              />
            </label>
          </fieldset>
        )}

        {step === 5 && (
          <fieldset className="wizard__step wizard__review">
            <dl className="wizard__summary">
              <div>
                <dt>Store</dt>
                <dd>
                  {d.name || "—"} · {[d.city, d.state].filter(Boolean).join(", ")}
                </dd>
              </div>
              <div>
                <dt>Trade area</dt>
                <dd className="num">
                  {d.basis} · {new Intl.NumberFormat("en-US").format(d.households)} households
                </dd>
              </div>
              <div>
                <dt>Shares (Y1 / Y2 / Y3)</dt>
                <dd className="num">
                  {d.shareY1}% / {d.shareY2}% / {d.shareY3}%
                </dd>
              </div>
            </dl>
            <label className="wizard__terms">
              <input
                type="checkbox"
                aria-label="I accept the terms"
                checked={d.termsAccepted}
                onChange={(e) => set("termsAccepted", e.target.checked)}
              />
              I understand these are planning estimates, not financial advice (terms).
            </label>
          </fieldset>
        )}

        <div className="wizard__actions">
          {step > 0 && (
            <button type="button" className="btn" onClick={back} disabled={busy}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 && (
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Next
            </button>
          )}
          {step === STEPS.length - 1 && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !d.termsAccepted}
              onClick={() => void generate()}
            >
              Generate
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export default CreateWizard;

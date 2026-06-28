// web/src/wizard/StepSpace.test.tsx — the Space & rent step (#245).
//
// Verifies it collects sq ft + salesfloor + the three sq-ft cost assumptions, that
// rent shows a verified-vs-estimated badge + sources from the SERVER research result,
// flips to "Adjusted by you" on a manual edit, and degrades to manual entry with a
// clear note when research is off/failed. NO client math — the badge/sources are the
// server's, rendered verbatim.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StepSpace } from "./StepSpace";
import { DEFAULT_DRAFT, type AssumptionSource, type WizardState } from "./useWizardState";
import type { RentResearch } from "../api/research";

const VERIFIED: RentResearch = {
  rent_per_sqft: 18, estimate: 18, low: 15, high: 22,
  rent_type: "nnn", opex: 3, basis: "$/sq ft/yr",
  confidence: "high", verified: true, provenance: "verified",
  sources: [{ url: "https://broker.example/lease", title: "Longview retail lease", source_date: "2026-05" }],
  ai_enabled: true, cached: false,
};

function makeState(over: Partial<WizardState> = {}): WizardState {
  return {
    draft: { ...DEFAULT_DRAFT },
    rentSource: "default" as AssumptionSource,
    utilitiesSource: "default" as AssumptionSource,
    fixturesSource: "default" as AssumptionSource,
    rentResearch: null,
    rentResearchLoading: false,
    rentResearchError: false,
    setBuildingSqft: vi.fn(),
    setSalesfloorPct: vi.fn(),
    setRentPerSqft: vi.fn(),
    setUtilitiesPerSqft: vi.fn(),
    setFixturesPerSqft: vi.fn(),
    ...over,
  } as unknown as WizardState;
}

describe("StepSpace — collects sq ft + salesfloor + rent (#245)", () => {
  it("asks for building size and sales-floor area", () => {
    render(<StepSpace state={makeState()} />);
    expect(screen.getByLabelText(/building size/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sales-floor area/i)).toBeInTheDocument();
  });

  it("collects the building size via setBuildingSqft", () => {
    const setBuildingSqft = vi.fn();
    render(<StepSpace state={makeState({ setBuildingSqft })} />);
    fireEvent.change(screen.getByLabelText(/building size/i), { target: { value: "8000" } });
    expect(setBuildingSqft).toHaveBeenLastCalledWith(8000);
  });

  it("edits the rent field via setRentPerSqft (override → user)", () => {
    const setRentPerSqft = vi.fn();
    render(<StepSpace state={makeState({ setRentPerSqft })} />);
    fireEvent.change(screen.getByLabelText(/rent \(\$\/sq ft/i), { target: { value: "20" } });
    expect(setRentPerSqft).toHaveBeenLastCalledWith(20);
  });
});

describe("StepSpace — rent provenance + verified/estimated badge", () => {
  it("shows a VERIFIED badge + sources when research grounded the rent", () => {
    render(
      <StepSpace
        state={makeState({
          rentSource: "research",
          rentResearch: VERIFIED,
          draft: { ...DEFAULT_DRAFT, rentPerSqft: 18 },
        })}
      />,
    );
    const badge = screen.getByTestId("rent-badge");
    expect(badge).toHaveAttribute("data-verified", "true");
    expect(badge).toHaveTextContent(/verified/i);
    // sources are the server's, surfaced as real links
    const sources = screen.getByTestId("rent-sources");
    expect(sources).toHaveTextContent(/Longview retail lease/);
    expect(screen.getByRole("link", { name: /Longview retail lease/i })).toHaveAttribute(
      "href",
      "https://broker.example/lease",
    );
    // provenance language mirrors households_source
    expect(screen.getByTestId("rent-provenance")).toHaveTextContent(/From local research/i);
  });

  it("shows an ESTIMATED badge + low-confidence warning for an ungrounded benchmark", () => {
    render(
      <StepSpace
        state={makeState({
          rentSource: "research",
          rentResearch: {
            ...VERIFIED, verified: false, provenance: "estimated",
            confidence: "low", sources: [], estimate: 12, rent_per_sqft: 12, low: 8, high: 16,
          },
          draft: { ...DEFAULT_DRAFT, rentPerSqft: 12 },
        })}
      />,
    );
    const badge = screen.getByTestId("rent-badge");
    expect(badge).toHaveAttribute("data-verified", "false");
    expect(badge).toHaveTextContent(/estimated/i);
    expect(screen.getByTestId("rent-low-confidence")).toHaveTextContent(/low confidence/i);
  });

  it("labels a user-edited rent as 'Adjusted by you'", () => {
    render(<StepSpace state={makeState({ rentSource: "user" })} />);
    expect(screen.getByTestId("rent-provenance")).toHaveTextContent(/Adjusted by you/i);
    expect(screen.queryByTestId("rent-badge")).not.toBeInTheDocument();
  });

  it("AI-off / research failure degrades to a manual-entry note", () => {
    render(<StepSpace state={makeState({ rentResearchError: true })} />);
    expect(screen.getByTestId("rent-manual-note")).toHaveTextContent(/enter your own/i);
  });

  it("shows a loading note while research is in flight", () => {
    render(<StepSpace state={makeState({ rentResearchLoading: true })} />);
    expect(screen.getByTestId("rent-provenance")).toHaveTextContent(/looking up/i);
  });
});

describe("StepSpace — utilities + fixtures assumptions are stated + adjustable", () => {
  it("states utilities and fixtures $/sq ft with their provenance, each editable", () => {
    const setUtilitiesPerSqft = vi.fn();
    const setFixturesPerSqft = vi.fn();
    render(
      <StepSpace
        state={makeState({
          setUtilitiesPerSqft,
          setFixturesPerSqft,
          utilitiesSource: "default",
          fixturesSource: "user",
        })}
      />,
    );
    expect(screen.getByTestId("utilities-provenance")).toHaveTextContent(/Regional default/i);
    expect(screen.getByTestId("fixtures-provenance")).toHaveTextContent(/Adjusted by you/i);

    fireEvent.change(screen.getByLabelText(/utilities & trash/i), { target: { value: "3" } });
    expect(setUtilitiesPerSqft).toHaveBeenLastCalledWith(3);

    fireEvent.change(screen.getByLabelText(/fixtures & equipment/i), { target: { value: "6" } });
    expect(setFixturesPerSqft).toHaveBeenLastCalledWith(6);
  });
});

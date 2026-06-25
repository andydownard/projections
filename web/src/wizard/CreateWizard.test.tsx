import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateWizard } from "./CreateWizard";
import { DRAFT_KEY, saveDraft } from "./draft";
import type { CreatePayload } from "./shareHelper";

// SLICE 2 — the multi-step create wizard (handoff §3 D2):
//   store & location → building & lease → trade area (city/county/manual) →
//   donations & demand (3 EXPLICIT shares + live "X% → D/week → $R" helper +
//   presets) → source of funds → review → Generate.
// Draft recovery after step 1. No client projection math (PRD §13): the helper is
// a pre-create estimate only; the real numbers come from the server on Generate.

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function fillField(label: RegExp, value: string) {
  return userEvent.type(screen.getByLabelText(label), value);
}

describe("CreateWizard — steps", () => {
  it("starts on the store & location step", () => {
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    expect(screen.getByRole("heading", { name: /store & location/i })).toBeInTheDocument();
    // Step 1 of 6 indicator.
    expect(screen.getByTestId("wizard-step")).toHaveTextContent(/1\s*\/\s*6/);
  });

  it("advances store → building & lease → trade area", async () => {
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    await fillField(/store name/i, "House of Hope");
    await fillField(/city/i, "Longview");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("heading", { name: /building & lease/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("heading", { name: /trade area/i })).toBeInTheDocument();
  });

  it("offers City / County / Manual trade-area basis (no radius/ZIP)", async () => {
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    await fillField(/store name/i, "House of Hope");
    await fillField(/city/i, "Longview");
    await user.click(screen.getByRole("button", { name: /next/i })); // building
    await user.click(screen.getByRole("button", { name: /next/i })); // trade area
    const group = screen.getByRole("group", { name: /trade.area basis/i });
    expect(within(group).getByRole("radio", { name: /city/i })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: /county/i })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: /manual/i })).toBeInTheDocument();
    expect(within(group).queryByRole("radio", { name: /radius|zip/i })).not.toBeInTheDocument();
  });
});

describe("CreateWizard — donations & demand step", () => {
  async function gotoDemand(user: ReturnType<typeof userEvent.setup>) {
    await fillField(/store name/i, "House of Hope");
    await fillField(/city/i, "Longview");
    await user.click(screen.getByRole("button", { name: /next/i })); // building
    await user.click(screen.getByRole("button", { name: /next/i })); // trade area
    await user.click(screen.getByRole("button", { name: /next/i })); // donations
  }

  it("shows three explicit share fields and a live donations/week helper", async () => {
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    await gotoDemand(user);
    expect(screen.getByRole("heading", { name: /donations & demand/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/year 1 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 2 share/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/year 3 share/i)).toBeInTheDocument();
    // Live helper line reflects the Year-1 share against the (default) households.
    expect(screen.getByTestId("share-helper-y1")).toHaveTextContent(
      /donations\/week.*revenue/i,
    );
  });

  it("applies a benchmark preset to all three explicit years", async () => {
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    await gotoDemand(user);
    await user.click(screen.getByRole("button", { name: /conservative/i }));
    expect(screen.getByLabelText(/year 1 share/i)).toHaveValue(5);
    expect(screen.getByLabelText(/year 2 share/i)).toHaveValue(6);
    expect(screen.getByLabelText(/year 3 share/i)).toHaveValue(7);
  });
});

describe("CreateWizard — review & generate", () => {
  async function gotoReview(user: ReturnType<typeof userEvent.setup>) {
    await fillField(/store name/i, "House of Hope");
    await fillField(/city/i, "Longview");
    await user.click(screen.getByRole("button", { name: /next/i })); // building
    await user.click(screen.getByRole("button", { name: /next/i })); // trade area
    await user.click(screen.getByRole("button", { name: /next/i })); // donations
    await user.click(screen.getByRole("button", { name: /next/i })); // funds
    await user.click(screen.getByRole("button", { name: /next/i })); // review
  }

  it("reaches a review step and calls onGenerate with a server-shaped payload", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    render(<CreateWizard onGenerate={onGenerate} />);
    await gotoReview(user);
    expect(screen.getByRole("heading", { name: /review/i })).toBeInTheDocument();
    // Terms acceptance gates Generate (PRD §21).
    await user.click(screen.getByLabelText(/terms/i));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const payload = onGenerate.mock.calls[0][0] as CreatePayload;
    expect(payload.name).toBe("House of Hope");
    // Three EXPLICIT shares as fractions — never an auto-midpoint (trap #1).
    expect(payload.inputs.demand.mode).toBe("market_share");
    expect(payload.inputs.demand.share_y1).toBeCloseTo(0.06, 5);
    expect(payload.terms_accepted).toBe(true);
  });

  it("does not allow Generate until terms are accepted", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    render(<CreateWizard onGenerate={onGenerate} />);
    await gotoReview(user);
    expect(screen.getByRole("button", { name: /generate/i })).toBeDisabled();
  });
});

describe("CreateWizard — draft recovery after step 1", () => {
  it("persists a draft once the user advances past step 1", async () => {
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull(); // nothing on step 1
    await fillField(/store name/i, "House of Hope");
    await fillField(/city/i, "Longview");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  it("offers to recover a saved draft on mount and restores its values", async () => {
    saveDraft(1, { name: "Recovered Store", city: "Tyler" });
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    const banner = screen.getByTestId("draft-recovery");
    expect(banner).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: /resume/i }));
    expect(screen.getByLabelText(/store name/i)).toHaveValue("Recovered Store");
  });

  it("can discard a recoverable draft", async () => {
    saveDraft(1, { name: "Recovered Store", city: "Tyler" });
    const user = userEvent.setup();
    render(<CreateWizard onGenerate={() => Promise.resolve()} />);
    await user.click(
      within(screen.getByTestId("draft-recovery")).getByRole("button", { name: /discard/i }),
    );
    expect(screen.queryByTestId("draft-recovery")).not.toBeInTheDocument();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// web/src/components/ProposalUpload.test.tsx — PE9 (#128): the composer's proposal
// upload affordance + the phase→month confirm UI. Spec B §5.1/§9.
//
// ProposalUpload posts the PDF to POST /api/penny/proposal (server-side, untrusted)
// and hands back the opaque proposal_ref the next Penny turn threads into
// parse_proposal. ProposalMonthMap renders the STATED phase→month mapping with a
// Confirm/Adjust affordance — nothing is populated until the user confirms (§9).
//
// fetch is mocked (no real upload endpoint, ever).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProposalMonthMap, ProposalUpload } from "./ProposalUpload";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pdfFile(name = "consultant-plan.pdf") {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type: "application/pdf",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProposalUpload — composer affordance", () => {
  it("uploads the chosen PDF to /api/penny/proposal and returns the proposal_ref", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ proposal_ref: "prop_abc", filename: "consultant-plan.pdf" }, 201)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUploaded = vi.fn();
    const user = userEvent.setup();

    render(<ProposalUpload token="edit-tok" onUploaded={onUploaded} />);
    await user.upload(screen.getByTestId("proposal-file-input"), pdfFile());

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("prop_abc", "consultant-plan.pdf"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/penny/proposal");
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer edit-tok");
    expect(new Headers((init as RequestInit).headers).get("Content-Type")).toBe("application/pdf");
  });

  it("shows the attached filename with a remove control that clears it", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <ProposalUpload
        token="t"
        attachedName="consultant-plan.pdf"
        onUploaded={vi.fn()}
        onClear={onClear}
      />,
    );
    expect(screen.getByText(/consultant-plan\.pdf/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /remove proposal/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it("surfaces an upload rejection (415) as a friendly error, never a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "unsupported_type" }, 415))),
    );
    const onError = vi.fn();
    const user = userEvent.setup();
    render(<ProposalUpload token="t" onUploaded={vi.fn()} onError={onError} />);
    await user.upload(screen.getByTestId("proposal-file-input"), pdfFile());
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0][0])).toMatch(/pdf/i);
  });
});

describe("ProposalMonthMap — state the mapping, ask to confirm", () => {
  it("renders the inferred phase→month mapping and the opening month", () => {
    render(
      <ProposalMonthMap
        mapping={[
          { phase: "Phase 1", month: 1 },
          { phase: "Phase 2", month: 3 },
        ]}
        openingMonth={5}
        onConfirm={vi.fn()}
      />,
    );
    const panel = screen.getByTestId("proposal-month-map");
    expect(panel.textContent).toMatch(/Phase 1/);
    expect(panel.textContent).toMatch(/Phase 2/);
    expect(panel.textContent).toMatch(/month 5/i); // grand opening anchor
  });

  it("confirming and adjusting invoke their callbacks (populate waits for confirm)", async () => {
    const onConfirm = vi.fn();
    const onAdjust = vi.fn();
    const user = userEvent.setup();
    render(
      <ProposalMonthMap
        mapping={[{ phase: "Phase 1", month: 1 }]}
        onConfirm={onConfirm}
        onAdjust={onAdjust}
      />,
    );
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /adjust/i }));
    expect(onAdjust).toHaveBeenCalled();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TopBar } from "./TopBar";

// Component + a11y tests for the persistent top bar (M2.5). The version chip is
// server-owned; the save-label is a live region (a11y); meaning carries text, not
// color alone.

describe("TopBar", () => {
  it("renders as a banner landmark with the product name", () => {
    render(<TopBar />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText(/Thrift Store Projection/i)).toBeInTheDocument();
  });

  it("shows a placeholder version chip until a projection loads", () => {
    render(<TopBar />);
    expect(screen.getByTestId("version-chip")).toHaveTextContent("model —");
  });

  it("renders the server-provided model version verbatim", () => {
    render(<TopBar modelVersion="2.0.0" />);
    expect(screen.getByTestId("version-chip")).toHaveTextContent("model 2.0.0");
  });

  it("the version chip has an accessible label", () => {
    render(<TopBar modelVersion="2.0.0" />);
    expect(screen.getByLabelText(/model version/i)).toBeInTheDocument();
  });

  it("renders the autosave label as a polite live region when saving", () => {
    render(<TopBar saveState="saving" />);
    const label = screen.getByTestId("save-label");
    expect(label).toHaveTextContent("Saving…");
    expect(label).toHaveAttribute("aria-live", "polite");
    expect(label).toHaveAttribute("role", "status");
  });

  it("renders the saved state with explicit text (not color alone)", () => {
    render(<TopBar saveState="saved" />);
    expect(screen.getByTestId("save-label")).toHaveTextContent("All changes saved");
  });

  it("renders a retry-able error state", () => {
    render(<TopBar saveState="error" />);
    expect(screen.getByTestId("save-label")).toHaveTextContent("Save failed — retry");
  });

  it("hides the save label when idle", () => {
    render(<TopBar saveState="idle" />);
    expect(screen.queryByTestId("save-label")).not.toBeInTheDocument();
  });

  it("renders children (e.g. a docked feedback control)", () => {
    render(
      <TopBar>
        <button>Feedback</button>
      </TopBar>,
    );
    expect(screen.getByRole("button", { name: /feedback/i })).toBeInTheDocument();
  });
});

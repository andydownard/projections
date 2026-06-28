import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { formatFromServer, NO_CLIENT_MATH } from "./api/client";

// M2.3 invariant (CLAUDE.md hard rule, PRD §13): the client computes NO projection
// math. It renders the server view-model only. These tests pin the shell + the
// no-client-math contract from commit one.

describe("App shell", () => {
  it("renders the persistent top bar with the product name", () => {
    render(<App />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText(/Store Projections/i)).toBeInTheDocument();
  });

  it("never renders a model version chip (#38 — model_version stays on computed_json, not the UI)", () => {
    render(<App />);
    // The model version is no longer displayed in the UI. It remains stamped on
    // computed_json (engine versioning contract + upgrade affordance); the shell
    // simply never renders it as a chip.
    expect(screen.queryByTestId("version-chip")).not.toBeInTheDocument();
  });
});

describe("no client math contract", () => {
  it("exposes a NO_CLIENT_MATH marker so a build guard can assert it", () => {
    expect(NO_CLIENT_MATH).toBe(true);
  });

  it("formatFromServer passes the server display string through verbatim", () => {
    // The server is the single formatting authority ({raw, display}); the client
    // never re-derives money/percent strings.
    expect(formatFromServer({ raw: 426911, display: "$426,911" })).toBe("$426,911");
    expect(formatFromServer({ raw: -12400, display: "($12,400)" })).toBe("($12,400)");
  });
});

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

  it("renders no model version chip until the server provides one", () => {
    render(<App />);
    // The version chip is server-owned: the bare shell (no projection loaded)
    // shows no chip at all — no client-rendered "model —" placeholder, and no
    // arithmetic on the client. It appears only when a projection supplies it.
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

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RootProviders } from "./RootProviders";

describe("RootProviders", () => {
  it("renders children", () => {
    const queryClient = new QueryClient();
    render(
      <RootProviders queryClient={queryClient}>
        <div data-testid="app-child">hello</div>
      </RootProviders>,
    );
    expect(screen.getByTestId("app-child")).toBeInTheDocument();
  });
});

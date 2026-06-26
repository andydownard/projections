import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlacesAutocomplete } from "./PlacesAutocomplete";

const PREDICTIONS = {
  predictions: [{ description: "Longview, TX, USA", place_id: "PID" }],
};
const RESOLVED = {
  location: { place_id: "PID", lat: 32.5, lng: -94.7, formatted_address: "Longview, TX, USA" },
  trade_area: {
    basis: "city",
    households: 31798,
    geography_name: "Longview city",
    geography_fips: "4843012",
    acs_vintage: "2022",
    households_source: "census_acs",
    moe: 412,
    alternatives: {
      city: { geography_name: "Longview city", fips: "4843012", households: 31798, moe: 412 },
    },
  },
  evidence: {
    field: "households",
    label: "Trade-area households",
    value: 31798,
    method: "census_acs",
    source: "Census",
    source_date: "2022",
    confidence: "estimated",
    geography: "Longview city",
  },
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PlacesAutocomplete", () => {
  it("debounces autocomplete and lists predictions as options", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/autocomplete") ? json(PREDICTIONS) : json(RESOLVED),
    );
    const user = userEvent.setup();
    render(
      <PlacesAutocomplete label="Store address" basis="city" onResolved={vi.fn()} onError={vi.fn()} />,
    );
    await user.type(screen.getByRole("combobox"), "Longview");
    expect(await screen.findByRole("option", { name: /Longview, TX/ })).toBeInTheDocument();
  });

  it("resolves the chosen prediction and returns the derived trade area", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/autocomplete") ? json(PREDICTIONS) : json(RESOLVED),
    );
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(
      <PlacesAutocomplete label="Store address" basis="city" onResolved={onResolved} onError={vi.fn()} />,
    );
    await user.type(screen.getByRole("combobox"), "Longview");
    await user.click(await screen.findByRole("option", { name: /Longview, TX/ }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(onResolved.mock.calls[0][0].trade_area.households).toBe(31798);
  });

  it("surfaces a typed resolve error (census_unavailable) via onError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/autocomplete")
        ? json(PREDICTIONS)
        : json({ error: "census_unavailable" }, 503),
    );
    const onError = vi.fn();
    const user = userEvent.setup();
    render(
      <PlacesAutocomplete label="Store address" basis="city" onResolved={vi.fn()} onError={onError} />,
    );
    await user.type(screen.getByRole("combobox"), "Longview");
    await user.click(await screen.findByRole("option", { name: /Longview/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("census_unavailable"));
  });
});

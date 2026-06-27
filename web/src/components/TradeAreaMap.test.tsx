import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TradeAreaMap } from "./TradeAreaMap";

describe("TradeAreaMap", () => {
  it("renders the server-proxied static map when location is resolved", () => {
    render(
      <TradeAreaMap
        slug="abc"
        location={{ lat: 32.5, lng: -94.7, formatted_address: "Longview, TX" }}
        basis="city"
        geography="Longview city"
        size="detail"
      />,
    );
    const img = screen.getByRole("img", { name: /Map of Longview city/i });
    expect(img).toHaveAttribute("src", "/api/projections/abc/staticmap?size=detail");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(screen.getByText(/city trade area/i)).toBeInTheDocument();
  });

  it("shows a placeholder (never a broken image) when there is no location", () => {
    render(<TradeAreaMap slug="abc" location={null} size="thumb" />);
    expect(screen.getByRole("img", { name: /no mapped location/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Map of/i })).not.toBeInTheDocument();
  });

  it("falls back to the placeholder when the map image fails to load (no broken glyph)", () => {
    render(
      <TradeAreaMap
        slug="abc"
        location={{ lat: 32.5, lng: -94.7, formatted_address: "Longview, TX" }}
        size="detail"
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: /Map of Longview, TX/i }));
    expect(screen.getByRole("img", { name: /no mapped location/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Map of/i })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TradeAreaMap } from "./TradeAreaMap";

const LONGVIEW = { lat: 32.5, lng: -94.7, formatted_address: "Longview, TX" };

function stubFetch(status: number) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- DETAIL map (#266): fetch the proxy + branch on the HTTP status ---------------
describe("TradeAreaMap — detail (#266)", () => {
  it("renders the server-proxied static map when the proxy returns 200", async () => {
    stubFetch(200);
    render(
      <TradeAreaMap slug="abc" location={LONGVIEW} geography="Longview city" size="detail" />,
    );
    const img = await screen.findByRole("img", { name: /Map of Longview city/i });
    expect(img).toHaveAttribute("src", "/api/projections/abc/staticmap?size=detail");
    expect(img).toHaveAttribute("loading", "lazy");
    // #320: the visible "… trade area" caption is removed; the geography stays in the
    // descriptive alt text (asserted above), so no separate caption element renders.
    expect(screen.queryByText(/trade area/i)).not.toBeInTheDocument();
  });

  it("shows 'No mapped location' when the proxy 404s (a true no-location)", async () => {
    stubFetch(404);
    render(<TradeAreaMap slug="abc" location={LONGVIEW} size="detail" />);
    expect(await screen.findByRole("img", { name: /no mapped location/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Map of/i })).not.toBeInTheDocument();
  });

  it("distinguishes a 502 'map unavailable' from a 404 no-location", async () => {
    stubFetch(502);
    render(<TradeAreaMap slug="abc" location={LONGVIEW} size="detail" />);
    const placeholder = await screen.findByRole("img", { name: /map unavailable/i });
    expect(placeholder).toBeInTheDocument();
    // It must NOT read as "no mapped location" — the address resolved fine.
    expect(screen.queryByRole("img", { name: /no mapped location/i })).not.toBeInTheDocument();
  });

  it("treats a network/transport failure as 'map unavailable'", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    render(<TradeAreaMap slug="abc" location={LONGVIEW} size="detail" />);
    expect(await screen.findByRole("img", { name: /map unavailable/i })).toBeInTheDocument();
  });

  it("shows the placeholder WITHOUT hitting the proxy when there is no resolved location", async () => {
    const fetchMock = stubFetch(200);
    render(<TradeAreaMap slug="abc" location={null} size="detail" />);
    expect(await screen.findByRole("img", { name: /no mapped location/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- THUMB map (list): synchronous <img>, no status fetch -------------------------
describe("TradeAreaMap — thumb (list)", () => {
  it("renders the thumb image synchronously, without fetching the status", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<TradeAreaMap slug="abc" location={LONGVIEW} size="thumb" />);
    expect(screen.getByRole("img", { name: /Map of Longview, TX/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a placeholder (never a broken image) when there is no location", () => {
    render(<TradeAreaMap slug="abc" location={null} size="thumb" />);
    expect(screen.getByRole("img", { name: /no mapped location/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Map of/i })).not.toBeInTheDocument();
  });

  it("falls back to the placeholder when the thumb image fails to load (no broken glyph)", async () => {
    render(<TradeAreaMap slug="abc" location={LONGVIEW} size="thumb" />);
    fireEvent.error(screen.getByRole("img", { name: /Map of Longview, TX/i }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /no mapped location/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("img", { name: /Map of/i })).not.toBeInTheDocument();
  });
});

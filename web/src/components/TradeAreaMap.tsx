// web/src/components/TradeAreaMap.tsx — the store-location map (server-proxied).
//
// The image comes from /api/projections/<slug>/staticmap (the Google key stays
// server-side). Rendered ONLY when the location was resolved from an address — a
// manual/unresolved trade area shows a neutral placeholder, never a map asserting a
// location that does not exist. Descriptive alt text; the map is evidence for the
// top driver, not decoration, and never carries meaning alone.
//
// Epic G (#266): on the DETAIL page we FETCH the proxy and branch on the HTTP
// status so a transient upstream failure (502 "map unavailable") reads differently
// from a true "no resolved location" (404) — the owner can tell "we couldn't draw
// the map right now" from "this projection has no mapped address". The compact list
// THUMB keeps the lightweight <img> + onError fallback (no status distinction
// needed there, and it must render synchronously for the list).
import { useEffect, useState } from "react";

import type { LocationInfo } from "../api/viewModel";

export interface TradeAreaMapProps {
  slug: string;
  location?: LocationInfo | null;
  /** Trade-area geography name — used for the descriptive alt text only (#320 drops
   *  the visible caption; the geography still rides the image's alt). */
  geography?: string | null;
  size?: "thumb" | "detail";
}

const DIMS = {
  thumb: { w: 64, h: 44 },
  // Detail is a roughly-SQUARE box in the page's upper-right (#266), not a
  // stretched full-width banner — CSS crops the wide proxy image to the box.
  detail: { w: 260, h: 260 },
} as const;

type DetailState = "loading" | "ok" | "no-location" | "unavailable";

export function TradeAreaMap({
  slug,
  location,
  geography,
  size = "detail",
}: TradeAreaMapProps) {
  const hasLocation = !!location && location.lat != null && location.lng != null;
  const dims = DIMS[size];
  const where = geography ?? location?.formatted_address ?? "the store location";
  const mapUrl = `/api/projections/${encodeURIComponent(slug)}/staticmap?size=${size}`;

  // THUMB path state: a simple broken-image fallback (reset when the slug changes).
  const [thumbFailed, setThumbFailed] = useState(false);
  useEffect(() => setThumbFailed(false), [slug]);

  // DETAIL path state: fetch the proxy and branch on the status (#266).
  const [detailState, setDetailState] = useState<DetailState>("loading");
  useEffect(() => {
    if (size !== "detail") return;
    if (!hasLocation) {
      setDetailState("no-location");
      return;
    }
    let cancelled = false;
    setDetailState("loading");
    fetch(mapUrl)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setDetailState("ok");
        // 404 = no resolved location (or unknown slug); 502 = upstream/quota error.
        else if (res.status === 404) setDetailState("no-location");
        else setDetailState("unavailable");
      })
      .catch(() => {
        // A network/transport failure is "map unavailable" — not "no location".
        if (!cancelled) setDetailState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [size, slug, hasLocation, mapUrl]);

  // --- compact list THUMB: synchronous <img> + onError placeholder (unchanged) ---
  if (size !== "detail") {
    if (!hasLocation || thumbFailed) {
      return (
        <div className={`map map--empty map--${size}`} role="img" aria-label="No mapped location">
          <span className="map__placeholder-text">No mapped location</span>
        </div>
      );
    }
    return (
      <figure className={`map map--${size}`}>
        <img
          className="map__img"
          src={mapUrl}
          alt={`Map of ${where}`}
          loading="lazy"
          width={dims.w}
          height={dims.h}
          onError={() => setThumbFailed(true)}
        />
      </figure>
    );
  }

  // --- DETAIL page map (#266): branch on the fetched status -----------------------
  if (detailState === "no-location") {
    return (
      <div className="map map--empty map--detail" role="img" aria-label="No mapped location">
        <span className="map__placeholder-text">No mapped location</span>
      </div>
    );
  }
  if (detailState === "unavailable") {
    // Distinct from "no location": the address resolved, but the map could not be
    // drawn right now (upstream 502 / quota / network) — say so, never a broken img.
    return (
      <div
        className="map map--empty map--unavailable map--detail"
        role="img"
        aria-label="Map unavailable"
      >
        <span className="map__placeholder-text">Map unavailable</span>
      </div>
    );
  }
  if (detailState === "loading") {
    return (
      <div className="map map--empty map--loading map--detail" role="img" aria-label="Loading map">
        <span className="map__placeholder-text">Loading map…</span>
      </div>
    );
  }
  // detailState === "ok"
  return (
    <figure className="map map--detail">
      <img
        className="map__img"
        src={mapUrl}
        alt={`Map of ${where}`}
        loading="lazy"
        width={dims.w}
        height={dims.h}
        onError={() => setDetailState("unavailable")}
      />
      {/* #320: the visible trade-area caption is removed — the geography stays in the
          image's descriptive alt text; the map sits LEFT with the content on the
          right (CSS order), so the caption no longer earns its vertical space. */}
    </figure>
  );
}

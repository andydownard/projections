// web/src/components/TradeAreaMap.tsx — the store-location map (server-proxied).
//
// The image is fetched from /api/projections/<slug>/staticmap (the Google key
// stays server-side). Rendered ONLY when the location was resolved from an
// address — a manual/unresolved trade area shows a neutral placeholder, never a
// map asserting a location that does not exist. Descriptive alt text; the map is
// evidence for the top driver, not decoration, and never carries meaning alone.
import type { LocationInfo } from "../api/viewModel";

export interface TradeAreaMapProps {
  slug: string;
  location?: LocationInfo | null;
  basis?: string | null;
  geography?: string | null;
  size?: "thumb" | "detail";
}

const DIMS = {
  thumb: { w: 120, h: 80 },
  detail: { w: 640, h: 280 },
} as const;

export function TradeAreaMap({
  slug,
  location,
  basis,
  geography,
  size = "detail",
}: TradeAreaMapProps) {
  if (!location || location.lat == null || location.lng == null) {
    return (
      <div className={`map map--empty map--${size}`} role="img" aria-label="No mapped location">
        <span className="map__placeholder-text">No mapped location</span>
      </div>
    );
  }
  const dims = DIMS[size];
  const where = geography ?? location.formatted_address ?? "the store location";
  return (
    <figure className={`map map--${size}`}>
      <img
        className="map__img"
        src={`/api/projections/${encodeURIComponent(slug)}/staticmap?size=${size}`}
        alt={`Map of ${where}`}
        loading="lazy"
        width={dims.w}
        height={dims.h}
      />
      {size === "detail" && geography && (
        <figcaption className="map__caption">
          {geography}
          {basis ? ` · ${basis} trade area` : ""}
        </figcaption>
      )}
    </figure>
  );
}

export default TradeAreaMap;

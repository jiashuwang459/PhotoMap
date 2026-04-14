import { useCallback, useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMapEvents,
} from "react-leaflet";
import type { Map as LeafletMap, LatLngBounds } from "leaflet";
import { queryByBoundingBox } from "../api/photos";
import type { BoundingBox, Page, Photo } from "../api/types";

// ── constants ────────────────────────────────────────────────────────────────

/** How many photos to load per bbox query (well within the 500-row cap). */
const BBOX_PAGE_SIZE = 200;

/** Default map centre (0°N, 0°E) shown before any interaction. */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 2;

// ── helper: format a Unix epoch as a short local date ────────────────────────

function fmtDate(ts: number | null): string {
  if (ts === null) return "No date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Extract the file name from an absolute path. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── BoundsTracker — fires a callback whenever the map viewport changes ────────

interface BoundsTrackerProps {
  onBoundsChange: (bounds: LatLngBounds) => void;
}

function BoundsTracker({ onBoundsChange }: BoundsTrackerProps) {
  const map = useMapEvents({
    moveend() {
      onBoundsChange(map.getBounds());
    },
    zoomend() {
      onBoundsChange(map.getBounds());
    },
  });

  // Fire once on mount so the initial viewport is queried immediately.
  useEffect(() => {
    onBoundsChange(map.getBounds());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── MapView ───────────────────────────────────────────────────────────────────

export function MapView() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a stable ref so the bounds-change callback always sees the latest value
  // without triggering extra re-renders.
  const mapRef = useRef<LeafletMap | null>(null);

  const handleBoundsChange = useCallback(async (bounds: LatLngBounds) => {
    const bbox: BoundingBox = {
      min_lat: bounds.getSouth(),
      max_lat: bounds.getNorth(),
      min_lon: bounds.getWest(),
      max_lon: bounds.getEast(),
    };

    // Collect all pages within the viewport (stop at BBOX_PAGE_SIZE for perf).
    setLoading(true);
    setError(null);
    try {
      const page: Page = { limit: BBOX_PAGE_SIZE, offset: 0 };
      const results = await queryByBoundingBox(bbox, page);
      setPhotos(results);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="map-view">
      {/* Status overlay */}
      <div className="map-status-bar">
        {loading && <span className="map-status-loading">Loading…</span>}
        {!loading && !error && (
          <span className="map-status-count">
            {photos.length === BBOX_PAGE_SIZE
              ? `${BBOX_PAGE_SIZE}+ geotagged photos in view`
              : `${photos.length} geotagged photo${photos.length !== 1 ? "s" : ""} in view`}
          </span>
        )}
        {error && (
          <span className="map-status-error" role="alert">
            {error}
          </span>
        )}
      </div>

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className="leaflet-map"
        ref={mapRef}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />

        <BoundsTracker onBoundsChange={handleBoundsChange} />

        {photos.map((photo) => {
          // lat/lon are guaranteed non-null by the bbox query
          const lat = photo.latitude as number;
          const lon = photo.longitude as number;
          return (
            <Marker key={photo.id} position={[lat, lon]}>
              <Popup>
                <div className="map-popup">
                  <strong className="map-popup-name">
                    {basename(photo.file_path)}
                  </strong>
                  <span className="map-popup-date">{fmtDate(photo.timestamp)}</span>
                  <span className="map-popup-gps">
                    {lat.toFixed(5)}°, {lon.toFixed(5)}°
                  </span>
                  <span className="map-popup-path" title={photo.file_path}>
                    {photo.file_path}
                  </span>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

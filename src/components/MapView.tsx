import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polygon,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Map as LeafletMap, LatLngBounds } from "leaflet";
import {
  generateThumbnailForPhoto,
  listTrips,
  queryByBoundingBox,
  queryPhotosByTrip,
} from "../api/photos";
import type { BoundingBox, Page, Photo, Trip } from "../api/types";

// ── constants ────────────────────────────────────────────────────────────────

/** How many photos to load per bbox query (well within the 500-row cap). */
const BBOX_PAGE_SIZE = 200;

/** Default map centre and zoom shown before any interaction. */
const DEFAULT_CENTER: [number, number] = [20, 0];
const DEFAULT_ZOOM = 2;

/** Width and height of each thumbnail pin image. */
const THUMB_SIZE = 72;

/** Height of the CSS arrow tip rendered below each pin via `::after`. */
const ARROW_H = 10;

/**
 * Extra pixel padding applied on every side when testing icon rects for
 * overlap.  Keeps adjacent pins from touching.
 */
const COLLISION_PAD = 6;

/**
 * Zoom level at which TripMapView switches from trip-centroid markers to
 * individual photo markers.
 */
const TRIP_DETAIL_ZOOM = 10;

/** Rotating colour palette for trip overlays. */
const TRIP_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#34495e", "#e91e63", "#00bcd4",
  "#ff5722", "#607d8b", "#8bc34a", "#ff9800", "#673ab7",
];

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(ts: number | null): string {
  if (ts === null) return "No date";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Photos mode or trips mode. */
type MapMode = "photos" | "trips";

/** Axis-aligned bounding box for a trip's geotagged photos. */
interface TripBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  centLat: number;
  centLon: number;
}

/** Loaded trip with its geotagged photos and computed spatial data. */
interface TripData {
  trip: Trip;
  /** Only photos that have both lat and lon. */
  photos: Photo[];
  bounds: TripBounds;
  /** Convex-hull polygon positions in [lat, lon] order for Leaflet. */
  hull: [number, number][];
  /** CSS colour string from TRIP_COLORS palette. */
  color: string;
}

// ── Clustering ───────────────────────────────────────────────────────────────

/** A group of spatially-nearby photos rendered as a single map marker. */
interface PhotoCluster {
  key: string;
  lat: number;
  lon: number;
  photos: Photo[];
}

/**
 * Returns the grid-cell width in degrees for the given Leaflet zoom level.
 * Finer cells at high zoom → less aggressive clustering.
 */
function zoomToCellDeg(zoom: number): number {
  if (zoom >= 18) return 0.0002;
  if (zoom >= 16) return 0.001;
  if (zoom >= 14) return 0.004;
  if (zoom >= 12) return 0.015;
  if (zoom >= 10) return 0.08;
  if (zoom >= 7)  return 0.5;
  if (zoom >= 5)  return 2;
  return 12;
}

function clusterPhotos(photos: Photo[], zoom: number): PhotoCluster[] {
  if (photos.length === 0) return [];
  const cellDeg = zoomToCellDeg(zoom);
  const cells = new Map<string, Photo[]>();

  for (const p of photos) {
    const cellX = Math.floor(p.longitude! / cellDeg);
    const cellY = Math.floor(p.latitude! / cellDeg);
    const key = `${cellX}:${cellY}`;
    let list = cells.get(key);
    if (!list) {
      list = [];
      cells.set(key, list);
    }
    list.push(p);
  }

  return Array.from(cells.entries()).map(([key, ps]) => ({
    key,
    lat: ps.reduce((s, p) => s + p.latitude!, 0) / ps.length,
    lon: ps.reduce((s, p) => s + p.longitude!, 0) / ps.length,
    photos: ps,
  }));
}

// ── Collision detection ───────────────────────────────────────────────────────

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: PixelRect, b: PixelRect): boolean {
  return !(
    a.x + a.w + COLLISION_PAD < b.x - COLLISION_PAD ||
    b.x + b.w + COLLISION_PAD < a.x - COLLISION_PAD ||
    a.y + a.h + COLLISION_PAD < b.y - COLLISION_PAD ||
    b.y + b.h + COLLISION_PAD < a.y - COLLISION_PAD
  );
}

function iconDims(cluster: PhotoCluster): [number, number] {
  const hasThumb = cluster.photos.some((p) => p.thumbnail_path);
  if (!hasThumb && cluster.photos.length === 1) return [36, 36 + ARROW_H];
  return [THUMB_SIZE, THUMB_SIZE + ARROW_H];
}

/**
 * Filters clusters so that no two rendered icons overlap in screen space.
 * Larger clusters always win (sorted by descending photo count first).
 */
function collisionFilter(
  clusters: PhotoCluster[],
  map: LeafletMap
): PhotoCluster[] {
  const sorted = [...clusters].sort((a, b) => {
    if (b.photos.length !== a.photos.length)
      return b.photos.length - a.photos.length;
    const aT = a.photos.some((p) => p.thumbnail_path) ? 1 : 0;
    const bT = b.photos.some((p) => p.thumbnail_path) ? 1 : 0;
    return bT - aT;
  });

  const placed: PixelRect[] = [];
  const visible: PhotoCluster[] = [];

  for (const cluster of sorted) {
    const pt = map.latLngToContainerPoint([cluster.lat, cluster.lon]);
    const [w, h] = iconDims(cluster);
    const rect: PixelRect = { x: pt.x - w / 2, y: pt.y - h, w, h };

    if (!placed.some((p) => rectsOverlap(p, rect))) {
      placed.push(rect);
      visible.push(cluster);
    }
  }

  return visible;
}

// ── Convex hull ───────────────────────────────────────────────────────────────

/**
 * Andrew's monotone-chain convex hull on a set of [lat, lon] points.
 * Returns the hull vertices in CCW order. Returns the original points when
 * fewer than 3 are provided.
 */
function convexHull(points: [number, number][]): [number, number][] {
  const n = points.length;
  if (n < 3) return [...points];

  const sorted = [...points].sort(
    ([ax, ay], [bx, by]) => ax !== bx ? ax - bx : ay - by
  );

  const cross = (
    O: [number, number],
    A: [number, number],
    B: [number, number]
  ) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);

  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

// ── Icon factories ───────────────────────────────────────────────────────────

function makeClusterIcon(cluster: PhotoCluster): L.DivIcon {
  const count = cluster.photos.length;
  const lead = cluster.photos.find((p) => p.thumbnail_path);

  if (count === 1) {
    const photo = cluster.photos[0];
    if (photo.thumbnail_path) {
      return L.divIcon({
        className: "photo-map-marker",
        html: `<img src="${convertFileSrc(photo.thumbnail_path)}" class="photo-map-img" alt="" />`,
        iconSize: [THUMB_SIZE, THUMB_SIZE + ARROW_H],
        iconAnchor: [THUMB_SIZE / 2, THUMB_SIZE + ARROW_H],
        popupAnchor: [0, -(THUMB_SIZE + ARROW_H + 4)],
      });
    }
    return L.divIcon({
      className: "photo-map-marker photo-map-marker--no-thumb",
      html: `<span class="photo-map-fallback">📷</span>`,
      iconSize: [36, 36 + ARROW_H],
      iconAnchor: [18, 36 + ARROW_H],
      popupAnchor: [0, -(36 + ARROW_H + 4)],
    });
  }

  const countLabel = count > 99 ? "99+" : String(count);
  const thumbHtml = lead?.thumbnail_path
    ? `<img src="${convertFileSrc(lead.thumbnail_path)}" class="photo-map-img" alt="" />`
    : `<span class="photo-map-fallback">📷</span>`;

  return L.divIcon({
    className: "photo-map-marker photo-map-cluster",
    html: `${thumbHtml}<span class="photo-map-count">${countLabel}</span>`,
    iconSize: [THUMB_SIZE, THUMB_SIZE + ARROW_H],
    iconAnchor: [THUMB_SIZE / 2, THUMB_SIZE + ARROW_H],
    popupAnchor: [0, -(THUMB_SIZE + ARROW_H + 4)],
  });
}

function makeTripIcon(td: TripData): L.DivIcon {
  const label =
    td.trip.name.length > 14
      ? td.trip.name.slice(0, 14) + "…"
      : td.trip.name;
  const lead = td.photos.find((p) => p.thumbnail_path);
  const countBadge = `<span class="photo-map-count" style="background:${td.color}">${td.photos.length}</span>`;

  if (lead?.thumbnail_path) {
    return L.divIcon({
      className: "photo-map-marker photo-map-cluster",
      html: `
        <img src="${convertFileSrc(lead.thumbnail_path)}" class="photo-map-img" alt="" />
        ${countBadge}
        <span class="trip-map-label">${label}</span>
      `,
      iconSize: [THUMB_SIZE, THUMB_SIZE + ARROW_H + 20],
      iconAnchor: [THUMB_SIZE / 2, THUMB_SIZE + ARROW_H + 20],
    });
  }
  return L.divIcon({
    className: "photo-map-marker photo-map-marker--no-thumb",
    html: `
      <span class="photo-map-fallback" style="background:${td.color}">✈️</span>
      <span class="trip-map-label">${label}</span>
    `,
    iconSize: [60, 36 + ARROW_H + 20],
    iconAnchor: [30, 36 + ARROW_H + 20],
  });
}

// ── ViewportTracker ───────────────────────────────────────────────────────────

interface ViewportTrackerProps {
  onViewportChange: (bounds: LatLngBounds, zoom: number) => void;
}

function ViewportTracker({ onViewportChange }: ViewportTrackerProps) {
  const map = useMapEvents({
    moveend() {
      onViewportChange(map.getBounds(), map.getZoom());
    },
    zoomend() {
      onViewportChange(map.getBounds(), map.getZoom());
    },
  });

  useEffect(() => {
    onViewportChange(map.getBounds(), map.getZoom());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── JumpToTrip ────────────────────────────────────────────────────────────────

/**
 * Small dropdown rendered inside the MapContainer that pans+zooms to a
 * selected trip. Must live inside `<MapContainer>` to access `useMap()`.
 */
function JumpToTrip({ tripDataList }: { tripDataList: TripData[] }) {
  const map = useMap();
  const [value, setValue] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value);
    setValue("");
    if (!id) return;
    const td = tripDataList.find((t) => t.trip.id === id);
    if (!td) return;
    map.fitBounds(
      [
        [td.bounds.minLat, td.bounds.minLon],
        [td.bounds.maxLat, td.bounds.maxLon],
      ],
      { padding: [40, 40], maxZoom: 14 }
    );
  };

  return (
    <div className="jump-to-trip">
      <select value={value} onChange={handleChange}>
        <option value="">Jump to trip…</option>
        {tripDataList.map((td) => (
          <option key={td.trip.id} value={String(td.trip.id)}>
            {td.trip.name} ({td.photos.length})
          </option>
        ))}
      </select>
    </div>
  );
}

// ── PhotoViewer ───────────────────────────────────────────────────────────────

interface PhotoViewerProps {
  photos: Photo[];
  initialIndex: number;
  onClose: () => void;
}

/**
 * Full-screen viewer for the original photo file (not the thumbnail).
 *
 * The overlay dims the whole screen; prev/next/close controls float at fixed
 * positions so they are always visible regardless of image size.
 */
function PhotoViewer({ photos, initialIndex, onClose }: PhotoViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const n = photos.length;
  const photo = photos[index];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (n > 1 && e.key === "ArrowLeft")
        setIndex((i) => (i - 1 + n) % n);
      else if (n > 1 && e.key === "ArrowRight")
        setIndex((i) => (i + 1) % n);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, n]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <div className="photo-viewer-overlay" onClick={onClose}>
      {/* Fixed controls — always visible */}
      <button
        className="photo-viewer-close"
        onClick={(e) => { stop(e); onClose(); }}
        aria-label="Close"
      >
        ✕
      </button>

      {n > 1 && (
        <div className="photo-viewer-counter-badge" onClick={stop}>
          {index + 1} / {n}
        </div>
      )}

      {n > 1 && (
        <button
          className="photo-viewer-prev"
          onClick={(e) => { stop(e); setIndex((i) => (i - 1 + n) % n); }}
          aria-label="Previous photo"
        >
          ‹
        </button>
      )}
      {n > 1 && (
        <button
          className="photo-viewer-next"
          onClick={(e) => { stop(e); setIndex((i) => (i + 1) % n); }}
          aria-label="Next photo"
        >
          ›
        </button>
      )}

      {/* Stage: stops click-through to overlay */}
      <div className="photo-viewer-stage" onClick={stop}>
        <img
          src={convertFileSrc(photo.file_path)}
          className="photo-viewer-img"
          alt={basename(photo.file_path)}
        />
        <div className="photo-viewer-info">
          <strong className="photo-viewer-name">
            {basename(photo.file_path)}
          </strong>
          <span className="photo-viewer-date">{fmtDate(photo.timestamp)}</span>
          {photo.latitude != null && photo.longitude != null && (
            <span className="photo-viewer-gps">
              {(photo.latitude as number).toFixed(5)}°,{" "}
              {(photo.longitude as number).toFixed(5)}°
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── ClusterBrowser ────────────────────────────────────────────────────────────

interface ClusterBrowserProps {
  cluster: PhotoCluster;
  onClose: () => void;
}

/**
 * Centered modal with a tight thumbnail grid for all photos in a cluster.
 * Opens PhotoViewer (original file) on cell click.
 * Triggers thumbnail generation for photos that lack one on mount.
 */
function ClusterBrowser({ cluster, onClose }: ClusterBrowserProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [localPhotos, setLocalPhotos] = useState<Photo[]>(cluster.photos);
  const n = localPhotos.length;

  // Kick off thumbnail generation for photos that are missing one.
  useEffect(() => {
    const needThumb = cluster.photos.filter((p) => !p.thumbnail_path);
    if (needThumb.length === 0) return;
    let cancelled = false;

    void Promise.allSettled(
      needThumb.map(async (photo) => {
        try {
          const thumbPath = await generateThumbnailForPhoto(photo.id);
          if (!cancelled) {
            setLocalPhotos((prev) =>
              prev.map((p) =>
                p.id === photo.id ? { ...p, thumbnail_path: thumbPath } : p
              )
            );
          }
        } catch {
          // silently skip — the photo will remain a fallback icon
        }
      })
    );
    return () => {
      cancelled = true;
    };
  }, [cluster.photos]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && viewerIndex === null) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewerIndex, onClose]);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <>
      <div
        className="cluster-browser-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`${n} photos in this area`}
        onClick={onClose}
      >
        <div className="cluster-browser" onClick={stopPropagation}>
          <div className="cluster-browser-header">
            <span className="cluster-browser-title">
              {n} photo{n !== 1 ? "s" : ""} in this area
            </span>
            <button
              className="cluster-browser-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="cluster-browser-grid">
            {localPhotos.map((photo, index) => (
              <button
                key={photo.id}
                className="cluster-browser-cell"
                onClick={() => setViewerIndex(index)}
                title={basename(photo.file_path)}
              >
                {photo.thumbnail_path ? (
                  <img
                    src={convertFileSrc(photo.thumbnail_path)}
                    className="cluster-browser-thumb"
                    alt=""
                  />
                ) : (
                  <span className="cluster-browser-no-thumb" aria-hidden="true">
                    📷
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {viewerIndex !== null && (
        <PhotoViewer
          photos={localPhotos}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>,
    document.body
  );
}

// ── TripDetailPanel ───────────────────────────────────────────────────────────

interface TripDetailPanelProps {
  tripData: TripData;
  onClose: () => void;
}

/**
 * Centered modal showing the photo grid for a trip.
 * Clicking any cell opens the full-size PhotoViewer.
 */
function TripDetailPanel({ tripData, onClose }: TripDetailPanelProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const n = tripData.photos.length;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && viewerIndex === null) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewerIndex, onClose]);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <>
      <div
        className="cluster-browser-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={tripData.trip.name}
        onClick={onClose}
      >
        <div className="cluster-browser" onClick={stopPropagation}>
          <div className="cluster-browser-header">
            <span className="cluster-browser-title">
              <span
                className="trip-detail-dot"
                style={{ background: tripData.color }}
              />
              {tripData.trip.name}
              <span className="trip-detail-count">
                {" "}
                · {n} photo{n !== 1 ? "s" : ""}
              </span>
            </span>
            <button
              className="cluster-browser-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="cluster-browser-grid">
            {tripData.photos.map((photo, index) => (
              <button
                key={photo.id}
                className="cluster-browser-cell"
                onClick={() => setViewerIndex(index)}
                title={basename(photo.file_path)}
              >
                {photo.thumbnail_path ? (
                  <img
                    src={convertFileSrc(photo.thumbnail_path)}
                    className="cluster-browser-thumb"
                    alt=""
                  />
                ) : (
                  <span className="cluster-browser-no-thumb" aria-hidden="true">
                    📷
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {viewerIndex !== null && (
        <PhotoViewer
          photos={tripData.photos}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>,
    document.body
  );
}

// ── MapView ───────────────────────────────────────────────────────────────────

interface MapViewProps {
  isActive: boolean;
}

export function MapView({ isActive }: MapViewProps) {
  const [mapMode, setMapMode] = useState<MapMode>("photos");

  // ── Photos-mode state ─────────────────────────────────────────────────────
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<PhotoCluster | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[] | null>(null);
  const [viewportVersion, setViewportVersion] = useState(0);

  // ── Trips-mode state ──────────────────────────────────────────────────────
  const [tripDataList, setTripDataList] = useState<TripData[]>([]);
  const [loadingTrips, setLoadingTrips] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<TripData | null>(null);
  /** True once trip data has been fetched (avoid re-fetching on tab switch). */
  const tripsLoadedRef = useRef(false);

  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    if (isActive) mapRef.current?.invalidateSize();
  }, [isActive]);

  // ── Load trip data when trips mode is first activated ─────────────────────
  useEffect(() => {
    if (mapMode !== "trips" || tripsLoadedRef.current) return;
    tripsLoadedRef.current = true;

    (async () => {
      setLoadingTrips(true);
      try {
        const trips = await listTrips({ limit: 500, offset: 0 });
        const settled = await Promise.allSettled(
          trips.map(async (trip, idx): Promise<TripData | null> => {
            const photos = await queryPhotosByTrip(trip.id, {
              limit: 500,
              offset: 0,
            });
            const geoPhotos = photos.filter(
              (p) => p.latitude !== null && p.longitude !== null
            );
            if (geoPhotos.length === 0) return null;

            const lats = geoPhotos.map((p) => p.latitude!);
            const lons = geoPhotos.map((p) => p.longitude!);
            const bounds: TripBounds = {
              minLat: Math.min(...lats),
              maxLat: Math.max(...lats),
              minLon: Math.min(...lons),
              maxLon: Math.max(...lons),
              centLat: lats.reduce((a, b) => a + b, 0) / lats.length,
              centLon: lons.reduce((a, b) => a + b, 0) / lons.length,
            };
            const hullPts: [number, number][] = geoPhotos.map((p) => [
              p.latitude!,
              p.longitude!,
            ]);
            return {
              trip,
              photos: geoPhotos,
              bounds,
              hull: convexHull(hullPts),
              color: TRIP_COLORS[idx % TRIP_COLORS.length],
            };
          })
        );
        const results: TripData[] = settled
          .filter(
            (r): r is PromiseFulfilledResult<TripData | null> =>
              r.status === "fulfilled"
          )
          .map((r) => r.value)
          .filter((v): v is TripData => v !== null);
        setTripDataList(results);
      } catch {
        // trip loading errors are non-fatal
      } finally {
        setLoadingTrips(false);
      }
    })();
  }, [mapMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewportChange = useCallback(
    async (bounds: LatLngBounds, newZoom: number) => {
      setZoom(newZoom);
      setViewportVersion((v) => v + 1);
      const bbox: BoundingBox = {
        min_lat: bounds.getSouth(),
        max_lat: bounds.getNorth(),
        min_lon: bounds.getWest(),
        max_lon: bounds.getEast(),
      };
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
    },
    []
  );

  const clusters = useMemo(
    () => clusterPhotos(photos, zoom),
    [photos, zoom]
  );

  const visibleClusters = useMemo(() => {
    if (!mapRef.current) return clusters;
    return collisionFilter(clusters, mapRef.current);
  }, [clusters, viewportVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTripClick = useCallback(
    (td: TripData) => {
      setSelectedTrip(td);
      mapRef.current?.fitBounds(
        [
          [td.bounds.minLat, td.bounds.minLon],
          [td.bounds.maxLat, td.bounds.maxLon],
        ],
        { padding: [40, 40], maxZoom: 14 }
      );
    },
    []
  );

  return (
    <div className="map-view">
      {/* Mode toggle */}
      <div className="map-mode-toggle">
        <button
          className={`map-mode-btn${mapMode === "photos" ? " active" : ""}`}
          onClick={() => setMapMode("photos")}
        >
          📷 Photos
        </button>
        <button
          className={`map-mode-btn${mapMode === "trips" ? " active" : ""}`}
          onClick={() => setMapMode("trips")}
        >
          ✈️ Trips
        </button>
      </div>

      {/* Status bar */}
      <div className="map-status-bar">
        {(loading || loadingTrips) && (
          <span className="map-status-loading">Loading…</span>
        )}
        {!loading && !loadingTrips && !error && mapMode === "photos" && (
          <span className="map-status-count">
            {photos.length === BBOX_PAGE_SIZE
              ? `${BBOX_PAGE_SIZE}+ geotagged photos in view`
              : `${photos.length} geotagged photo${photos.length !== 1 ? "s" : ""} in view`}
          </span>
        )}
        {!loading && !loadingTrips && !error && mapMode === "trips" && (
          <span className="map-status-count">
            {tripDataList.length} trip{tripDataList.length !== 1 ? "s" : ""} with GPS data
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

        <ViewportTracker onViewportChange={handleViewportChange} />

        {/* ── Photos mode markers ───────────────────────────────────────────── */}
        {mapMode === "photos" &&
          visibleClusters.map((cluster) => {
            const icon = makeClusterIcon(cluster);
            const isCluster = cluster.photos.length > 1;
            return (
              <Marker
                key={cluster.key}
                position={[cluster.lat, cluster.lon]}
                icon={icon}
                eventHandlers={{
                  click: isCluster
                    ? () => setSelectedCluster(cluster)
                    : () => setViewerPhotos([cluster.photos[0]]),
                }}
              />
            );
          })}

        {/* ── Trips mode overlays ───────────────────────────────────────────── */}
        {mapMode === "trips" &&
          tripDataList.map((td) => (
            <Polygon
              key={td.trip.id}
              positions={td.hull}
              pathOptions={{
                color: td.color,
                fillColor: td.color,
                fillOpacity: 0.13,
                weight: 2.5,
                opacity: 0.75,
              }}
              eventHandlers={{ click: () => handleTripClick(td) }}
            >
              <Tooltip sticky>{td.trip.name}</Tooltip>
            </Polygon>
          ))}

        {/* Trip centroid markers (low zoom) */}
        {mapMode === "trips" &&
          zoom < TRIP_DETAIL_ZOOM &&
          tripDataList.map((td) => (
            <Marker
              key={`trip-marker-${td.trip.id}`}
              position={[td.bounds.centLat, td.bounds.centLon]}
              icon={makeTripIcon(td)}
              eventHandlers={{ click: () => handleTripClick(td) }}
            />
          ))}

        {/* Individual photo markers at high zoom in trips mode */}
        {mapMode === "trips" &&
          zoom >= TRIP_DETAIL_ZOOM &&
          visibleClusters.map((cluster) => {
            const icon = makeClusterIcon(cluster);
            const isCluster = cluster.photos.length > 1;
            return (
              <Marker
                key={cluster.key}
                position={[cluster.lat, cluster.lon]}
                icon={icon}
                eventHandlers={{
                  click: isCluster
                    ? () => setSelectedCluster(cluster)
                    : () => setViewerPhotos([cluster.photos[0]]),
                }}
              />
            );
          })}

        {/* Jump to trip dropdown — inside MapContainer to access useMap() */}
        {mapMode === "trips" && tripDataList.length > 0 && (
          <JumpToTrip tripDataList={tripDataList} />
        )}
      </MapContainer>

      {selectedCluster && (
        <ClusterBrowser
          cluster={selectedCluster}
          onClose={() => setSelectedCluster(null)}
        />
      )}

      {viewerPhotos && (
        <PhotoViewer
          photos={viewerPhotos}
          initialIndex={0}
          onClose={() => setViewerPhotos(null)}
        />
      )}

      {selectedTrip && (
        <TripDetailPanel
          tripData={selectedTrip}
          onClose={() => setSelectedTrip(null)}
        />
      )}
    </div>
  );
}

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
import { listen } from "@tauri-apps/api/event";
import type { Map as LeafletMap, LatLngBounds } from "leaflet";
import {
  getPhotoByPath,
  getPhotoById,
  listTrips,
  queryByBoundingBox,
  queryPhotosByTrip,
  startThumbnailWorker,
  getHomeLocation,
  listHomeTransitions,
} from "../api/photos";
import type { BoundingBox, HomeLocation, HomeTransition, Page, Photo, Trip } from "../api/types";
import { useThumbnailWorker } from "../context/ThumbnailWorkerContext";

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
 * individual photo markers. Higher value = centroid markers persist longer.
 */
const TRIP_DETAIL_ZOOM = 14;

/** Rotating colour palette for trip overlays. */
const TRIP_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#34495e", "#e91e63", "#00bcd4",
  "#ff5722", "#607d8b", "#8bc34a", "#ff9800", "#673ab7",
];

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(ts: number | null): string {
  if (ts === null) return "No date";
  // Timestamps are stored as "camera local time treated as UTC", so display
  // in UTC to recover the original camera clock reading.
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function fmtDateRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return "No dates";
  if (start === null) return fmtShortDate(end!);
  if (end === null || start === end) return fmtShortDate(start);
  return `${fmtShortDate(start)} – ${fmtShortDate(end)}`;
}

function fmtShortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
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
  /** Tauri file-src URL for the cover photo thumbnail, if any. */
  coverThumbnailSrc: string | null;
}

// ── Clustering ───────────────────────────────────────────────────────────────

/** A group of spatially-nearby photos rendered as a single map marker. */
interface PhotoCluster {
  key: string;
  lat: number;
  lon: number;
  photos: Photo[];
}

/** A group of spatially-nearby trip pins rendered as a single "N trips" marker. */
interface TripCluster {
  key: string;
  lat: number;
  lon: number;
  trips: TripData[];
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
  if (zoom >= 9)  return 0.18;
  if (zoom >= 7)  return 0.5;
  if (zoom >= 5)  return 2;
  return 12;
}

/**
 * Returns the grid-cell width in degrees used to cluster trip pins.
 * Intentionally small so only very nearby trips merge into a cluster.
 */
/**
 * Grid cell size (degrees) used to cluster nearby trip centroid pins.
 * Returns 0 at zoom ≥ 12 to signal "no clustering" — every trip gets its
 * own individual pin.
 */
function zoomToTripCellDeg(zoom: number): number {
  if (zoom >= 12) return 0;      // no clustering
  if (zoom >= 11) return 0.08;
  if (zoom >= 10) return 0.15;
  if (zoom >= 9)  return 0.25;
  if (zoom >= 8)  return 0.4;
  if (zoom >= 6)  return 1.5;
  if (zoom >= 4)  return 4;
  return 8;
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

/**
 * Groups trip centroid pins into clusters when they are very close together.
 * Single-trip cells are passed through as-is; multi-trip cells produce one
 * "N trips" cluster marker positioned at their combined centroid.
 */
function clusterTrips(tripDataList: TripData[], zoom: number): TripCluster[] {
  if (tripDataList.length === 0) return [];
  const cellDeg = zoomToTripCellDeg(zoom);

  // At zoom ≥ 12 (cellDeg === 0) every trip gets its own pin — no merging.
  if (cellDeg === 0) {
    return tripDataList.map((td) => ({
      key: `tc:solo:${td.trip.id}`,
      lat: td.bounds.centLat,
      lon: td.bounds.centLon,
      trips: [td],
    }));
  }

  const cells = new Map<string, TripData[]>();

  for (const td of tripDataList) {
    const cellX = Math.floor(td.bounds.centLon / cellDeg);
    const cellY = Math.floor(td.bounds.centLat / cellDeg);
    const key = `tc:${cellX}:${cellY}`;
    let list = cells.get(key);
    if (!list) {
      list = [];
      cells.set(key, list);
    }
    list.push(td);
  }

  return Array.from(cells.entries()).map(([key, tds]) => ({
    key,
    lat: tds.reduce((s, td) => s + td.bounds.centLat, 0) / tds.length,
    lon: tds.reduce((s, td) => s + td.bounds.centLon, 0) / tds.length,
    trips: tds,
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

/**
 * Compute the polygon centroid (area-weighted) of a convex hull.
 * For degenerate hulls with fewer than 3 points, falls back to the
 * arithmetic mean of the hull vertices so the pin is always equidistant
 * from the polygon boundary rather than sitting at the bbox midpoint.
 */
function hullCentroid(hull: [number, number][]): [number, number] {
  const n = hull.length;
  if (n === 0) return [0, 0];
  if (n === 1) return [hull[0][0], hull[0][1]];
  if (n === 2)
    return [(hull[0][0] + hull[1][0]) / 2, (hull[0][1] + hull[1][1]) / 2];

  // Shoelace-based polygon centroid
  let area = 0;
  let cLat = 0;
  let cLon = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cLat += (x0 + x1) * cross;
    cLon += (y0 + y1) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    // Degenerate (collinear): fall back to vertex mean
    const sumLat = hull.reduce((s, p) => s + p[0], 0);
    const sumLon = hull.reduce((s, p) => s + p[1], 0);
    return [sumLat / n, sumLon / n];
  }
  return [cLat / (6 * area), cLon / (6 * area)];
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

/** Pin width in pixels. */
const TRIP_PIN_W = 96;
const TRIP_PIN_THUMB = 64;
const TRIP_PIN_H = TRIP_PIN_THUMB + 22; // thumbnail + label strip

function makeTripIcon(td: TripData): L.DivIcon {
  const imgHtml = td.coverThumbnailSrc
    ? `<img src="${td.coverThumbnailSrc}" class="trip-map-pin-img" alt="" />`
    : `<div class="trip-map-pin-img trip-map-pin-img--placeholder" style="background:${td.color}">✈️</div>`;
  return L.divIcon({
    className: "trip-map-pin",
    html: `
      ${imgHtml}
      <div class="trip-map-pin-label" style="border-color:${td.color}">${td.trip.name}</div>
    `,
    iconSize: [TRIP_PIN_W, TRIP_PIN_H],
    iconAnchor: [TRIP_PIN_W / 2, TRIP_PIN_H],
    popupAnchor: [0, -(TRIP_PIN_H + 4)],
  });
}

/** Marker for a group of ≥2 nearby trips merged at this zoom level. */
function makeTripClusterIcon(tc: TripCluster): L.DivIcon {
  const count = tc.trips.length;
  return L.divIcon({
    className: "trip-map-pin",
    html: `
      <div class="trip-map-pin-img trip-map-pin-img--cluster">${count}</div>
      <div class="trip-map-pin-label trip-map-pin-label--cluster">${count} trips</div>
    `,
    iconSize: [TRIP_PIN_W, TRIP_PIN_H],
    iconAnchor: [TRIP_PIN_W / 2, TRIP_PIN_H],
    popupAnchor: [0, -70],
  });
}

/** Marker icon for the current home location. */
function makeHomeMarkerIcon(isCurrent: boolean): L.DivIcon {
  return L.divIcon({
    className: `photo-map-marker photo-map-marker--home${isCurrent ? "" : " photo-map-marker--home-old"}`,
    html: isCurrent
      ? `<span class="photo-map-home-icon" aria-label="Current home">🏠</span>`
      : `<span class="photo-map-home-icon photo-map-home-icon--old" aria-label="Previous home">🏚️</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -44],
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
 * Small dropdown rendered inside the MapContainer that flies to and focuses a
 * selected trip.  Uses an `onSelect` callback so the parent can update focused
 * trip state without this component needing `useMap()`.
 *
 * `L.DomEvent.disableClickPropagation` prevents map interactions from leaking
 * through the control.
 */
function JumpToTrip({
  tripDataList,
  onSelect,
}: {
  tripDataList: TripData[];
  onSelect: (td: TripData) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState("");

  // Prevent map click/scroll from bleeding through the control.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value);
    // Blur immediately so the map doesn't receive stray mouse events.
    e.target.blur();
    // Reset the select to the placeholder so the same trip can be re-selected.
    setValue("");
    if (!id) return;
    const td = tripDataList.find((t) => t.trip.id === id);
    if (!td) return;
    onSelect(td);
  };

  return (
    <div ref={containerRef} className="jump-to-trip">
      <select value={value} onChange={handleChange} aria-label="Jump to trip">
        <option value="" disabled>
          Jump to trip…
        </option>
        {tripDataList.map((td) => (
          <option key={td.trip.id} value={String(td.trip.id)}>
            {td.trip.name} — {fmtDateRange(td.trip.start_ts, td.trip.end_ts)} ({td.photos.length} photo{td.photos.length !== 1 ? "s" : ""})
          </option>
        ))}
      </select>
    </div>
  );
}

// ── ZoomSlider ────────────────────────────────────────────────────────────────

/**
 * Horizontal zoom slider rendered at the bottom-left of the map.
 * Replaces the default Leaflet zoom control (disabled via `zoomControl={false}`
 * on MapContainer).
 */
function ZoomSlider() {
  const map = useMap();
  const [currentZoom, setCurrentZoom] = useState(map.getZoom());
  const containerRef = useRef<HTMLDivElement | null>(null);

  useMapEvents({
    zoomend() {
      setCurrentZoom(map.getZoom());
    },
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }, []);

  return (
    <div ref={containerRef} className="zoom-slider-ctrl">
      <button
        className="zoom-slider-btn"
        onClick={() => map.setZoom(map.getZoom() - 1)}
        aria-label="Zoom out"
      >
        −
      </button>
      <input
        type="range"
        className="zoom-slider-input"
        min={map.getMinZoom() || 1}
        max={map.getMaxZoom() || 18}
        step={1}
        value={currentZoom}
        onChange={(e) => map.setZoom(Number(e.target.value))}
        aria-label="Zoom level"
      />
      <button
        className="zoom-slider-btn"
        onClick={() => map.setZoom(map.getZoom() + 1)}
        aria-label="Zoom in"
      >
        +
      </button>
      <span className="zoom-slider-label">{currentZoom}</span>
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
 *
 * Kicks off the background thumbnail worker for any photos that lack a
 * thumbnail, then listens for `thumbnail_progress` / `thumbnail_done` events
 * to refresh those photos' thumbnail paths progressively.
 */
function ClusterBrowser({ cluster, onClose }: ClusterBrowserProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [localPhotos, setLocalPhotos] = useState<Photo[]>(cluster.photos);
  const n = localPhotos.length;

  // Use a ref so the async refresh closure always sees the latest snapshot.
  const localPhotosRef = useRef<Photo[]>(cluster.photos);
  useEffect(() => {
    localPhotosRef.current = localPhotos;
  }, [localPhotos]);

  // When thumbnails are bulk-cleared, reset local photos so stale paths are not shown.
  const { clearKey } = useThumbnailWorker();
  useEffect(() => {
    if (clearKey > 0) {
      setLocalPhotos((prev) => prev.map((p) => ({ ...p, thumbnail_path: null })));
    }
  }, [clearKey]);

  // Kick the background thumbnail worker and listen for progress events.
  useEffect(() => {
    const needThumb = cluster.photos.filter((p) => !p.thumbnail_path);
    if (needThumb.length === 0) return;

    // Start (or restart) the worker so it processes photos without thumbnails.
    void startThumbnailWorker(10).catch(() => {
      /* worker may already be running — that's fine */
    });

    let active = true;

    // Re-check each still-missing photo after every progress tick.
    const refreshMissing = async () => {
      if (!active) return;
      const current = localPhotosRef.current;
      const missing = current.filter((p) => !p.thumbnail_path);
      if (missing.length === 0) return;

      const results = await Promise.allSettled(
        missing.map((p) => getPhotoByPath(p.file_path))
      );
      if (!active) return;

      setLocalPhotos((prev) => {
        const copy = [...prev];
        results.forEach((r, i) => {
          if (r.status === "fulfilled" && r.value?.thumbnail_path) {
            const idx = copy.findIndex((p) => p.id === missing[i].id);
            if (idx !== -1)
              copy[idx] = {
                ...copy[idx],
                thumbnail_path: r.value!.thumbnail_path,
              };
          }
        });
        return copy;
      });
    };

    const unlistenProgress = listen("thumbnail_progress", () => {
      void refreshMissing();
    });
    const unlistenDone = listen("thumbnail_done", () => {
      void refreshMissing();
    });

    return () => {
      active = false;
      void unlistenProgress.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
    };
  }, [cluster.photos]); // eslint-disable-line react-hooks/exhaustive-deps

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
  /** Incremented by the parent whenever trips are added, removed, or edited. */
  tripsVersion?: number;
}

export function MapView({ isActive, tripsVersion }: MapViewProps) {
  const [mapMode, setMapMode] = useState<MapMode>("photos");

  // ── Photos-mode state ─────────────────────────────────────────────────────
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<PhotoCluster | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[] | null>(null);
  const [viewportVersion, setViewportVersion] = useState(0);
  /** Whether the pixel-space collision filter is active. */
  const [useCollisionFilter, setUseCollisionFilter] = useState(false);

  // ── Trips-mode state ──────────────────────────────────────────────────────
  const [tripDataList, setTripDataList] = useState<TripData[]>([]);
  const [loadingTrips, setLoadingTrips] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<TripData | null>(null);
  /**
   * The trip whose individual photo pins are currently shown on the map.
   * Set by clicking a trip polygon; a second click on the same polygon opens
   * the TripDetailPanel (TripBrowser).
   */
  const [focusedTrip, setFocusedTrip] = useState<TripData | null>(null);
  /**
   * The zoom level that was active when a trip was focused.
   * Used to auto-unfocus when the user zooms back out past that level.
   */
  const focusZoomRef = useRef<number | null>(null);
  /**
   * Set to `true` after calling `fitBounds` to focus a trip.
   * The next `zoomend`/`moveend` will record the post-animation zoom into
   * `focusZoomRef` instead of checking the unfocus condition, ensuring the
   * threshold is always based on the actual zoom level reached after the
   * animation rather than the zoom before it started (which can cause
   * immediate unfocus for small trips or when already at a high zoom).
   */
  const pendingFocusZoomRef = useRef(false);
  /** True once trip data has been fetched (avoid re-fetching on tab switch). */
  const tripsLoadedRef = useRef(false);
  /**
   * Incremented to force trips data to re-fetch even while already in trips
   * mode (e.g. after external changes or when the user clicks Refresh).
   */
  const [tripsFetchVersion, setTripsFetchVersion] = useState(0);

  const mapRef = useRef<LeafletMap | null>(null);

  // ── Home location + transitions ───────────────────────────────────────────
  const [homeLocation, setHomeLocation] = useState<HomeLocation | null>(null);
  const [homeTransitions, setHomeTransitions] = useState<HomeTransition[]>([]);
  /** Whether to show home markers at all. */
  const [showHomes, setShowHomes] = useState(true);
  /** When true, only the current home is shown; when false, all homes shown. */
  const [showCurrentHomeOnly, setShowCurrentHomeOnly] = useState(false);

  useEffect(() => {
    getHomeLocation().then(setHomeLocation).catch(() => {});
    listHomeTransitions().then(setHomeTransitions).catch(() => {});
  }, []);

  /** The most-recent confirmed home transition (= current home). */
  const currentHomeTransition = homeTransitions
    .filter((t) => t.is_confirmed)
    .sort((a, b) => b.transition_ts - a.transition_ts)[0] ?? null;

  /**
   * Pan the map to the current home location.
   * Uses the stored homeLocation or falls back to the most-recent transition.
   */
  const handleGoHome = useCallback(() => {
    const target = homeLocation
      ?? (currentHomeTransition
          ? { lat: currentHomeTransition.new_lat, lon: currentHomeTransition.new_lon }
          : null);
    if (!target) return;
    mapRef.current?.flyTo([target.lat, target.lon], 11, { animate: true });
  }, [homeLocation, currentHomeTransition]);

  useEffect(() => {
    if (isActive) mapRef.current?.invalidateSize();
  }, [isActive]);

  // Clear focused trip whenever the user leaves trips mode.
  useEffect(() => {
    if (mapMode !== "trips") {
      setFocusedTrip(null);
      focusZoomRef.current = null;
      pendingFocusZoomRef.current = false;
    }
  }, [mapMode]);

  // ── Invalidate the trips cache whenever the parent signals a change ─────────
  useEffect(() => {
    if (tripsVersion === undefined || tripsVersion === 0) return;
    // Mark data as stale and clear the current display.
    tripsLoadedRef.current = false;
    setTripDataList([]);
    setFocusedTrip(null);
    focusZoomRef.current = null;
    pendingFocusZoomRef.current = false;
    // Immediately trigger a re-fetch (regardless of which mode is active so
    // the data is ready as soon as the user switches to trips mode).
    setTripsFetchVersion((v) => v + 1);
  }, [tripsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Force a manual refresh of all trip data. */
  const handleRefreshTrips = useCallback(() => {
    tripsLoadedRef.current = false;
    setTripDataList([]);
    setFocusedTrip(null);
    focusZoomRef.current = null;
    pendingFocusZoomRef.current = false;
    setTripsFetchVersion((v) => v + 1);
  }, []);

  // ── Load trip data when trips mode is activated or a refresh is requested ──
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
            const hullPts: [number, number][] = geoPhotos.map((p) => [
              p.latitude!,
              p.longitude!,
            ]);
            const hull = convexHull(hullPts);
            // Use the polygon centroid of the convex hull so the pin is
            // equidistant from the hull boundary rather than biased toward
            // densely-photographed corners.
            const [centLat, centLon] = hullCentroid(hull);
            const bounds: TripBounds = {
              minLat: Math.min(...lats),
              maxLat: Math.max(...lats),
              minLon: Math.min(...lons),
              maxLon: Math.max(...lons),
              centLat,
              centLon,
            };

            // Load cover photo thumbnail if the trip has one.
            let coverThumbnailSrc: string | null = null;
            if (trip.cover_photo_id !== null) {
              try {
                const coverPhoto = await getPhotoById(trip.cover_photo_id);
                if (coverPhoto?.thumbnail_path) {
                  coverThumbnailSrc = convertFileSrc(coverPhoto.thumbnail_path);
                }
              } catch {
                // thumbnail missing — fall back to ✈️
              }
            }

            return {
              trip,
              photos: geoPhotos,
              bounds,
              hull,
              color: TRIP_COLORS[idx % TRIP_COLORS.length],
              coverThumbnailSrc,
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
  }, [mapMode, tripsFetchVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewportChange = useCallback(
    async (bounds: LatLngBounds, newZoom: number) => {
      setZoom(newZoom);
      setViewportVersion((v) => v + 1);

      if (pendingFocusZoomRef.current) {
        // The fitBounds animation for a trip focus just completed.  Record the
        // actual post-animation zoom as the unfocus threshold so that the user
        // needs to zoom below this level (not below the pre-animation level) to
        // trigger an auto-unfocus.  This prevents immediately unfocusing small
        // trips when the user was already at a high zoom before clicking.
        focusZoomRef.current = newZoom;
        pendingFocusZoomRef.current = false;
      } else if (
        focusZoomRef.current !== null &&
        newZoom < focusZoomRef.current
      ) {
        // Auto-unfocus a focused trip when the user zooms out past the zoom
        // level that was active when they focused it.
        setFocusedTrip(null);
        focusZoomRef.current = null;
      }

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
    if (!useCollisionFilter || !mapRef.current) return clusters;
    return collisionFilter(clusters, mapRef.current);
  }, [clusters, viewportVersion, useCollisionFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Trip-level clusters — groups nearby trip pins at low zoom levels. */
  const tripClusters = useMemo(
    () => clusterTrips(tripDataList, zoom),
    [tripDataList, zoom]
  );

  /**
   * Photo clusters for the currently focused trip.
   * These are shown in place of bbox/centroid markers whenever a trip is focused.
   */
  const focusedTripClusters = useMemo(
    () => (focusedTrip ? clusterPhotos(focusedTrip.photos, zoom) : null),
    [focusedTrip, zoom]
  );

  const visibleFocusedTripClusters = useMemo(() => {
    if (!focusedTripClusters) return null;
    if (!useCollisionFilter || !mapRef.current) return focusedTripClusters;
    return collisionFilter(focusedTripClusters, mapRef.current);
  }, [focusedTripClusters, viewportVersion, useCollisionFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Click handler for trip polygons.
   *
   * First click on any trip: fit bounds to show the whole polygon comfortably
   * and switch to showing that trip's individual photo pins.
   *
   * Second click on the already-focused trip: open the TripDetailPanel
   * (TripBrowser).
   *
   * For large trips Leaflet will zoom out automatically to fit the polygon;
   * for small trips maxZoom=14 ensures we don't zoom in past street level.
   */
  const handleTripPolygonClick = useCallback(
    (td: TripData) => {
      if (focusedTrip?.trip.id === td.trip.id) {
        // Already focused — open the detail panel.
        setSelectedTrip(td);
      } else {
        // Focus the trip and fit the map to its bounding box.
        // Set the pending flag so handleViewportChange records the
        // post-animation zoom as the unfocus threshold, rather than the
        // pre-animation zoom which can be higher than the destination zoom
        // and causes immediate unfocus on the first scroll.
        pendingFocusZoomRef.current = true;
        setFocusedTrip(td);

        // Guard against a degenerate zero-area bbox (e.g. a single-photo
        // trip where all photos share the same coordinates).  Leaflet's
        // fitBounds behaves erratically on a point-sized bounds, so expand
        // it by a small delta before calling fitBounds.
        const DELTA = 0.001; // ~111 m, invisible at street level
        const minLat = Math.min(td.bounds.minLat, td.bounds.maxLat - DELTA);
        const maxLat = Math.max(td.bounds.maxLat, td.bounds.minLat + DELTA);
        const minLon = Math.min(td.bounds.minLon, td.bounds.maxLon - DELTA);
        const maxLon = Math.max(td.bounds.maxLon, td.bounds.minLon + DELTA);

        mapRef.current?.fitBounds(
          [
            [minLat, minLon],
            [maxLat, maxLon],
          ],
          { padding: [40, 40], maxZoom: 14, animate: true }
        );
      }
    },
    [focusedTrip]
  );

  /**
   * Clicking a multi-trip cluster zooms into the combined bounding box.
   * Clicking a single-trip cluster focuses that trip.
   */
  const handleTripClusterClick = useCallback((tc: TripCluster) => {
    if (tc.trips.length === 1) {
      handleTripPolygonClick(tc.trips[0]);
      return;
    }
    const allLats = tc.trips.flatMap((t) => [t.bounds.minLat, t.bounds.maxLat]);
    const allLons = tc.trips.flatMap((t) => [t.bounds.minLon, t.bounds.maxLon]);
    mapRef.current?.fitBounds(
      [
        [Math.min(...allLats), Math.min(...allLons)],
        [Math.max(...allLats), Math.max(...allLons)],
      ],
      { padding: [40, 40], maxZoom: 13, animate: true }
    );
  }, [handleTripPolygonClick]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Always-focus variant used by the JumpToTrip dropdown.
   *
   * Unlike `handleTripPolygonClick`, a second call never opens the detail
   * panel — it just re-centres the map on the trip.
   */
  const handleFocusTrip = useCallback((td: TripData) => {
    pendingFocusZoomRef.current = true;
    setFocusedTrip(td);
    const DELTA = 0.001;
    const minLat = Math.min(td.bounds.minLat, td.bounds.maxLat - DELTA);
    const maxLat = Math.max(td.bounds.maxLat, td.bounds.minLat + DELTA);
    const minLon = Math.min(td.bounds.minLon, td.bounds.maxLon - DELTA);
    const maxLon = Math.max(td.bounds.maxLon, td.bounds.minLon + DELTA);
    mapRef.current?.fitBounds(
      [[minLat, minLon], [maxLat, maxLon]],
      { padding: [40, 40], maxZoom: 14, animate: true }
    );
  }, []);

  const hasHome = homeLocation !== null || currentHomeTransition !== null;

  return (
    <div className="map-view">
      {/* Mode toggle + home controls + collision filter toggle */}
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
        <div className="map-mode-divider" />
        {/* ── Home controls ── */}
        {hasHome && (
          <>
            <button
              className={`map-mode-btn map-mode-btn--icon${showHomes ? " active" : ""}`}
              onClick={() => setShowHomes((v) => !v)}
              title={showHomes ? "Hide home markers" : "Show home markers"}
              aria-pressed={showHomes}
            >
              🏠
            </button>
            {showHomes && homeTransitions.filter((t) => t.is_confirmed).length > 1 && (
              <button
                className={`map-mode-btn map-mode-btn--icon${showCurrentHomeOnly ? " active" : ""}`}
                onClick={() => setShowCurrentHomeOnly((v) => !v)}
                title={showCurrentHomeOnly ? "Showing current home only — click to show all" : "Showing all homes — click to show current only"}
                aria-pressed={showCurrentHomeOnly}
              >
                1️⃣
              </button>
            )}
            <button
              className="map-mode-btn map-mode-btn--icon"
              onClick={handleGoHome}
              title="Go to current home"
              disabled={!hasHome}
            >
              ⌂
            </button>
            <div className="map-mode-divider" />
          </>
        )}
        <button
          className={`map-mode-btn map-mode-btn--icon${useCollisionFilter ? " active" : ""}`}
          onClick={() => setUseCollisionFilter((v) => !v)}
          title={
            useCollisionFilter
              ? "Collision filter ON — click to disable"
              : "Collision filter OFF — click to enable"
          }
          aria-pressed={useCollisionFilter}
        >
          ⊙
        </button>
        <button
          className="map-mode-btn map-mode-btn--icon"
          onClick={() => {
            if (mapMode === "trips") {
              handleRefreshTrips();
            } else {
              // Photos mode: re-trigger viewport query by bumping the version.
              setViewportVersion((v) => v + 1);
              if (mapRef.current) {
                const b = mapRef.current.getBounds();
                void handleViewportChange(b, mapRef.current.getZoom());
              }
            }
          }}
          title="Refresh map data"
          disabled={loading || loadingTrips}
        >
          🔄
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
        {!loading && !loadingTrips && !error && mapMode === "trips" && focusedTrip && (
          <span className="map-status-focused-trip">
            <span
              className="map-status-focused-dot"
              style={{ background: focusedTrip.color }}
            />
            {focusedTrip.trip.name}
            <button
              className="map-status-focused-clear"
              onClick={() => {
                setFocusedTrip(null);
                focusZoomRef.current = null;
                pendingFocusZoomRef.current = false;
              }}
              title="Clear focus"
            >
              ✕
            </button>
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
        zoomControl={false}
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
          tripDataList.map((td) => {
            const isFocused = focusedTrip?.trip.id === td.trip.id;
            // When a trip is focused, hide all other trip polygons.
            if (focusedTrip && !isFocused) return null;
            return (
              <Polygon
                key={td.trip.id}
                positions={td.hull}
                pathOptions={{
                  color: td.color,
                  fillColor: td.color,
                  fillOpacity: isFocused ? 0.22 : 0.13,
                  weight: isFocused ? 3 : 2.5,
                  opacity: isFocused ? 1 : 0.75,
                }}
                eventHandlers={{ click: () => handleTripPolygonClick(td) }}
              >
                <Tooltip sticky>{td.trip.name}</Tooltip>
              </Polygon>
            );
          })}

        {/* Trip centroid markers (low zoom) — hidden when a trip is focused */}
        {mapMode === "trips" &&
          !focusedTrip &&
          zoom < TRIP_DETAIL_ZOOM &&
          tripClusters.map((tc) => (
            <Marker
              key={tc.key}
              position={[tc.lat, tc.lon]}
              icon={tc.trips.length === 1 ? makeTripIcon(tc.trips[0]) : makeTripClusterIcon(tc)}
              eventHandlers={{ click: () => handleTripClusterClick(tc) }}
            />
          ))}

        {/* Focused trip: individual photo pins (always shown regardless of zoom) */}
        {mapMode === "trips" &&
          focusedTrip &&
          visibleFocusedTripClusters?.map((cluster) => {
            const icon = makeClusterIcon(cluster);
            const isCluster = cluster.photos.length > 1;
            return (
              <Marker
                key={`focused-${cluster.key}`}
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

        {/* Individual photo markers at high zoom when no trip is focused */}
        {mapMode === "trips" &&
          !focusedTrip &&
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
          <JumpToTrip tripDataList={tripDataList} onSelect={handleFocusTrip} />
        )}

        {/* ── Home markers ─────────────────────────────────────────────────── */}
        {/* Confirmed home transition markers */}
        {showHomes &&
          homeTransitions
            .filter((t) => t.is_confirmed)
            .filter((t, _i, arr) => {
              if (!showCurrentHomeOnly) return true;
              // Only the most-recent confirmed transition
              const latest = arr.reduce((best, c) =>
                c.transition_ts > best.transition_ts ? c : best
              );
              return t.id === latest.id;
            })
            .map((t) => {
              const isLatest =
                t.id === currentHomeTransition?.id;
              const dateStr = new Date(t.transition_ts * 1000).toLocaleDateString(
                undefined,
                { year: "numeric", month: "short", timeZone: "UTC" }
              );
              return (
                <Marker
                  key={`home-t-${t.id}`}
                  position={[t.new_lat, t.new_lon]}
                  icon={makeHomeMarkerIcon(isLatest)}
                  zIndexOffset={isLatest ? 1200 : 900}
                >
                  <Tooltip permanent={false} direction="top" offset={[0, -44]}>
                    {isLatest ? "Current home" : `Former home (since ${dateStr})`}
                  </Tooltip>
                </Marker>
              );
            })}

        {/* Fallback: plain homeLocation with no transition history */}
        {showHomes &&
          homeLocation &&
          homeTransitions.filter((t) => t.is_confirmed).length === 0 && (
            <Marker
              position={[homeLocation.lat, homeLocation.lon]}
              icon={makeHomeMarkerIcon(true)}
              zIndexOffset={1200}
            >
              <Tooltip permanent={false} direction="top" offset={[0, -44]}>
                Home
              </Tooltip>
            </Marker>
          )}

        {/* Zoom slider — replaces the default Leaflet zoom control */}
        <ZoomSlider />
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

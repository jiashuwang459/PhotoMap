import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Map as LeafletMap, LatLngBounds } from "leaflet";
import { queryByBoundingBox } from "../api/photos";
import type { BoundingBox, Page, Photo } from "../api/types";

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

// ── Clustering ───────────────────────────────────────────────────────────────

/** A group of spatially-nearby photos rendered as a single map marker. */
interface PhotoCluster {
  /** Stable key derived from the clustering grid cell. */
  key: string;
  /** Average latitude of all photos in the cluster. */
  lat: number;
  /** Average longitude of all photos in the cluster. */
  lon: number;
  photos: Photo[];
}

/**
 * Returns the grid-cell width in degrees for the given Leaflet zoom level.
 * Larger values = coarser clustering at low zoom; finer at high zoom.
 */
function zoomToCellDeg(zoom: number): number {
  if (zoom >= 15) return 0.005;
  if (zoom >= 13) return 0.02;
  if (zoom >= 11) return 0.08;
  if (zoom >= 8) return 0.5;
  if (zoom >= 5) return 3;
  return 15;
}

/**
 * Cluster `photos` into a grid whose cell size depends on `zoom`.
 * Each cell produces one {@link PhotoCluster} positioned at the centroid of
 * its members.
 */
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

/** Screen-space bounding rectangle (in container pixels). */
interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Returns true when two icon rectangles overlap after applying padding. */
function rectsOverlap(a: PixelRect, b: PixelRect): boolean {
  return !(
    a.x + a.w + COLLISION_PAD < b.x - COLLISION_PAD ||
    b.x + b.w + COLLISION_PAD < a.x - COLLISION_PAD ||
    a.y + a.h + COLLISION_PAD < b.y - COLLISION_PAD ||
    b.y + b.h + COLLISION_PAD < a.y - COLLISION_PAD
  );
}

/** Returns the [width, height] of the icon Leaflet will render for `cluster`. */
function iconDims(cluster: PhotoCluster): [number, number] {
  const hasThumb = cluster.photos.some((p) => p.thumbnail_path);
  if (!hasThumb && cluster.photos.length === 1) return [36, 36 + ARROW_H];
  return [THUMB_SIZE, THUMB_SIZE + ARROW_H];
}

/**
 * Filters `clusters` so that no two rendered icons overlap in screen space.
 *
 * Algorithm (inspired by Leaflet.LayerGroup.Collision):
 * 1. Sort by descending photo count so larger clusters have the highest
 *    priority and are always shown first.
 * 2. Project each cluster centroid to a container-pixel rect using the map's
 *    current affine projection.
 * 3. Accept the cluster only if its rect does not collide with any
 *    already-accepted rect.
 */
function collisionFilter(
  clusters: PhotoCluster[],
  map: LeafletMap
): PhotoCluster[] {
  const sorted = [...clusters].sort((a, b) => {
    if (b.photos.length !== a.photos.length)
      return b.photos.length - a.photos.length;
    // Secondary: prefer clusters that have a thumbnail (larger visual footprint).
    const aT = a.photos.some((p) => p.thumbnail_path) ? 1 : 0;
    const bT = b.photos.some((p) => p.thumbnail_path) ? 1 : 0;
    return bT - aT;
  });

  const placed: PixelRect[] = [];
  const visible: PhotoCluster[] = [];

  for (const cluster of sorted) {
    const pt = map.latLngToContainerPoint([cluster.lat, cluster.lon]);
    const [w, h] = iconDims(cluster);
    // Icon anchor is at bottom-centre, so the rect extends upward by h and
    // left/right by w/2 from the projected point.
    const rect: PixelRect = { x: pt.x - w / 2, y: pt.y - h, w, h };

    if (!placed.some((p) => rectsOverlap(p, rect))) {
      placed.push(rect);
      visible.push(cluster);
    }
  }

  return visible;
}

// ── Custom Leaflet DivIcon markers ───────────────────────────────────────────

/**
 * Build a Leaflet `DivIcon` for the given cluster.
 *
 * - **Single photo with thumbnail**: `THUMB_SIZE`×`THUMB_SIZE` tile with a
 *   downward arrow tip.
 * - **Single photo without thumbnail**: compact camera-icon circle with arrow.
 * - **Cluster (>1 photo)**: thumbnail of the lead photo plus a count badge.
 */
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

// ── ViewportTracker ───────────────────────────────────────────────────────────

interface ViewportTrackerProps {
  onViewportChange: (bounds: LatLngBounds, zoom: number) => void;
}

/**
 * Invisible component that lives inside `MapContainer` and fires
 * `onViewportChange` whenever the user pans or zooms.
 */
function ViewportTracker({ onViewportChange }: ViewportTrackerProps) {
  const map = useMapEvents({
    moveend() {
      onViewportChange(map.getBounds(), map.getZoom());
    },
    zoomend() {
      onViewportChange(map.getBounds(), map.getZoom());
    },
  });

  // Fire once immediately so the initial viewport is populated.
  useEffect(() => {
    onViewportChange(map.getBounds(), map.getZoom());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ── PhotoViewer ───────────────────────────────────────────────────────────────

interface PhotoViewerProps {
  /** Photos to display.  Single-element array when opened from a lone marker. */
  photos: Photo[];
  /** Index of the photo to show first. */
  initialIndex: number;
  onClose: () => void;
}

/**
 * Full-screen photo viewer rendered via a React portal above all other UI.
 *
 * Always displays the **original file** (not the thumbnail).
 * Supports keyboard navigation (ArrowLeft / ArrowRight / Escape) and
 * prev/next buttons when `photos` contains more than one entry.
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

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <div className="photo-viewer-overlay" onClick={onClose}>
      <div className="photo-viewer" onClick={stopPropagation}>
        <button
          className="photo-viewer-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>

        <div className="photo-viewer-body">
          {n > 1 && (
            <button
              className="photo-viewer-prev"
              onClick={() => setIndex((i) => (i - 1 + n) % n)}
              aria-label="Previous photo"
            >
              ‹
            </button>
          )}

          <div className="photo-viewer-media">
            <img
              src={convertFileSrc(photo.file_path)}
              className="photo-viewer-img"
              alt={basename(photo.file_path)}
            />
          </div>

          {n > 1 && (
            <button
              className="photo-viewer-next"
              onClick={() => setIndex((i) => (i + 1) % n)}
              aria-label="Next photo"
            >
              ›
            </button>
          )}
        </div>

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
          {n > 1 && (
            <span className="photo-viewer-counter">
              {index + 1} / {n}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── ClusterBrowser ─────────────────────────────────────────────────────────────

interface ClusterBrowserProps {
  cluster: PhotoCluster;
  onClose: () => void;
}

/**
 * Centered modal showing a scrollable thumbnail grid for every photo in a
 * cluster.  Clicking any cell opens {@link PhotoViewer} for the original file.
 *
 * Rendered via a React portal so it sits above the map layer.
 */
function ClusterBrowser({ cluster, onClose }: ClusterBrowserProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const n = cluster.photos.length;

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
            {cluster.photos.map((photo, index) => (
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
          photos={cluster.photos}
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
  /** True when this tab panel is the currently visible tab. */
  isActive: boolean;
}

export function MapView({ isActive }: MapViewProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<PhotoCluster | null>(
    null
  );
  /** Photos to show in the single-marker photo viewer. */
  const [viewerPhotos, setViewerPhotos] = useState<Photo[] | null>(null);
  /**
   * Incremented on every pan/zoom so that `visibleClusters` recomputes even
   * when the photo set hasn't changed (pixel positions shift on pan).
   */
  const [viewportVersion, setViewportVersion] = useState(0);
  const mapRef = useRef<LeafletMap | null>(null);

  // Leaflet measures the container on init; if the panel is hidden (display:none)
  // at that point the map size is 0×0 and tiles never load.  Call invalidateSize()
  // whenever the tab becomes active so Leaflet recalculates and renders correctly.
  useEffect(() => {
    if (isActive) {
      mapRef.current?.invalidateSize();
    }
  }, [isActive]);

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

  /** Re-cluster whenever the photo list or zoom level changes. */
  const clusters = useMemo(
    () => clusterPhotos(photos, zoom),
    [photos, zoom]
  );

  /**
   * Apply pixel-space collision filtering after grid clustering so that
   * overlapping pins are suppressed.  Larger clusters always win.
   *
   * Re-runs on every pan/zoom via `viewportVersion` — even if `clusters`
   * didn't change, pixel positions shift whenever the map moves.
   */
  const visibleClusters = useMemo(() => {
    if (!mapRef.current) return clusters;
    return collisionFilter(clusters, mapRef.current);
    // viewportVersion is intentionally included; mapRef.current is stable.
  }, [clusters, viewportVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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

        <ViewportTracker onViewportChange={handleViewportChange} />

        {visibleClusters.map((cluster) => {
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
    </div>
  );
}

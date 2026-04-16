import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMapEvents,
} from "react-leaflet";
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

// ── Custom Leaflet DivIcon markers ───────────────────────────────────────────

/**
 * Build a Leaflet `DivIcon` for the given cluster.
 *
 * - **Single photo with thumbnail**: 52×52 thumbnail tile with a downward
 *   arrow tip, rounded with drop shadow — similar to Apple Maps photo markers.
 * - **Single photo without thumbnail**: compact camera-icon circle with arrow.
 * - **Cluster (>1 photo)**: thumbnail of the first photo that has one, plus
 *   a count badge in the top-right corner, with an arrow tip.
 *
 * All markers are 10 px taller than their visible tile to accommodate the CSS
 * arrow rendered via `.photo-map-marker::after`.
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
        // Extra 10 px height for the CSS arrow rendered via ::after.
        iconSize: [52, 62],
        iconAnchor: [26, 62],
        popupAnchor: [0, -66],
      });
    }
    return L.divIcon({
      className: "photo-map-marker photo-map-marker--no-thumb",
      html: `<span class="photo-map-fallback">📷</span>`,
      iconSize: [36, 46],
      iconAnchor: [18, 46],
      popupAnchor: [0, -50],
    });
  }

  // Cluster badge
  const countLabel = count > 99 ? "99+" : String(count);
  const thumbHtml = lead?.thumbnail_path
    ? `<img src="${convertFileSrc(lead.thumbnail_path)}" class="photo-map-img" alt="" />`
    : `<span class="photo-map-fallback">📷</span>`;

  return L.divIcon({
    className: "photo-map-marker photo-map-cluster",
    html: `${thumbHtml}<span class="photo-map-count">${countLabel}</span>`,
    iconSize: [52, 62],
    iconAnchor: [26, 62],
    popupAnchor: [0, -66],
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

// ── Popup content ─────────────────────────────────────────────────────────────

function PhotoPopup({ photo }: { photo: Photo }) {
  const lat = photo.latitude as number;
  const lon = photo.longitude as number;
  return (
    <div className="map-popup">
      {photo.thumbnail_path && (
        <img
          src={convertFileSrc(photo.thumbnail_path)}
          className="map-popup-thumb"
          alt=""
        />
      )}
      <strong className="map-popup-name">{basename(photo.file_path)}</strong>
      <span className="map-popup-date">{fmtDate(photo.timestamp)}</span>
      <span className="map-popup-gps">
        {lat.toFixed(5)}°, {lon.toFixed(5)}°
      </span>
    </div>
  );
}

// ── ClusterBrowser ─────────────────────────────────────────────────────────────

interface ClusterBrowserProps {
  cluster: PhotoCluster;
  onClose: () => void;
}

/**
 * Modal that lets the user browse all photos in a cluster.
 *
 * - **Grid view**: scrollable thumbnail grid, one card per photo.
 * - **Lightbox**: click any card to open a full-size view with ‹ / › navigation
 *   and Escape / arrow-key keyboard support.
 *
 * Rendered into `document.body` via a React portal so it sits above the map.
 */
function ClusterBrowser({ cluster, onClose }: ClusterBrowserProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const n = cluster.photos.length;

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxIndex !== null) setLightboxIndex(null);
        else onClose();
      } else if (lightboxIndex !== null) {
        if (e.key === "ArrowLeft")
          setLightboxIndex((i) => (i !== null ? (i - 1 + n) % n : null));
        else if (e.key === "ArrowRight")
          setLightboxIndex((i) => (i !== null ? (i + 1) % n : null));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxIndex, onClose, n]);

  const lightboxPhoto =
    lightboxIndex !== null ? cluster.photos[lightboxIndex] : null;

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <>
      {/* Grid browser overlay */}
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
                onClick={() => setLightboxIndex(index)}
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
                <span className="cluster-browser-caption">
                  {basename(photo.file_path)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Lightbox — rendered on top of the grid */}
      {lightboxPhoto !== null && lightboxIndex !== null && (
        <div
          className="cluster-lightbox-overlay"
          onClick={() => setLightboxIndex(null)}
        >
          <div className="cluster-lightbox" onClick={stopPropagation}>
            <button
              className="cluster-lightbox-close"
              onClick={() => setLightboxIndex(null)}
              aria-label="Back to grid"
            >
              ✕
            </button>

            <div className="cluster-lightbox-body">
              <button
                className="cluster-lightbox-prev"
                onClick={() =>
                  setLightboxIndex((i) => (i !== null ? (i - 1 + n) % n : null))
                }
                aria-label="Previous photo"
              >
                ‹
              </button>

              <div className="cluster-lightbox-media">
                {lightboxPhoto.thumbnail_path ? (
                  <img
                    src={convertFileSrc(lightboxPhoto.thumbnail_path)}
                    className="cluster-lightbox-img"
                    alt={basename(lightboxPhoto.file_path)}
                  />
                ) : (
                  <div className="cluster-lightbox-no-thumb">📷</div>
                )}
              </div>

              <button
                className="cluster-lightbox-next"
                onClick={() =>
                  setLightboxIndex((i) => (i !== null ? (i + 1) % n : null))
                }
                aria-label="Next photo"
              >
                ›
              </button>
            </div>

            <div className="cluster-lightbox-info">
              <strong className="cluster-lightbox-name">
                {basename(lightboxPhoto.file_path)}
              </strong>
              <span className="cluster-lightbox-date">
                {fmtDate(lightboxPhoto.timestamp)}
              </span>
              {lightboxPhoto.latitude != null &&
                lightboxPhoto.longitude != null && (
                  <span className="cluster-lightbox-gps">
                    {(lightboxPhoto.latitude as number).toFixed(5)}°,{" "}
                    {(lightboxPhoto.longitude as number).toFixed(5)}°
                  </span>
                )}
              <span className="cluster-lightbox-counter">
                {lightboxIndex + 1} / {n}
              </span>
            </div>
          </div>
        </div>
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

        {clusters.map((cluster) => {
          const icon = makeClusterIcon(cluster);
          const isCluster = cluster.photos.length > 1;
          return (
            <Marker
              key={cluster.key}
              position={[cluster.lat, cluster.lon]}
              icon={icon}
              eventHandlers={
                isCluster
                  ? { click: () => setSelectedCluster(cluster) }
                  : undefined
              }
            >
              {!isCluster && (
                <Popup>
                  <PhotoPopup photo={cluster.photos[0]} />
                </Popup>
              )}
            </Marker>
          );
        })}
      </MapContainer>

      {selectedCluster && (
        <ClusterBrowser
          cluster={selectedCluster}
          onClose={() => setSelectedCluster(null)}
        />
      )}
    </div>
  );
}

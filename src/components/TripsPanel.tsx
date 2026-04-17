import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  autoGroupTrips,
  confirmTrip,
  createTrip,
  deleteAllSuggestedTrips,
  deleteTrip,
  detectHomeTransitions,
  confirmHomeTransition,
  dismissHomeTransition,
  getHomeLocation,
  getTrip,
  inferHomeLocation,
  listTrips,
  queryPhotosByTrip,
  queryUntrippedPhotos,
  renameTrip,
  setPhotoTrip,
  suggestPhotosForTrips,
} from "../api/photos";
import { PhotoCard } from "./PhotoCard";
import type { HomeLocation, HomeTransition, Page, Photo, Trip, TripGroupResult, TripPhotoSuggestion } from "../api/types";

// ── constants ─────────────────────────────────────────────────────────────────

/** 3 days — gap threshold default matching the new Rust default. */
const DEFAULT_GAP_DAYS = 3;
/** Default minimum distance from home (km) for a cluster to be a trip. */
const DEFAULT_MIN_TRIP_KM = 50;
const PAGE_SIZE = 50;

// Rate-limit for Nominatim: 1 request per second per ToS.
// Using 1100ms provides a safety margin above the 1000ms minimum to
// account for request processing time and network latency.
const NOMINATIM_DELAY_MS = 1100;

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts: number | null): string {
  if (ts === null) return "—";
  // Timestamps are stored as "camera local time treated as UTC", so display
  // in UTC to recover the original camera clock reading.
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtDateRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return "No dates";
  if (start === null) return fmtDate(end);
  if (end === null || start === end) return fmtDate(start);
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

// ── AddPhotosDrawer — pick untripped photos to add to a trip ──────────────────

interface AddPhotosDrawerProps {
  tripId: number;
  onAdded: () => void;
  onClose: () => void;
}

function AddPhotosDrawer({ tripId, onAdded, onClose }: AddPhotosDrawerProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (pageOffset: number, existing: Photo[]) => {
    setLoading(true);
    setError(null);
    try {
      const page: Page = { limit: PAGE_SIZE, offset: pageOffset };
      const results = await queryUntrippedPhotos(page);
      setPhotos([...existing, ...results]);
      setOffset(pageOffset + results.length);
      setHasMore(results.length === PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(0, []);
  }, [loadPage]);

  async function handleAdd(photoId: number) {
    try {
      await setPhotoTrip(photoId, tripId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      onAdded();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="add-photos-drawer">
      <div className="add-photos-header">
        <h3>Add photos to trip</h3>
        <button className="btn-ghost" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      {error && (
        <p className="trips-error" role="alert">
          {error}
        </p>
      )}

      {!loading && photos.length === 0 && !error && (
        <p className="trips-empty">
          No un-grouped photos available. All photos are already in a trip.
        </p>
      )}

      <div className="add-photos-list">
        {photos.map((p) => (
          <div key={p.id} className="add-photos-row">
            <div className="add-photos-card">
              <PhotoCard photo={p} />
            </div>
            <button
              className="btn-outline add-photos-add-btn"
              onClick={() => handleAdd(p.id)}
            >
              + Add
            </button>
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="trips-load-more">
          <button
            className="btn-outline"
            onClick={() => loadPage(offset, photos)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && photos.length === 0 && (
        <p className="trips-loading">Loading photos…</p>
      )}
    </div>
  );
}

// ── TripDetail — photos inside a single trip ──────────────────────────────────

type TripDetailView = "grid" | "list";

interface TripDetailProps {
  trip: Trip;
  onBack: () => void;
  onDeleted: () => void;
  onTripChanged: (updatedTrip: Trip) => void;
}

function TripDetail({ trip, onBack, onDeleted, onTripChanged }: TripDetailProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showAddPhotos, setShowAddPhotos] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(trip.name);
  const [geocoding, setGeocoding] = useState(false);
  const [viewMode, setViewMode] = useState<TripDetailView>("grid");
  const [savingName, setSavingName] = useState(false);

  const loadPage = useCallback(
    async (pageOffset: number, existing: Photo[]) => {
      setLoading(true);
      setError(null);
      try {
        const page: Page = { limit: PAGE_SIZE, offset: pageOffset };
        const results = await queryPhotosByTrip(trip.id, page);
        setPhotos([...existing, ...results]);
        setOffset(pageOffset + results.length);
        setHasMore(results.length === PAGE_SIZE);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [trip.id]
  );

  useEffect(() => {
    setPhotos([]);
    setOffset(0);
    loadPage(0, []);
    setNameInput(trip.name);
  }, [loadPage, trip.name]);

  async function handleDelete() {
    if (
      !confirm(
        `Delete trip "${trip.name}"?\nPhotos will not be removed from the library.`
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await deleteTrip(trip.id);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    try {
      await confirmTrip(trip.id);
      onTripChanged({ ...trip, is_confirmed: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setConfirming(false);
    }
  }

  async function handleRemovePhoto(photoId: number) {
    try {
      await setPhotoTrip(photoId, null);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      // Refresh trip metadata (dates, photo count) from the DB.
      const updated = await getTrip(trip.id);
      if (updated) onTripChanged(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === trip.name) {
      setEditingName(false);
      setNameInput(trip.name);
      return;
    }
    setSavingName(true);
    try {
      await renameTrip(trip.id, trimmed);
      onTripChanged({ ...trip, name: trimmed });
      setEditingName(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingName(false);
    }
  }

  async function handleGeocode() {
    const geoPhotos = photos.filter(
      (p) => p.latitude !== null && p.longitude !== null
    );
    if (geoPhotos.length === 0) {
      setError("No geotagged photos in this trip to geocode from.");
      return;
    }
    const centLat =
      geoPhotos.reduce((s, p) => s + p.latitude!, 0) / geoPhotos.length;
    const centLon =
      geoPhotos.reduce((s, p) => s + p.longitude!, 0) / geoPhotos.length;
    setGeocoding(true);
    setError(null);
    try {
      const location = await reverseGeocode(centLat, centLon);
      if (!location) {
        setError("Could not determine a location name for this trip.");
        return;
      }
      await renameTrip(trip.id, location);
      setNameInput(location);
      onTripChanged({ ...trip, name: location });
    } catch (e) {
      setError(String(e));
    } finally {
      setGeocoding(false);
    }
  }

  const currentTrip = trip;

  return (
    <div className="trip-detail">
      {/* ── Header ── */}
      <div className="trip-detail-header">
        <button className="btn-ghost" onClick={onBack}>
          ← Back
        </button>

        <div className="trip-detail-title">
          {editingName ? (
            <div className="trip-rename-row">
              <input
                className="trip-rename-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveName();
                  if (e.key === "Escape") {
                    setEditingName(false);
                    setNameInput(trip.name);
                  }
                }}
                autoFocus
                disabled={savingName}
              />
              <button
                className="btn-primary"
                onClick={handleSaveName}
                disabled={savingName}
              >
                {savingName ? "Saving…" : "Save"}
              </button>
              <button
                className="btn-ghost"
                onClick={() => {
                  setEditingName(false);
                  setNameInput(trip.name);
                }}
                disabled={savingName}
              >
                Cancel
              </button>
            </div>
          ) : (
            <h2>
              {currentTrip.name}
              <button
                className="btn-ghost trip-rename-btn"
                onClick={() => setEditingName(true)}
                title="Rename trip"
              >
                ✏️
              </button>
            </h2>
          )}
          <span className="trip-detail-meta">
            {fmtDateRange(currentTrip.start_ts, currentTrip.end_ts)}
            &nbsp;·&nbsp;
            {photos.length} photo{photos.length !== 1 ? "s" : ""}
            {!currentTrip.is_confirmed && (
              <span className="trip-suggested-badge">Suggested</span>
            )}
          </span>
        </div>

        <div className="trip-detail-actions">
          {!currentTrip.is_confirmed && (
            <>
              <button
                className="btn-primary"
                onClick={handleConfirm}
                disabled={confirming || deleting}
              >
                {confirming ? "Accepting…" : "✓ Accept trip"}
              </button>
              <button
                className="btn-danger"
                onClick={handleDelete}
                disabled={deleting || confirming}
              >
                {deleting ? "Dismissing…" : "✕ Dismiss"}
              </button>
            </>
          )}
          {currentTrip.is_confirmed && (
            <button
              className="btn-danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete trip"}
            </button>
          )}
          <button
            className="btn-outline"
            onClick={() => setShowAddPhotos((v) => !v)}
          >
            {showAddPhotos ? "Close picker" : "+ Add photos"}
          </button>
          <button
            className="btn-outline"
            onClick={handleGeocode}
            disabled={geocoding || photos.filter((p) => p.latitude !== null).length === 0}
            title="Reverse-geocode this trip's centroid and rename it"
          >
            {geocoding ? "Geocoding…" : "📍 Geocode"}
          </button>
        </div>
      </div>

      {error && (
        <p className="trips-error" role="alert">
          {error}
        </p>
      )}

      {/* ── Add-photos drawer ── */}
      {showAddPhotos && (
        <AddPhotosDrawer
          tripId={trip.id}
          onAdded={async () => {
            setPhotos([]);
            setOffset(0);
            loadPage(0, []);
            // Refresh trip metadata (dates, photo count) from the DB.
            const updated = await getTrip(trip.id);
            if (updated) onTripChanged(updated);
          }}
          onClose={() => setShowAddPhotos(false)}
        />
      )}

      {photos.length === 0 && !loading && !error && (
        <p className="trips-empty">No photos in this trip yet.</p>
      )}

      {/* ── View mode toggle ── */}
      {photos.length > 0 && (
        <div className="trip-view-toggle">
          <button
            className={`trip-view-btn${viewMode === "grid" ? " trip-view-btn--active" : ""}`}
            onClick={() => setViewMode("grid")}
            title="Grid view"
            aria-pressed={viewMode === "grid"}
          >
            ⊞ Grid
          </button>
          <button
            className={`trip-view-btn${viewMode === "list" ? " trip-view-btn--active" : ""}`}
            onClick={() => setViewMode("list")}
            title="List view"
            aria-pressed={viewMode === "list"}
          >
            ☰ List
          </button>
        </div>
      )}

      {/* ── Grid view ── */}
      {viewMode === "grid" && (
        <div className="photo-grid trip-photo-grid">
          {photos.map((p) => (
            <div key={p.id} className="trip-photo-item">
              <PhotoCard photo={p} />
              <button
                className="trip-photo-remove"
                onClick={() => handleRemovePhoto(p.id)}
                title="Remove from trip"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── List view ── */}
      {viewMode === "list" && (
        <div className="trip-photo-list">
          {photos.map((p) => (
            <div key={p.id} className="trip-photo-list-row">
              <div className="trip-photo-list-thumb">
                {p.thumbnail_path ? (
                  <img
                    src={convertFileSrc(p.thumbnail_path)}
                    alt=""
                    className="trip-photo-list-img"
                  />
                ) : (
                  <span className="trip-photo-list-icon">🖼</span>
                )}
              </div>
              <div className="trip-photo-list-info">
                <span className="trip-photo-list-name">
                  {p.file_path.split(/[\\/]/).pop() ?? p.file_path}
                </span>
                <span className="trip-photo-list-date">
                  {p.timestamp !== null
                    ? new Date(p.timestamp * 1000).toLocaleString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "UTC",
                      })
                    : "No date"}
                </span>
                {p.latitude !== null && p.longitude !== null && (
                  <span className="trip-photo-list-gps">
                    📍 {p.latitude.toFixed(4)}°, {p.longitude.toFixed(4)}°
                  </span>
                )}
              </div>
              <button
                className="btn-ghost trip-photo-list-remove"
                onClick={() => handleRemovePhoto(p.id)}
                title="Remove from trip"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {hasMore && (
        <div className="trips-load-more">
          <button
            className="btn-outline"
            onClick={() => loadPage(offset, photos)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && photos.length === 0 && (
        <p className="trips-loading">Loading photos…</p>
      )}
    </div>
  );
}

// ── TripCard — summary card for a single trip ─────────────────────────────────

interface TripCardProps {
  trip: Trip;
  onSelect: (trip: Trip) => void;
  onDismiss?: (trip: Trip) => void;
}

function TripCard({ trip, onSelect, onDismiss }: TripCardProps) {
  return (
    <div className="trip-card-wrapper">
      <button className="trip-card" onClick={() => onSelect(trip)}>
        <span className="trip-card-icon" aria-hidden="true">
          🗺️
        </span>
        <div className="trip-card-body">
          <div className="trip-card-name-row">
            <span className="trip-card-name">{trip.name}</span>
            {!trip.is_confirmed && (
              <span className="trip-suggested-badge trip-suggested-badge--sm">
                Suggested
              </span>
            )}
          </div>
          <span className="trip-card-dates">
            {fmtDateRange(trip.start_ts, trip.end_ts)}
          </span>
          <span className="trip-card-count">
            {trip.photo_count} photo{trip.photo_count !== 1 ? "s" : ""}
          </span>
        </div>
        <span className="trip-card-arrow" aria-hidden="true">
          ›
        </span>
      </button>
      {onDismiss && (
        <button
          className="trip-card-dismiss"
          title="Dismiss suggestion"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(trip);
          }}
          aria-label={`Dismiss suggestion "${trip.name}"`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── TripsPanel — main panel ───────────────────────────────────────────────────

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reverse-geocode a single (lat, lon) pair via Nominatim and return a
 * human-readable location label (e.g. "Tokyo" or "Paris, Île-de-France").
 * Returns `null` on any failure so callers can fall back to a date name.
 */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en", "User-Agent": "PhotoMap/0.1" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      address?: {
        city?: string;
        town?: string;
        village?: string;
        county?: string;
        state?: string;
        country?: string;
      };
    };
    const a = data.address ?? {};
    const place = a.city ?? a.town ?? a.village ?? a.county;
    const region = a.state ?? a.country;
    if (place && region) return `${place}, ${region}`;
    if (place) return place;
    if (region) return region;
    return null;
  } catch {
    return null;
  }
}

export function TripsPanel({ onTripsChanged }: { onTripsChanged?: () => void }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [geocodingStatus, setGeocodingStatus] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);

  // Auto-group parameter state
  const [gapDays, setGapDays] = useState(DEFAULT_GAP_DAYS);
  const [minTripKm, setMinTripKm] = useState(DEFAULT_MIN_TRIP_KM);
  const [showGroupParams, setShowGroupParams] = useState(false);

  // Home location state
  const [homeLocation, setHomeLocation] = useState<HomeLocation | null>(null);
  const [inferringHome, setInferringHome] = useState(false);

  // Move events (home transitions) state
  const [transitions, setTransitions] = useState<HomeTransition[]>([]);
  const [detectingMoves, setDetectingMoves] = useState(false);
  const [showMoveEvents, setShowMoveEvents] = useState(false);

  // New-trip form state
  const [showNewTripForm, setShowNewTripForm] = useState(false);
  const [newTripName, setNewTripName] = useState("");
  const [creatingTrip, setCreatingTrip] = useState(false);

  // Photo suggestions state
  const [suggestions, setSuggestions] = useState<TripPhotoSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Keep a stable ref to loadPage so handleAutoGroup can call it after state
  // updates without causing stale-closure issues.
  const loadPageRef = useRef<(pageOffset: number, existing: Trip[]) => Promise<void>>();

  // Abort flag: set to true when the user clears suggestions mid-geocoding.
  const geocodingAbortRef = useRef(false);

  const loadPage = useCallback(async (pageOffset: number, existing: Trip[]) => {
    setLoading(true);
    setError(null);
    try {
      const page: Page = { limit: PAGE_SIZE, offset: pageOffset };
      const results = await listTrips(page);
      setTrips([...existing, ...results]);
      setOffset(pageOffset + results.length);
      setHasMore(results.length === PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  loadPageRef.current = loadPage;

  useEffect(() => {
    loadPage(0, []);
    // Load the stored home location on mount.
    getHomeLocation().then(setHomeLocation).catch(() => {});
  }, [loadPage]);

  async function handleInferHome() {
    setInferringHome(true);
    setError(null);
    try {
      const result = await inferHomeLocation();
      setHomeLocation(result);
      if (!result) {
        setError("Not enough GPS-tagged photos to infer a home location (need at least 5).");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setInferringHome(false);
    }
  }

  async function handleDetectMoves() {
    setDetectingMoves(true);
    setError(null);
    try {
      const result = await detectHomeTransitions();
      setTransitions(result);
      setShowMoveEvents(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setDetectingMoves(false);
    }
  }

  async function handleConfirmTransition(id: number) {
    try {
      await confirmHomeTransition(id);
      setTransitions((prev) =>
        prev.map((t) => (t.id === id ? { ...t, is_confirmed: true } : t))
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDismissTransition(id: number) {
    try {
      await dismissHomeTransition(id);
      setTransitions((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleAutoGroup() {
    setGrouping(true);
    setGeocodingStatus(null);
    setError(null);
    geocodingAbortRef.current = false;
    let results: TripGroupResult[] = [];
    try {
      results = await autoGroupTrips(gapDays * 24 * 3600, minTripKm);
      setTrips([]);
      setOffset(0);
      await loadPageRef.current!(0, []);
    } catch (e) {
      setError(String(e));
      setGrouping(false);
      return;
    }

    setGrouping(false);

    // ── Location-based naming via Nominatim ────────────────────────────────
    // Only geocode trips that have a centroid; rate-limit to ≤ 1 req/s.
    const withGps = results.filter(
      (r) => r.centroid_lat !== null && r.centroid_lon !== null
    );
    if (withGps.length === 0) return;

    setGeocodingStatus(`Geocoding 0 / ${withGps.length}…`);
    let done = 0;
    for (const result of withGps) {
      // Stop geocoding if the user cleared suggestions while we were running.
      if (geocodingAbortRef.current) {
        setGeocodingStatus(null);
        return;
      }
      const location = await reverseGeocode(
        result.centroid_lat!,
        result.centroid_lon!
      );
      done++;
      setGeocodingStatus(`Geocoding ${done} / ${withGps.length}…`);
      if (location) {
        try {
          await renameTrip(result.id, location);
        } catch {
          // Non-fatal: keep the date name.
        }
      }
      if (done < withGps.length) {
        await sleep(NOMINATIM_DELAY_MS);
      }
    }
    setGeocodingStatus(null);
    // Refresh trip list so renamed trips are visible.
    setTrips([]);
    setOffset(0);
    await loadPageRef.current!(0, []);
    onTripsChanged?.();
  }

  async function handleSuggestPhotos() {
    setSuggesting(true);
    setError(null);
    try {
      const result = await suggestPhotosForTrips();
      setSuggestions(result);
      setShowSuggestions(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSuggesting(false);
    }
  }

  async function handleAcceptSuggestion(tripId: number, photoIds: number[]) {
    try {
      await Promise.all(photoIds.map((pid) => setPhotoTrip(pid, tripId)));
      setSuggestions((prev) => prev.filter((s) => s.trip_id !== tripId));
      // Refresh trip list so photo counts update.
      setTrips([]);
      setOffset(0);
      await loadPage(0, []);
      onTripsChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  function handleDismissSuggestion(tripId: number) {
    setSuggestions((prev) => prev.filter((s) => s.trip_id !== tripId));
  }

  async function handleDismissSuggestedTrip(trip: Trip) {
    try {
      await deleteTrip(trip.id);
      setTrips((prev) => prev.filter((t) => t.id !== trip.id));
      onTripsChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleClearAllSuggestions() {
    // Signal the geocoding loop (if running) to stop before clearing trips.
    geocodingAbortRef.current = true;
    setGeocodingStatus(null);
    setClearingAll(true);
    setError(null);
    try {
      await deleteAllSuggestedTrips();
      setTrips([]);
      setOffset(0);
      await loadPage(0, []);
      onTripsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearingAll(false);
    }
  }

  async function handleCreateTrip() {
    const trimmed = newTripName.trim();
    if (!trimmed) return;
    setCreatingTrip(true);
    setError(null);
    try {
      await createTrip(trimmed, null, null, true);
      setNewTripName("");
      setShowNewTripForm(false);
      setTrips([]);
      setOffset(0);
      await loadPage(0, []);
      onTripsChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreatingTrip(false);
    }
  }

  function handleTripDeleted() {
    setSelectedTrip(null);
    setTrips([]);
    setOffset(0);
    loadPage(0, []);
    onTripsChanged?.();
  }

  function handleTripChanged(updated: Trip) {
    setSelectedTrip(updated);
    setTrips((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    onTripsChanged?.();
  }

  const suggested = trips.filter((t) => !t.is_confirmed);
  const confirmed = trips.filter((t) => t.is_confirmed);

  // ── detail view ────────────────────────────────────────────────────────────
  if (selectedTrip !== null) {
    return (
      <TripDetail
        trip={selectedTrip}
        onBack={() => setSelectedTrip(null)}
        onDeleted={handleTripDeleted}
        onTripChanged={handleTripChanged}
      />
    );
  }

  // ── list view ──────────────────────────────────────────────────────────────
  return (
    <div className="trips-panel">
      <div className="trips-toolbar">
        <div>
          <h2>Trips</h2>
          <p className="trips-hint">
            Photos are grouped into trips based on time gaps, geographic
            displacement from home, and photo density. Confirmed trips are
            preserved when re-grouping; only new suggestions are added.
          </p>
        </div>
        <div className="trips-toolbar-actions">
          <button
            className="btn-primary"
            onClick={handleAutoGroup}
            disabled={grouping || loading}
          >
            {grouping ? "Grouping…" : "Auto-group trips"}
          </button>
          <button
            className="btn-outline"
            onClick={() => setShowGroupParams((v) => !v)}
            title="Configure grouping parameters"
          >
            ⚙ Settings
          </button>
          <button
            className="btn-outline"
            onClick={showSuggestions ? () => setShowSuggestions(false) : handleSuggestPhotos}
            disabled={suggesting || loading || confirmed.length === 0}
            title={confirmed.length === 0 ? "Accept some trips first to enable suggestions" : ""}
          >
            {suggesting ? "Finding…" : showSuggestions ? "Hide suggestions" : "Suggest photos"}
          </button>
          <button
            className="btn-outline"
            onClick={() => {
              setShowNewTripForm((v) => !v);
              setNewTripName("");
            }}
          >
            {showNewTripForm ? "Cancel" : "+ New trip"}
          </button>
        </div>
      </div>

      {/* ── Grouping parameters panel ── */}
      {showGroupParams && (
        <div className="trips-group-params">
          <h3>Grouping settings</h3>

          {/* Home location */}
          <div className="trips-param-row">
            <div className="trips-param-label">
              <span>Home location</span>
              {homeLocation ? (
                <span className="trips-home-coords">
                  {homeLocation.lat.toFixed(4)}°, {homeLocation.lon.toFixed(4)}°
                </span>
              ) : (
                <span className="trips-home-unset">Not set</span>
              )}
            </div>
            <button
              className="btn-outline"
              onClick={handleInferHome}
              disabled={inferringHome}
              title="Infer home location from the most-visited area in your library"
            >
              {inferringHome ? "Inferring…" : homeLocation ? "Re-infer home" : "Infer home"}
            </button>
          </div>

          {/* Min distance from home slider */}
          <div className="trips-param-row">
            <label htmlFor="min-trip-km-slider">
              Min distance from home:{" "}
              <strong>{minTripKm === 0 ? "disabled" : `${minTripKm} km`}</strong>
            </label>
            <input
              id="min-trip-km-slider"
              type="range"
              min={0}
              max={200}
              step={5}
              value={minTripKm}
              onChange={(e) => setMinTripKm(Number(e.target.value))}
              className="trips-range-slider"
            />
            <p className="trips-param-hint">
              Clusters closer than this to home are only kept when their photo
              density spikes above your daily baseline (day hikes, local
              outings). Set to 0 to keep all clusters regardless of location.
            </p>
          </div>

          {/* Gap threshold slider */}
          <div className="trips-param-row">
            <label htmlFor="gap-days-slider">
              Gap threshold: <strong>{gapDays} day{gapDays !== 1 ? "s" : ""}</strong>
            </label>
            <input
              id="gap-days-slider"
              type="range"
              min={1}
              max={14}
              step={1}
              value={gapDays}
              onChange={(e) => setGapDays(Number(e.target.value))}
              className="trips-range-slider"
            />
            <p className="trips-param-hint">
              A gap longer than this between consecutive photos forces a new
              trip boundary. Longer gaps produce fewer, broader trips.
            </p>
          </div>

          {/* Move event detection */}
          <div className="trips-param-row">
            <div className="trips-param-label">
              <span>Move events</span>
              <span className="trips-home-coords">
                {transitions.filter((t) => t.is_confirmed).length} confirmed,{" "}
                {transitions.filter((t) => !t.is_confirmed).length} pending
              </span>
            </div>
            <div className="trips-param-row-actions">
              <button
                className="btn-outline"
                onClick={handleDetectMoves}
                disabled={detectingMoves}
                title="Analyse your photo timeline for sustained location changes"
              >
                {detectingMoves ? "Detecting…" : "Detect moves"}
              </button>
              {transitions.length > 0 && (
                <button
                  className="btn-outline"
                  onClick={() => setShowMoveEvents((v) => !v)}
                >
                  {showMoveEvents ? "Hide" : "Show"} move events
                </button>
              )}
            </div>
          </div>

          {/* Move events list */}
          {showMoveEvents && transitions.length > 0 && (
            <div className="trips-move-events">
              {transitions.map((t) => (
                <div key={t.id} className={`trips-move-event${t.is_confirmed ? " trips-move-event--confirmed" : ""}`}>
                  <div className="trips-move-event-info">
                    <span className="trips-move-event-date">
                      {new Date(t.transition_ts * 1000).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </span>
                    <span className="trips-move-event-location">
                      {t.old_lat !== null
                        ? `(${t.old_lat.toFixed(2)}°, ${t.old_lon!.toFixed(2)}°) →`
                        : "Unknown →"}{" "}
                      ({t.new_lat.toFixed(2)}°, {t.new_lon.toFixed(2)}°)
                    </span>
                    {t.is_confirmed && (
                      <span className="trips-move-event-confirmed-badge">✓ Confirmed</span>
                    )}
                  </div>
                  {!t.is_confirmed && (
                    <div className="trips-move-event-actions">
                      <button
                        className="btn-outline"
                        onClick={() => handleConfirmTransition(t.id)}
                      >
                        Confirm
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => handleDismissTransition(t.id)}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {showMoveEvents && transitions.length === 0 && (
            <p className="trips-empty">No move events detected.</p>
          )}
        </div>
      )}

      {/* ── New trip form ── */}
      {showNewTripForm && (
        <div className="trips-new-trip-form">
          <input
            className="trip-rename-input"
            placeholder="Trip name…"
            value={newTripName}
            onChange={(e) => setNewTripName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateTrip();
              if (e.key === "Escape") {
                setShowNewTripForm(false);
                setNewTripName("");
              }
            }}
            autoFocus
            disabled={creatingTrip}
          />
          <button
            className="btn-primary"
            onClick={handleCreateTrip}
            disabled={creatingTrip || !newTripName.trim()}
          >
            {creatingTrip ? "Creating…" : "Create"}
          </button>
        </div>
      )}

      {geocodingStatus && (
        <p className="trips-hint trips-geocoding-status">{geocodingStatus}</p>
      )}

      {error && (
        <p className="trips-error" role="alert">
          {error}
        </p>
      )}

      {/* ── Photo suggestions panel ── */}
      {showSuggestions && (
        <section className="trips-suggestions">
          <h3 className="trips-section-title">
            Photo suggestions
            {suggestions.length > 0 && (
              <span className="trips-section-count">{suggestions.length}</span>
            )}
          </h3>
          {suggestions.length === 0 ? (
            <p className="trips-hint">
              No unassigned photos found that fall within existing confirmed trip
              time windows.
            </p>
          ) : (
            suggestions.map((s) => (
              <div key={s.trip_id} className="trip-suggestion-card">
                <div className="trip-suggestion-header">
                  <span className="trip-suggestion-name">{s.trip_name}</span>
                  <span className="trip-suggestion-count">
                    {s.photos.length} unassigned photo
                    {s.photos.length !== 1 ? "s" : ""} in this time window
                  </span>
                </div>
                <div className="trip-suggestion-thumbs">
                  {s.photos.slice(0, 6).map((p) => (
                    <PhotoCard key={p.id} photo={p} />
                  ))}
                  {s.photos.length > 6 && (
                    <span className="trip-suggestion-more">
                      +{s.photos.length - 6} more
                    </span>
                  )}
                </div>
                <div className="trip-suggestion-actions">
                  <button
                    className="btn-primary"
                    onClick={() =>
                      handleAcceptSuggestion(
                        s.trip_id,
                        s.photos.map((p) => p.id)
                      )
                    }
                  >
                    Add all to "{s.trip_name}"
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => handleDismissSuggestion(s.trip_id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {!loading && trips.length === 0 && !error && (
        <div className="trips-empty-state">
          <p>No trips yet.</p>
          <p className="trips-hint">
            Click <strong>Auto-group trips</strong> to automatically cluster
            your photos into trips based on the time gaps between them, or use{" "}
            <strong>+ New trip</strong> to create one manually.
          </p>
        </div>
      )}

      {/* ── Suggested section ── */}
      {suggested.length > 0 && (
        <section className="trips-section">
          <h3 className="trips-section-title">
            Suggested
            <span className="trips-section-count">{suggested.length}</span>
            <button
              className="btn-ghost trips-clear-all-btn"
              onClick={handleClearAllSuggestions}
              disabled={clearingAll}
              title="Remove all suggestions"
            >
              {clearingAll ? "Clearing…" : "Clear all"}
            </button>
          </h3>
          <div className="trip-list">
            {suggested.map((trip) => (
              <TripCard
                key={trip.id}
                trip={trip}
                onSelect={setSelectedTrip}
                onDismiss={handleDismissSuggestedTrip}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Confirmed section ── */}
      {confirmed.length > 0 && (
        <section className="trips-section">
          <h3 className="trips-section-title">
            Confirmed
            <span className="trips-section-count">{confirmed.length}</span>
          </h3>
          <div className="trip-list">
            {confirmed.map((trip) => (
              <TripCard key={trip.id} trip={trip} onSelect={setSelectedTrip} />
            ))}
          </div>
        </section>
      )}

      {hasMore && (
        <div className="trips-load-more">
          <button
            className="btn-outline"
            onClick={() => loadPage(offset, trips)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && trips.length === 0 && (
        <p className="trips-loading">Loading trips…</p>
      )}
    </div>
  );
}

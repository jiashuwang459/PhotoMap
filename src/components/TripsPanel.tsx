import { useCallback, useEffect, useState } from "react";
import {
  autoGroupTrips,
  confirmTrip,
  deleteTrip,
  listTrips,
  queryPhotosByTrip,
  queryUntrippedPhotos,
  renameTrip,
  setPhotoTrip,
  suggestPhotosForTrips,
} from "../api/photos";
import { PhotoCard } from "./PhotoCard";
import type { Page, Photo, Trip, TripPhotoSuggestion } from "../api/types";

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_GAP_SECONDS = 6 * 3600; // 6 hours
const PAGE_SIZE = 50;

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
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
          onAdded={() => {
            setPhotos([]);
            setOffset(0);
            loadPage(0, []);
          }}
          onClose={() => setShowAddPhotos(false)}
        />
      )}

      {photos.length === 0 && !loading && !error && (
        <p className="trips-empty">No photos in this trip yet.</p>
      )}

      {/* ── Photo grid with per-card remove button ── */}
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
}

function TripCard({ trip, onSelect }: TripCardProps) {
  return (
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
  );
}

// ── TripsPanel — main panel ───────────────────────────────────────────────────

export function TripsPanel() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);

  // Photo suggestions state
  const [suggestions, setSuggestions] = useState<TripPhotoSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

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

  useEffect(() => {
    loadPage(0, []);
  }, [loadPage]);

  async function handleAutoGroup() {
    setGrouping(true);
    setError(null);
    try {
      await autoGroupTrips(DEFAULT_GAP_SECONDS);
      setTrips([]);
      setOffset(0);
      await loadPage(0, []);
    } catch (e) {
      setError(String(e));
    } finally {
      setGrouping(false);
    }
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
    } catch (e) {
      setError(String(e));
    }
  }

  function handleDismissSuggestion(tripId: number) {
    setSuggestions((prev) => prev.filter((s) => s.trip_id !== tripId));
  }

  function handleTripDeleted() {
    setSelectedTrip(null);
    setTrips([]);
    setOffset(0);
    loadPage(0, []);
  }

  function handleTripChanged(updated: Trip) {
    setSelectedTrip(updated);
    setTrips((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
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
            Photos are grouped into trips based on time gaps between shots.
            Confirmed trips are preserved when re-grouping; only new suggestions
            are added.
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
            onClick={showSuggestions ? () => setShowSuggestions(false) : handleSuggestPhotos}
            disabled={suggesting || loading || confirmed.length === 0}
            title={confirmed.length === 0 ? "Accept some trips first to enable suggestions" : ""}
          >
            {suggesting ? "Finding…" : showSuggestions ? "Hide suggestions" : "Suggest photos"}
          </button>
        </div>
      </div>

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
            your photos into trips based on the time gaps between them.
          </p>
        </div>
      )}

      {/* ── Suggested section ── */}
      {suggested.length > 0 && (
        <section className="trips-section">
          <h3 className="trips-section-title">
            Suggested
            <span className="trips-section-count">{suggested.length}</span>
          </h3>
          <div className="trip-list">
            {suggested.map((trip) => (
              <TripCard key={trip.id} trip={trip} onSelect={setSelectedTrip} />
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

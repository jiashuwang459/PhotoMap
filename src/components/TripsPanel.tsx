import { useCallback, useEffect, useState } from "react";
import {
  autoGroupTrips,
  deleteTrip,
  listTrips,
  queryPhotosByTrip,
} from "../api/photos";
import { PhotoCard } from "./PhotoCard";
import type { Page, Photo, Trip } from "../api/types";

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

// ── TripDetail — photos inside a single trip ──────────────────────────────────

interface TripDetailProps {
  trip: Trip;
  onBack: () => void;
  onDeleted: () => void;
}

function TripDetail({ trip, onBack, onDeleted }: TripDetailProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
  }, [loadPage]);

  async function handleDelete() {
    if (!confirm(`Delete trip "${trip.name}"?\nPhotos will not be removed from the library.`)) {
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

  return (
    <div className="trip-detail">
      <div className="trip-detail-header">
        <button className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <div className="trip-detail-title">
          <h2>{trip.name}</h2>
          <span className="trip-detail-meta">
            {fmtDateRange(trip.start_ts, trip.end_ts)} &nbsp;·&nbsp;{" "}
            {trip.photo_count} photo{trip.photo_count !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          className="btn-danger"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "Deleting…" : "Delete trip"}
        </button>
      </div>

      {error && (
        <p className="trips-error" role="alert">
          {error}
        </p>
      )}

      {photos.length === 0 && !loading && !error && (
        <p className="trips-empty">No photos in this trip.</p>
      )}

      <div className="photo-grid">
        {photos.map((p) => (
          <PhotoCard key={p.id} photo={p} />
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
        <span className="trip-card-name">{trip.name}</span>
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

  // Load the first page on mount.
  useEffect(() => {
    loadPage(0, []);
  }, [loadPage]);

  async function handleAutoGroup() {
    if (
      trips.length > 0 &&
      !confirm(
        "Re-grouping will replace all existing trips.\nPhotos will not be removed from the library.\nContinue?"
      )
    ) {
      return;
    }
    setGrouping(true);
    setError(null);
    try {
      await autoGroupTrips(DEFAULT_GAP_SECONDS);
      // Reload trip list from scratch.
      setTrips([]);
      setOffset(0);
      await loadPage(0, []);
    } catch (e) {
      setError(String(e));
    } finally {
      setGrouping(false);
    }
  }

  function handleTripDeleted() {
    setSelectedTrip(null);
    setTrips([]);
    setOffset(0);
    loadPage(0, []);
  }

  // ── detail view ────────────────────────────────────────────────────────────
  if (selectedTrip !== null) {
    return (
      <TripDetail
        trip={selectedTrip}
        onBack={() => setSelectedTrip(null)}
        onDeleted={handleTripDeleted}
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
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={handleAutoGroup}
          disabled={grouping || loading}
        >
          {grouping ? "Grouping…" : "Auto-group trips"}
        </button>
      </div>

      {error && (
        <p className="trips-error" role="alert">
          {error}
        </p>
      )}

      {!loading && trips.length === 0 && !error && (
        <div className="trips-empty-state">
          <p>No trips yet.</p>
          <p className="trips-hint">
            Click <strong>Auto-group trips</strong> to automatically cluster your
            photos into trips based on the time gaps between them.
          </p>
        </div>
      )}

      <div className="trip-list">
        {trips.map((trip) => (
          <TripCard key={trip.id} trip={trip} onSelect={setSelectedTrip} />
        ))}
      </div>

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

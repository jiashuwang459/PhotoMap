//! Trip grouping: CRUD helpers and the automatic temporal-clustering algorithm.
//!
//! A **trip** is a named, time-bounded cluster of photos.  The core algorithm
//! (`auto_group_trips`) works as follows:
//!
//! 1. Fetch photos that are not yet assigned to any confirmed trip, ordered by
//!    timestamp ascending.
//! 2. Split the sequence wherever the gap between two consecutive photos exceeds
//!    a caller-supplied threshold (default: 12 hours = 43 200 seconds) **or**
//!    where two adjacent GPS-tagged photos are more than
//!    [`GEO_SPLIT_KM`] kilometres apart (default: 500 km), whichever comes
//!    first.
//! 3. Each segment becomes one trip.  The trip name is derived from the date
//!    range of its photos (e.g. `"Trip 2024-06-01"` for a single-day trip,
//!    `"Trip 2024-06-01 to 2024-06-05"` for multi-day trips).  If multiple
//!    trips share the same date string a numeric suffix is appended.
//! 4. Only **unconfirmed** (suggested) trips are cleared before the new trips
//!    are written; confirmed trips and their photo assignments are preserved.
//!    Clusters whose time range overlaps an existing confirmed trip are skipped
//!    to avoid duplicate suggestions.
//! 5. Each newly created trip also returns its GPS centroid (average lat/lon of
//!    photos that have coordinates) so callers can perform reverse-geocoding.
//!
//! All functions accept a `&rusqlite::Connection` and never open their own
//! connection, matching the convention used throughout `photomap-core`.

use rusqlite::{Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::photos::{DbError, Page, Photo};

// ──────────────────────────────────────────────────────────────────────────────
// Domain type
// ──────────────────────────────────────────────────────────────────────────────

/// A trip record returned from the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trip {
    pub id: i64,
    pub name: String,
    /// Unix epoch seconds of the earliest photo in the trip.  `None` when the
    /// trip has no photos with timestamps.
    pub start_ts: Option<i64>,
    /// Unix epoch seconds of the latest photo in the trip.  `None` when the
    /// trip has no photos with timestamps.
    pub end_ts: Option<i64>,
    /// `id` of the photo chosen as the trip's cover image.  `None` until set.
    pub cover_photo_id: Option<i64>,
    /// Total number of photos assigned to this trip.
    pub photo_count: i64,
    /// Whether the user has confirmed (accepted) this trip.
    ///
    /// Auto-grouped trips start with `is_confirmed = false` (i.e. "suggested");
    /// the user confirms them via [`confirm_trip`].
    pub is_confirmed: bool,
}

/// Suggested photos to add to an existing trip.
///
/// Returned by [`suggest_photos_for_trips`]: each entry groups untripped
/// photos whose timestamps fall within a confirmed trip's time window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripPhotoSuggestion {
    /// The confirmed trip this suggestion refers to.
    pub trip_id: i64,
    /// Human-readable name of the trip.
    pub trip_name: String,
    /// Photos that are unassigned but whose timestamps fall within the trip's
    /// `[start_ts, end_ts]` window.
    pub photos: Vec<Photo>,
}

// ──────────────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────────────

/// Insert a new trip record and return its generated `id`.
///
/// `start_ts` and `end_ts` are Unix epoch seconds; both are optional.
/// `is_confirmed` should be `true` for manually created trips and `false`
/// for auto-grouped "suggested" trips.
pub fn create_trip(
    conn: &Connection,
    name: &str,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    is_confirmed: bool,
) -> Result<i64, DbError> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO trips (name, start_ts, end_ts, is_confirmed)
         VALUES (?1, ?2, ?3, ?4) RETURNING id",
    )?;
    let id: i64 = stmt.query_row(
        rusqlite::params![name, start_ts, end_ts, is_confirmed as i64],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// Return all trips ordered by `start_ts` ascending (trips without a start
/// timestamp appear last), then by `id`.
///
/// Results are paginated.  Pass increasing `page.offset` values and stop when
/// the returned slice is shorter than `page.limit`.
pub fn list_trips(conn: &Connection, page: &Page) -> Result<Vec<Trip>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.id, t.name, t.start_ts, t.end_ts, t.cover_photo_id,
                COUNT(p.id) AS photo_count, t.is_confirmed
         FROM   trips t
         LEFT   JOIN photos p ON p.trip_id = t.id
         GROUP  BY t.id
         ORDER  BY t.start_ts ASC NULLS LAST, t.id ASC
         LIMIT  ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![page.clamped_limit(), page.offset],
        map_trip_row,
    )?;
    rows.collect::<SqlResult<Vec<_>>>().map_err(DbError::from)
}

/// Return the trip with the given `trip_id`, or `None` if it does not exist.
pub fn get_trip(conn: &Connection, trip_id: i64) -> Result<Option<Trip>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.id, t.name, t.start_ts, t.end_ts, t.cover_photo_id,
                COUNT(p.id) AS photo_count, t.is_confirmed
         FROM   trips t
         LEFT   JOIN photos p ON p.trip_id = t.id
         WHERE  t.id = ?1
         GROUP  BY t.id",
    )?;
    let result = stmt.query_row(rusqlite::params![trip_id], map_trip_row);
    match result {
        Ok(trip) => Ok(Some(trip)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::from(e)),
    }
}

/// Mark the trip as confirmed (user accepted the suggestion).
///
/// Returns `true` if the trip was found and updated, `false` if it did not
/// exist.
pub fn confirm_trip(conn: &Connection, trip_id: i64) -> Result<bool, DbError> {
    let n = conn.execute(
        "UPDATE trips SET is_confirmed = 1 WHERE id = ?1",
        rusqlite::params![trip_id],
    )?;
    Ok(n > 0)
}

/// Rename a trip.
///
/// Returns `true` if the trip was found and renamed, `false` if it did not
/// exist.
pub fn rename_trip(conn: &Connection, trip_id: i64, name: &str) -> Result<bool, DbError> {
    let n = conn.execute(
        "UPDATE trips SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, trip_id],
    )?;
    Ok(n > 0)
}

/// Set the cover photo for a trip.
///
/// `photo_id` may be `None` to clear the cover photo.  The photo must belong
/// to the trip (its `trip_id` column must equal `trip_id`); if it does not,
/// the function returns `false` without modifying the database.
///
/// Returns `true` if the trip was found and updated.
pub fn set_trip_cover_photo(
    conn: &Connection,
    trip_id: i64,
    photo_id: Option<i64>,
) -> Result<bool, DbError> {
    // Validate: photo must belong to this trip (skip validation when clearing).
    if let Some(pid) = photo_id {
        let belongs: bool = conn
            .prepare_cached(
                "SELECT COUNT(*) FROM photos WHERE id = ?1 AND trip_id = ?2",
            )?
            .query_row(rusqlite::params![pid, trip_id], |r| r.get::<_, i64>(0))
            .map(|c| c > 0)
            .unwrap_or(false);
        if !belongs {
            return Ok(false);
        }
    }
    let n = conn.execute(
        "UPDATE trips SET cover_photo_id = ?1 WHERE id = ?2",
        rusqlite::params![photo_id, trip_id],
    )?;
    Ok(n > 0)
}

/// Assign or unassign a photo to/from a trip.
///
/// Pass `Some(trip_id)` to add the photo to the trip, or `None` to remove it
/// from its current trip.
///
/// Returns `true` if the photo record was found and updated, `false` if no
/// such photo exists.
pub fn set_photo_trip(
    conn: &Connection,
    photo_id: i64,
    trip_id: Option<i64>,
) -> Result<bool, DbError> {
    let n = conn.execute(
        "UPDATE photos SET trip_id = ?1 WHERE id = ?2",
        rusqlite::params![trip_id, photo_id],
    )?;
    Ok(n > 0)
}

/// Delete the trip with the given `trip_id`.
///
/// Photos that belonged to the trip have their `trip_id` set to `NULL` first
/// (soft-delete: photos are not removed from the library).
///
/// Returns `true` if a trip was deleted, `false` if no such trip existed.
pub fn delete_trip(conn: &Connection, trip_id: i64) -> Result<bool, DbError> {
    // Unassign photos belonging to this trip.
    conn.execute(
        "UPDATE photos SET trip_id = NULL WHERE trip_id = ?1",
        rusqlite::params![trip_id],
    )?;
    let affected = conn.execute(
        "DELETE FROM trips WHERE id = ?1",
        rusqlite::params![trip_id],
    )?;
    Ok(affected > 0)
}

/// Return all photos assigned to the given trip, ordered by timestamp ascending
/// (photos without a timestamp appear last, then by file path).
///
/// Results are paginated.
pub fn query_photos_by_trip(
    conn: &Connection,
    trip_id: i64,
    page: &Page,
) -> Result<Vec<Photo>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_path, timestamp, latitude, longitude,
                thumbnail_path, blur_score, trip_id, file_hash,
                thumbnail_retry_count, thumbnail_needs_review
         FROM   photos
         WHERE  trip_id = ?1
         ORDER  BY timestamp ASC NULLS LAST, file_path ASC
         LIMIT  ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![trip_id, page.clamped_limit(), page.offset],
        super::photos::map_row_pub,
    )?;
    rows.collect::<SqlResult<Vec<_>>>().map_err(DbError::from)
}

/// Return photos NOT assigned to any trip, ordered by timestamp ascending then
/// file path.  Used to populate the "add photos to trip" picker.
///
/// Results are paginated.
pub fn query_untripped_photos(conn: &Connection, page: &Page) -> Result<Vec<Photo>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_path, timestamp, latitude, longitude,
                thumbnail_path, blur_score, trip_id, file_hash,
                thumbnail_retry_count, thumbnail_needs_review
         FROM   photos
         WHERE  trip_id IS NULL
         ORDER  BY timestamp ASC NULLS LAST, file_path ASC
         LIMIT  ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![page.clamped_limit(), page.offset],
        super::photos::map_row_pub,
    )?;
    rows.collect::<SqlResult<Vec<_>>>().map_err(DbError::from)
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-grouping algorithm
// ──────────────────────────────────────────────────────────────────────────────

/// Default gap threshold: 3 days between consecutive photos triggers a new
/// trip boundary.  With the additional home-distance + density filters, a
/// long gap is the last-resort boundary rather than the primary split signal.
pub const DEFAULT_GAP_SECONDS: i64 = 3 * 24 * 3600;

/// Default haversine distance threshold (km) above which two adjacent
/// GPS-tagged photos force a trip boundary regardless of the time gap.
/// 500 km roughly corresponds to a domestic flight or crossing a country
/// border.
pub const DEFAULT_GEO_SPLIT_KM: f64 = 500.0;

/// Kept for backwards compatibility with code that references `GEO_SPLIT_KM`
/// directly.
pub const GEO_SPLIT_KM: f64 = DEFAULT_GEO_SPLIT_KM;

/// Default minimum distance from the inferred home base (km) required for a
/// cluster to be suggested as a trip.  Clusters whose GPS centroid is closer
/// than this are only kept if their photo density is high enough to indicate a
/// purposeful local outing (see [`DEFAULT_HOME_DENSITY_MULTIPLIER`]).
pub const DEFAULT_MIN_TRIP_KM: f64 = 50.0;

/// Default density multiplier: a near-home cluster is suggested as a trip
/// when its photo density (photos per day) is at least this multiple above
/// the library's baseline daily rate.  This captures concentrated local
/// outings such as day hikes, festivals, or photo walks near home.
pub const DEFAULT_HOME_DENSITY_MULTIPLIER: f64 = 3.0;

/// Kept for backwards compatibility.
pub const HOME_DENSITY_MULTIPLIER: f64 = DEFAULT_HOME_DENSITY_MULTIPLIER;

/// Default minimum number of photos required for a time-cluster to be
/// suggested as a trip.  The default of 1 means every single photo becomes
/// its own trip — use a higher value to discard isolated snapshots.
pub const DEFAULT_MIN_PHOTOS_PER_TRIP: u32 = 1;

/// Summary of a single auto-grouped trip, returned by [`auto_group_trips`].
///
/// Carries the database id plus the GPS centroid of the cluster (if at least
/// one photo had coordinates) so the caller can perform reverse-geocoding and
/// rename the trip to a location-based name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripGroupResult {
    /// Database id of the newly created trip.
    pub id: i64,
    /// Average latitude of photos in this trip that have GPS coordinates.
    /// `None` when no photos carry GPS data.
    pub centroid_lat: Option<f64>,
    /// Average longitude of photos in this trip that have GPS coordinates.
    /// `None` when no photos carry GPS data.
    pub centroid_lon: Option<f64>,
}

/// Default values for all [`auto_group_trips`] parameters.
///
/// Returned by [`get_auto_group_defaults`] so the frontend can initialise its
/// controls without hard-coding anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoGroupDefaults {
    /// Default time-gap threshold in seconds.
    pub gap_seconds: i64,
    /// Default minimum distance from home (km) for a cluster to be kept.
    pub min_trip_km: f64,
    /// Default geographic split threshold (km).
    pub geo_split_km: f64,
    /// Default home-density multiplier for near-home clusters.
    pub home_density_multiplier: f64,
    /// Default minimum photos-per-cluster threshold.
    pub min_photos_per_trip: u32,
}

/// Return the compile-time default values for every [`auto_group_trips`]
/// parameter.  The frontend can call this once on startup to pre-fill its
/// controls instead of hard-coding the numbers.
pub fn get_auto_group_defaults() -> AutoGroupDefaults {
    AutoGroupDefaults {
        gap_seconds: DEFAULT_GAP_SECONDS,
        min_trip_km: DEFAULT_MIN_TRIP_KM,
        geo_split_km: DEFAULT_GEO_SPLIT_KM,
        home_density_multiplier: DEFAULT_HOME_DENSITY_MULTIPLIER,
        min_photos_per_trip: DEFAULT_MIN_PHOTOS_PER_TRIP,
    }
}


///
/// The algorithm:
/// 1. Preserves confirmed trip ranges.
/// 2. Clears all unconfirmed (suggested) trips.
/// 3. Loads every photo that has a `timestamp`, ordered ascending.
/// 4. Splits the sequence wherever two consecutive photos are more than
///    `gap_seconds` apart **or** both have GPS coordinates that are more than
///    `geo_split_km` km apart.
/// 5. Drops clusters with fewer than `min_photos` photos (noise filter).
/// 6. Filters clusters using home-location and density signals:
///    - If no home location is stored, all clusters are kept (legacy behaviour).
///    - If a home location is set, clusters whose GPS centroid is within
///      `min_trip_km` of home are only kept when their photo density exceeds
///      the library baseline by `home_density_multiplier`× (day hikes, local
///      outings).  Sparse near-home sessions (everyday snapshots) are dropped.
/// 7. Creates one `trips` row per surviving cluster; the name spans the date
///    range (`"Trip 2024-06-01"` or `"Trip 2024-06-01 to 2024-06-05"`).
///
/// Photos without a `timestamp` are left ungrouped (`trip_id = NULL`).
///
/// **Confirmed trips are never touched.**  Clusters whose time range overlaps
/// an existing confirmed trip are skipped to avoid creating duplicate
/// suggestions.
///
/// Returns a [`Vec<TripGroupResult>`] describing each newly created trip,
/// including its GPS centroid so the caller can perform reverse-geocoding.
///
/// # Errors
/// Returns a [`DbError`] on any SQLite failure.
pub fn auto_group_trips(
    conn: &Connection,
    gap_seconds: i64,
    min_trip_km: f64,
    geo_split_km: f64,
    home_density_multiplier: f64,
    min_photos: u32,
) -> Result<Vec<TripGroupResult>, DbError> {
    // ── 1. Load confirmed trip ranges (preserve these) ────────────────────────
    struct ConfirmedRange {
        start_ts: i64,
        end_ts: i64,
    }
    let mut confirmed_stmt = conn.prepare_cached(
        "SELECT start_ts, end_ts FROM trips WHERE is_confirmed = 1
         AND start_ts IS NOT NULL AND end_ts IS NOT NULL",
    )?;
    let confirmed_ranges: Vec<ConfirmedRange> = confirmed_stmt
        .query_map([], |row| {
            Ok(ConfirmedRange {
                start_ts: row.get(0)?,
                end_ts: row.get(1)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    // ── 2. Clear only unconfirmed (suggested) trips ───────────────────────────
    conn.execute_batch(
        "UPDATE photos SET trip_id = NULL
         WHERE trip_id IN (SELECT id FROM trips WHERE is_confirmed = 0);
         DELETE FROM trips WHERE is_confirmed = 0;",
    )?;

    // ── 3. Load photos not already in a confirmed trip ────────────────────────
    struct Row {
        id: i64,
        timestamp: i64,
        latitude: Option<f64>,
        longitude: Option<f64>,
    }

    let mut stmt = conn.prepare_cached(
        "SELECT id, timestamp, latitude, longitude FROM photos
         WHERE  timestamp IS NOT NULL
           AND  trip_id IS NULL
         ORDER BY timestamp ASC",
    )?;
    let photo_rows: Vec<Row> = stmt
        .query_map([], |row| {
            Ok(Row {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                latitude: row.get(2)?,
                longitude: row.get(3)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    if photo_rows.is_empty() {
        return Ok(vec![]);
    }

    // ── 4. Split into clusters ────────────────────────────────────────────────
    // Each cluster: (start_ts, end_ts, photo_ids, lats, lons)
    struct Cluster {
        start_ts: i64,
        end_ts: i64,
        photo_ids: Vec<i64>,
        lats: Vec<f64>,
        lons: Vec<f64>,
    }

    let first = &photo_rows[0];
    let mut current = Cluster {
        start_ts: first.timestamp,
        end_ts: first.timestamp,
        photo_ids: vec![first.id],
        lats: first.latitude.into_iter().collect(),
        lons: first.longitude.into_iter().collect(),
    };
    let mut clusters: Vec<Cluster> = Vec::new();

    for row in &photo_rows[1..] {
        // Primary split: time gap.
        let time_split = row.timestamp - current.end_ts > gap_seconds;

        // Secondary split: large geographic jump (both photos need GPS).
        let is_geo_split = match (
            current.lats.last().copied().zip(current.lons.last().copied()),
            row.latitude.zip(row.longitude),
        ) {
            (Some((prev_lat, prev_lon)), Some((next_lat, next_lon))) => {
                haversine_km(prev_lat, prev_lon, next_lat, next_lon) > geo_split_km
            }
            _ => false,
        };

        if time_split || is_geo_split {
            clusters.push(std::mem::replace(
                &mut current,
                Cluster {
                    start_ts: row.timestamp,
                    end_ts: row.timestamp,
                    photo_ids: vec![row.id],
                    lats: row.latitude.into_iter().collect(),
                    lons: row.longitude.into_iter().collect(),
                },
            ));
        } else {
            current.end_ts = row.timestamp;
            current.photo_ids.push(row.id);
            if let Some(lat) = row.latitude {
                current.lats.push(lat);
            }
            if let Some(lon) = row.longitude {
                current.lons.push(lon);
            }
        }
    }
    clusters.push(current);

    // ── 5. Min-photos noise filter ────────────────────────────────────────────
    //
    // Drop clusters that are too small to be meaningful trips (isolated
    // snapshots, stray captures, etc.).  A min_photos value of 1 disables
    // this filter (every single photo becomes its own trip).
    let clusters: Vec<Cluster> = if min_photos > 1 {
        clusters
            .into_iter()
            .filter(|c| c.photo_ids.len() >= min_photos as usize)
            .collect()
    } else {
        clusters
    };

    // ── 6. Home-location and density filtering ────────────────────────────────
    //
    // When a home location is stored in settings (optionally refined by
    // confirmed move events), clusters are filtered:
    //
    // * Clusters without GPS data pass through unchanged.
    // * Clusters whose centroid is farther than `min_trip_km` from home are
    //   always kept (away trips / travel).
    // * Near-home clusters are kept only when their photo density is at least
    //   `home_density_multiplier` × the library's baseline daily rate —
    //   this captures concentrated local outings (day hikes, festivals) while
    //   discarding everyday home snapshots.
    // * When no home location is set the filter is skipped entirely.

    // Baseline density: photos per day across the unconfirmed pool.
    let baseline_density = if photo_rows.len() >= 2 {
        let span_secs = photo_rows.last().unwrap().timestamp
            - photo_rows.first().unwrap().timestamp;
        let days = (span_secs as f64 / 86_400.0).max(1.0);
        photo_rows.len() as f64 / days
    } else {
        1.0
    };

    // Mid-cluster timestamp used to resolve the effective home when move
    // events are in play.
    let mid_ts = |c: &Cluster| (c.start_ts + c.end_ts) / 2;

    // Determine whether to apply home filtering and cache the home-lookup
    // result for clusters whose centroid is within range.
    let home_filter_active = min_trip_km > 0.0 && {
        // Peek at the settings to see if any home is configured.
        super::settings::get_home_location(conn)?.is_some()
    };

    let clusters: Vec<Cluster> = if home_filter_active {
        clusters
            .into_iter()
            .filter(|c| {
                // Compute the cluster's GPS centroid (if available).
                if c.lats.is_empty() {
                    return true; // No GPS → can't filter → keep.
                }
                let n = c.lats.len() as f64;
                let cent_lat = c.lats.iter().sum::<f64>() / n;
                let cent_lon = c.lons.iter().sum::<f64>() / n;

                // Effective home at the cluster's midpoint timestamp.
                let home = match super::settings::home_at(conn, mid_ts(c)) {
                    Ok(Some(h)) => h,
                    _ => return true, // Settings read failed or no home → keep.
                };

                let dist_km = haversine_km(home.lat, home.lon, cent_lat, cent_lon);
                if dist_km >= min_trip_km {
                    return true; // Far from home → definitely a trip.
                }

                // Near home: keep only if density spikes above the baseline.
                let cluster_days =
                    ((c.end_ts - c.start_ts) as f64 / 86_400.0).max(1.0);
                let cluster_density = c.photo_ids.len() as f64 / cluster_days;
                cluster_density >= baseline_density * home_density_multiplier
            })
            .collect()
    } else {
        clusters
    };

    // ── 7. Persist trips, skipping those that overlap a confirmed trip ─────────
    let mut name_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut results: Vec<TripGroupResult> = Vec::with_capacity(clusters.len());

    let mut insert_trip = conn.prepare_cached(
        // is_confirmed = 0: auto-grouped trips are "suggested" by default.
        "INSERT INTO trips (name, start_ts, end_ts, is_confirmed) VALUES (?1, ?2, ?3, 0) RETURNING id",
    )?;

    for cluster in clusters {
        // Skip clusters that overlap any confirmed trip to avoid duplicates.
        let overlaps_confirmed = confirmed_ranges.iter().any(|r| {
            ranges_overlap(cluster.start_ts, cluster.end_ts, r.start_ts, r.end_ts)
        });
        if overlaps_confirmed {
            continue;
        }

        // Derive the trip name from the date range (UTC).
        let start_date = ts_to_date_str(cluster.start_ts);
        let end_date = ts_to_date_str(cluster.end_ts);
        let date_str = if start_date == end_date {
            start_date
        } else {
            format!("{start_date} to {end_date}")
        };
        let count = name_counts.entry(date_str.clone()).or_insert(0);
        *count += 1;
        let name = if *count == 1 {
            format!("Trip {date_str}")
        } else {
            format!("Trip {date_str} ({count})")
        };

        let trip_id: i64 = insert_trip.query_row(
            rusqlite::params![name, cluster.start_ts, cluster.end_ts],
            |row| row.get(0),
        )?;

        // Compute GPS centroid.
        let centroid = if !cluster.lats.is_empty() {
            let n = cluster.lats.len() as f64;
            Some((
                cluster.lats.iter().sum::<f64>() / n,
                cluster.lons.iter().sum::<f64>() / n,
            ))
        } else {
            None
        };

        results.push(TripGroupResult {
            id: trip_id,
            centroid_lat: centroid.map(|(lat, _)| lat),
            centroid_lon: centroid.map(|(_, lon)| lon),
        });

        // Batch-update photos using a parameterised IN clause.
        let placeholders = (1..=cluster.photo_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE photos SET trip_id = ?1 WHERE id IN ({placeholders})"
        );
        let mut upd = conn.prepare_cached(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> =
            Vec::with_capacity(1 + cluster.photo_ids.len());
        params.push(Box::new(trip_id));
        for pid in &cluster.photo_ids {
            params.push(Box::new(*pid));
        }
        upd.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;
    }

    Ok(results)
}

/// Delete all unconfirmed (suggested) trips in one operation.
///
/// Photos that belonged to those trips have their `trip_id` set to `NULL`
/// (they are **not** removed from the library).
///
/// Returns the number of trips that were deleted.
///
/// # Errors
/// Returns a [`DbError`] on any SQLite failure.
pub fn delete_all_suggested_trips(conn: &Connection) -> Result<u64, DbError> {
    conn.execute(
        "UPDATE photos SET trip_id = NULL
         WHERE trip_id IN (SELECT id FROM trips WHERE is_confirmed = 0)",
        [],
    )?;
    let deleted = conn.execute(
        "DELETE FROM trips WHERE is_confirmed = 0",
        [],
    )?;
    Ok(deleted as u64)
}

/// Find untripped photos whose timestamps fall within confirmed trip windows
/// and return them as suggestions grouped by trip.
///
/// Only confirmed trips with non-null `start_ts` and `end_ts` are considered.
/// Photos that already belong to any trip are excluded.
///
/// # Errors
/// Returns a [`DbError`] on any SQLite failure.
pub fn suggest_photos_for_trips(
    conn: &Connection,
) -> Result<Vec<TripPhotoSuggestion>, DbError> {
    // Load confirmed trips that have defined time ranges.
    struct TripMeta {
        id: i64,
        name: String,
        start_ts: i64,
        end_ts: i64,
    }
    let mut trip_stmt = conn.prepare_cached(
        "SELECT id, name, start_ts, end_ts FROM trips
         WHERE  is_confirmed = 1
           AND  start_ts IS NOT NULL
           AND  end_ts   IS NOT NULL
         ORDER BY start_ts ASC",
    )?;
    let trip_metas: Vec<TripMeta> = trip_stmt
        .query_map([], |row| {
            Ok(TripMeta {
                id: row.get(0)?,
                name: row.get(1)?,
                start_ts: row.get(2)?,
                end_ts: row.get(3)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    if trip_metas.is_empty() {
        return Ok(vec![]);
    }

    // For each confirmed trip, find untripped photos in its time window.
    let mut suggestions: Vec<TripPhotoSuggestion> = Vec::new();

    let mut photo_stmt = conn.prepare_cached(
        "SELECT id, file_path, timestamp, latitude, longitude,
                thumbnail_path, blur_score, trip_id, file_hash,
                thumbnail_retry_count, thumbnail_needs_review
         FROM   photos
         WHERE  trip_id   IS NULL
           AND  timestamp >= ?1
           AND  timestamp <= ?2
         ORDER BY timestamp ASC",
    )?;

    for tm in &trip_metas {
        let photos: Vec<crate::db::photos::Photo> = photo_stmt
            .query_map(rusqlite::params![tm.start_ts, tm.end_ts], |row| {
                Ok(crate::db::photos::Photo {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    timestamp: row.get(2)?,
                    latitude: row.get(3)?,
                    longitude: row.get(4)?,
                    thumbnail_path: row.get(5)?,
                    blur_score: row.get(6)?,
                    trip_id: row.get(7)?,
                    file_hash: row.get(8)?,
                    thumbnail_retry_count: row.get(9)?,
                    thumbnail_needs_review: row.get::<_, i64>(10)? != 0,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        if !photos.is_empty() {
            suggestions.push(TripPhotoSuggestion {
                trip_id: tm.id,
                trip_name: tm.name.clone(),
                photos,
            });
        }
    }

    Ok(suggestions)
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Returns `true` when the time ranges `[a_start, a_end]` and `[b_start, b_end]`
/// share at least one point (inclusive on both ends).
fn ranges_overlap(a_start: i64, a_end: i64, b_start: i64, b_end: i64) -> bool {
    a_start <= b_end && b_start <= a_end
}

/// Compute the great-circle distance in kilometres between two WGS-84
/// coordinates using the haversine formula.
///
/// Input angles are in decimal degrees.  The result is accurate to within
/// ~0.5% for the distances relevant to trip splitting.
fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6_371.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let lat1_r = lat1.to_radians();
    let lat2_r = lat2.to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1_r.cos() * lat2_r.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    EARTH_RADIUS_KM * c
}

fn map_trip_row(row: &rusqlite::Row<'_>) -> SqlResult<Trip> {
    Ok(Trip {
        id: row.get(0)?,
        name: row.get(1)?,
        start_ts: row.get(2)?,
        end_ts: row.get(3)?,
        cover_photo_id: row.get(4)?,
        photo_count: row.get(5)?,
        is_confirmed: row.get::<_, i64>(6)? != 0,
    })
}

/// Convert a Unix epoch timestamp to a `"YYYY-MM-DD"` string (UTC).
fn ts_to_date_str(ts: i64) -> String {
    // Use time crate for reliable UTC conversion without pulling in chrono.
    match OffsetDateTime::from_unix_timestamp(ts) {
        Ok(dt) => {
            format!("{:04}-{:02}-{:02}", dt.year(), dt.month() as u8, dt.day())
        }
        Err(_) => {
            // Fallback for out-of-range timestamps: format the raw value.
            format!("ts-{ts}")
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::photos::{run_migrations, upsert_photo, InsertPhoto};

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn insert(conn: &Connection, path: &str, ts: Option<i64>) -> i64 {
        upsert_photo(
            conn,
            &InsertPhoto {
                file_path: path.to_owned(),
                timestamp: ts,
                latitude: None,
                longitude: None,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: None,
            },
        )
        .unwrap()
    }

    // ── create / get / delete ────────────────────────────────────────────────

    #[test]
    fn create_and_get_trip() {
        let conn = mem_db();
        let id = create_trip(&conn, "My Trip", Some(1_000_000), Some(1_100_000), true).unwrap();
        let trip = get_trip(&conn, id).unwrap().expect("trip should exist");
        assert_eq!(trip.id, id);
        assert_eq!(trip.name, "My Trip");
        assert_eq!(trip.start_ts, Some(1_000_000));
        assert_eq!(trip.end_ts, Some(1_100_000));
        assert_eq!(trip.photo_count, 0);
        assert!(trip.is_confirmed, "manually created trip should be confirmed");
    }

    #[test]
    fn suggested_trip_starts_unconfirmed() {
        let conn = mem_db();
        let id = create_trip(&conn, "Suggested", Some(100), None, false).unwrap();
        let trip = get_trip(&conn, id).unwrap().unwrap();
        assert!(!trip.is_confirmed);
    }

    #[test]
    fn confirm_trip_updates_flag() {
        let conn = mem_db();
        let id = create_trip(&conn, "Suggested", None, None, false).unwrap();
        assert!(confirm_trip(&conn, id).unwrap());
        let trip = get_trip(&conn, id).unwrap().unwrap();
        assert!(trip.is_confirmed);
    }

    #[test]
    fn confirm_nonexistent_trip_returns_false() {
        let conn = mem_db();
        assert!(!confirm_trip(&conn, 999).unwrap());
    }

    #[test]
    fn rename_trip_updates_name() {
        let conn = mem_db();
        let id = create_trip(&conn, "Old Name", None, None, true).unwrap();
        assert!(rename_trip(&conn, id, "New Name").unwrap());
        let trip = get_trip(&conn, id).unwrap().unwrap();
        assert_eq!(trip.name, "New Name");
    }

    #[test]
    fn set_photo_trip_assigns_and_unassigns() {
        let conn = mem_db();
        let trip_id = create_trip(&conn, "T", None, None, true).unwrap();
        let photo_id = insert(&conn, "/p.jpg", Some(1000));

        // Assign
        assert!(set_photo_trip(&conn, photo_id, Some(trip_id)).unwrap());
        let trip = get_trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(trip.photo_count, 1);

        // Unassign
        assert!(set_photo_trip(&conn, photo_id, None).unwrap());
        let trip = get_trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(trip.photo_count, 0);
    }

    #[test]
    fn query_untripped_photos_excludes_trip_members() {
        let conn = mem_db();
        let trip_id = create_trip(&conn, "T", None, None, true).unwrap();
        let a = insert(&conn, "/a.jpg", Some(100));
        let _b = insert(&conn, "/b.jpg", Some(200));
        set_photo_trip(&conn, a, Some(trip_id)).unwrap();

        let untripped =
            query_untripped_photos(&conn, &Page { limit: 10, offset: 0 }).unwrap();
        assert_eq!(untripped.len(), 1);
        assert_eq!(untripped[0].file_path, "/b.jpg");
    }

    #[test]
    fn auto_group_creates_suggested_trips_basic() {
        let conn = mem_db();
        insert(&conn, "/a.jpg", Some(0));
        let results = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        let trip = get_trip(&conn, results[0].id).unwrap().unwrap();
        assert!(!trip.is_confirmed, "auto-grouped trips should start as suggested");
    }

    #[test]
    fn get_nonexistent_trip_returns_none() {
        let conn = mem_db();
        assert!(get_trip(&conn, 999).unwrap().is_none());
    }

    #[test]
    fn delete_trip_unassigns_photos() {
        let conn = mem_db();
        let trip_id = create_trip(&conn, "T", None, None, true).unwrap();
        // Manually assign a photo to the trip.
        let photo_id = insert(&conn, "/a.jpg", Some(100));
        conn.execute(
            "UPDATE photos SET trip_id = ?1 WHERE id = ?2",
            rusqlite::params![trip_id, photo_id],
        )
        .unwrap();

        // Verify assignment.
        let trip = get_trip(&conn, trip_id).unwrap().unwrap();
        assert_eq!(trip.photo_count, 1);

        // Delete the trip.
        assert!(delete_trip(&conn, trip_id).unwrap());

        // Photo should now have trip_id = NULL.
        let row: Option<i64> = conn
            .query_row(
                "SELECT trip_id FROM photos WHERE id = ?1",
                rusqlite::params![photo_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(row.is_none(), "trip_id should be NULL after trip deletion");
    }

    #[test]
    fn delete_nonexistent_trip_returns_false() {
        let conn = mem_db();
        assert!(!delete_trip(&conn, 999).unwrap());
    }

    // ── list_trips ───────────────────────────────────────────────────────────

    #[test]
    fn list_trips_ordered_by_start_ts() {
        let conn = mem_db();
        create_trip(&conn, "Later", Some(2_000_000), None, true).unwrap();
        create_trip(&conn, "Earlier", Some(1_000_000), None, true).unwrap();
        create_trip(&conn, "No ts", None, None, true).unwrap();

        let trips = list_trips(&conn, &Page { limit: 10, offset: 0 }).unwrap();
        assert_eq!(trips[0].name, "Earlier");
        assert_eq!(trips[1].name, "Later");
        assert_eq!(trips[2].name, "No ts");
    }

    #[test]
    fn list_trips_pagination() {
        let conn = mem_db();
        for i in 0..5 {
            create_trip(&conn, &format!("Trip {i}"), Some(i as i64 * 1000), None, true).unwrap();
        }
        let page1 = list_trips(&conn, &Page { limit: 2, offset: 0 }).unwrap();
        let page2 = list_trips(&conn, &Page { limit: 2, offset: 2 }).unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 2);
        assert_ne!(page1[0].id, page2[0].id);
    }

    // ── query_photos_by_trip ──────────────────────────────────────────────────

    #[test]
    fn query_photos_by_trip_returns_assigned_photos() {
        let conn = mem_db();
        let trip_id = create_trip(&conn, "T", None, None, true).unwrap();
        insert(&conn, "/z.jpg", Some(300));
        let a = insert(&conn, "/a.jpg", Some(100));
        let b = insert(&conn, "/b.jpg", Some(200));
        conn.execute(
            "UPDATE photos SET trip_id = ?1 WHERE id IN (?2, ?3)",
            rusqlite::params![trip_id, a, b],
        )
        .unwrap();

        let photos =
            query_photos_by_trip(&conn, trip_id, &Page { limit: 10, offset: 0 }).unwrap();
        assert_eq!(photos.len(), 2);
        assert_eq!(photos[0].file_path, "/a.jpg");
        assert_eq!(photos[1].file_path, "/b.jpg");
    }

    // ── auto_group_trips ──────────────────────────────────────────────────────

    #[test]
    fn auto_group_creates_trips_by_gap() {
        let conn = mem_db();
        // Two photos close together, then a big gap, then two more.
        insert(&conn, "/d1a.jpg", Some(0));
        insert(&conn, "/d1b.jpg", Some(3600)); // 1 h later → same trip
        insert(&conn, "/d2a.jpg", Some(3600 + 25_200)); // 7 h later → new trip
        insert(&conn, "/d2b.jpg", Some(3600 + 25_200 + 1800)); // 30 min later → same trip

        let gap = 6 * 3600; // 6 hours
        let results = auto_group_trips(&conn, gap, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 2, "expected exactly 2 trips");

        let t1 = get_trip(&conn, results[0].id).unwrap().unwrap();
        let t2 = get_trip(&conn, results[1].id).unwrap().unwrap();
        assert_eq!(t1.photo_count, 2);
        assert_eq!(t2.photo_count, 2);
    }

    #[test]
    fn auto_group_with_no_photos_returns_empty() {
        let conn = mem_db();
        let results = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn auto_group_excludes_untimed_photos() {
        let conn = mem_db();
        insert(&conn, "/timed.jpg", Some(1_000_000));
        insert(&conn, "/untimed.jpg", None);

        let results = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 1);
        let trip = get_trip(&conn, results[0].id).unwrap().unwrap();
        assert_eq!(trip.photo_count, 1);

        // Untimed photo must remain ungrouped.
        let ungrouped: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM photos WHERE trip_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ungrouped, 1);
    }

    #[test]
    fn auto_group_is_idempotent() {
        let conn = mem_db();
        insert(&conn, "/a.jpg", Some(0));
        insert(&conn, "/b.jpg", Some(100));

        let res1 = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        let res2 = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();

        // Same number of trips; old trips are gone.
        assert_eq!(res1.len(), res2.len());
        // First-run trip IDs are no longer valid.
        assert!(get_trip(&conn, res1[0].id).unwrap().is_none());
        // New trips are valid.
        assert!(get_trip(&conn, res2[0].id).unwrap().is_some());
    }

    #[test]
    fn auto_group_single_photo_creates_one_trip() {
        let conn = mem_db();
        insert(&conn, "/solo.jpg", Some(1_700_000_000));
        let results = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 1);
        let trip = get_trip(&conn, results[0].id).unwrap().unwrap();
        assert_eq!(trip.photo_count, 1);
        assert!(trip.name.starts_with("Trip "));
    }

    #[test]
    fn trip_name_has_date_suffix_disambiguation() {
        let conn = mem_db();
        // Two separate trips on the same UTC date (gap > 6 h within the same day).
        // Day 2024-01-01: 00:00 then 08:00 UTC → two trips.
        let day = 1_704_067_200_i64; // 2024-01-01 00:00:00 UTC
        insert(&conn, "/a.jpg", Some(day));
        insert(&conn, "/b.jpg", Some(day + 8 * 3600));

        let results = auto_group_trips(&conn, 6 * 3600, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 2);
        let names: Vec<String> = results
            .iter()
            .map(|r| get_trip(&conn, r.id).unwrap().unwrap().name)
            .collect();
        assert_eq!(names[0], "Trip 2024-01-01");
        assert_eq!(names[1], "Trip 2024-01-01 (2)");
    }

    #[test]
    fn auto_group_multiday_trip_has_date_range_name() {
        let conn = mem_db();
        // Photos spanning multiple days with a gap smaller than 12 h → one trip.
        let day1 = 1_704_067_200_i64; // 2024-01-01 00:00 UTC
        let day3 = day1 + 2 * 86_400; // 2024-01-03
        insert(&conn, "/a.jpg", Some(day1));
        insert(&conn, "/b.jpg", Some(day1 + 3600)); // 1h later, same cluster
        insert(&conn, "/c.jpg", Some(day3));         // day3, but gap < 12h from /b

        // Gap must be small enough that all 3 end up in the same trip.
        // day3 - (day1 + 3600) = 2*86400 - 3600 = 169200 s < 48*3600 (48h gap)
        let results = auto_group_trips(&conn, 48 * 3600, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 1);
        let trip = get_trip(&conn, results[0].id).unwrap().unwrap();
        assert_eq!(trip.name, "Trip 2024-01-01 to 2024-01-03");
    }

    #[test]
    fn auto_group_creates_suggested_trips() {
        let conn = mem_db();
        insert(&conn, "/a.jpg", Some(0));
        let results = auto_group_trips(&conn, DEFAULT_GAP_SECONDS, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        let trip = get_trip(&conn, results[0].id).unwrap().unwrap();
        assert!(!trip.is_confirmed, "auto-grouped trips should start as suggested");
    }

    #[test]
    fn auto_group_geo_split_on_large_distance() {
        let conn = mem_db();
        // Insert a helper that accepts lat/lon.
        fn insert_gps(conn: &Connection, path: &str, ts: i64, lat: f64, lon: f64) {
            conn.execute(
                "INSERT INTO photos (file_path, timestamp, latitude, longitude) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![path, ts, lat, lon],
            ).unwrap();
        }

        // London (~51.5°N, 0°W) then Tokyo (~35.7°N, 139.7°E) — ~9 555 km apart.
        // Time gap is only 1 hour, well under any reasonable threshold.
        insert_gps(&conn, "/london.jpg", 0, 51.5, 0.0);
        insert_gps(&conn, "/tokyo.jpg",  3600, 35.7, 139.7);

        // Use a very large gap so only geo-split can separate them.
        let results = auto_group_trips(&conn, 100 * 3600, 0.0, DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP).unwrap();
        assert_eq!(results.len(), 2, "geo-split should create 2 trips");
    }

    #[test]
    fn delete_all_suggested_removes_only_unconfirmed() {
        let conn = mem_db();
        let confirmed = create_trip(&conn, "Confirmed", None, None, true).unwrap();
        let _suggested = create_trip(&conn, "Suggested", None, None, false).unwrap();

        let deleted = delete_all_suggested_trips(&conn).unwrap();
        assert_eq!(deleted, 1);

        // Confirmed trip still exists.
        assert!(get_trip(&conn, confirmed).unwrap().is_some());
        // Total trips = 1.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM trips", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}

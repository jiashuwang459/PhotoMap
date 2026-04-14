//! Trip grouping: CRUD helpers and the automatic temporal-clustering algorithm.
//!
//! A **trip** is a named, time-bounded cluster of photos.  The core algorithm
//! (`auto_group_trips`) works as follows:
//!
//! 1. Fetch all photos that have a timestamp, ordered by timestamp ascending.
//! 2. Split the sequence wherever the gap between two consecutive photos exceeds
//!    a caller-supplied threshold (default: 6 hours = 21 600 seconds).
//! 3. Each segment becomes one trip.  The trip name is derived from the date of
//!    its first photo (e.g. `"Trip 2024-06-01"`).  If multiple trips start on
//!    the same date a numeric suffix is appended (`"Trip 2024-06-01 (2)"`).
//! 4. Any existing trips and `trip_id` assignments are cleared before the new
//!    trips are written, making the operation fully idempotent.
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

/// Default gap threshold: 6 hours between consecutive photos triggers a new
/// trip boundary.
pub const DEFAULT_GAP_SECONDS: i64 = 6 * 3600;

/// Cluster all timestamped photos into trips and persist the result.
///
/// The algorithm:
/// 1. Clears all existing trips and unsets every `photos.trip_id`.
/// 2. Loads every photo that has a `timestamp`, ordered ascending.
/// 3. Splits the sequence wherever two consecutive photos are more than
///    `gap_seconds` apart.
/// 4. Creates one `trips` row per cluster and batch-updates `photos.trip_id`.
///
/// Photos without a `timestamp` are left ungrouped (`trip_id = NULL`).
///
/// Returns the list of newly created trip IDs.
///
/// # Errors
/// Returns a [`DbError`] on any SQLite failure.
pub fn auto_group_trips(
    conn: &Connection,
    gap_seconds: i64,
) -> Result<Vec<i64>, DbError> {
    // ── 1. Clear existing trips ──────────────────────────────────────────────
    conn.execute_batch(
        "UPDATE photos SET trip_id = NULL;
         DELETE FROM trips;",
    )?;

    // ── 2. Load timestamped photos ordered by timestamp ───────────────────
    struct Row {
        id: i64,
        timestamp: i64,
    }

    let mut stmt = conn.prepare_cached(
        "SELECT id, timestamp FROM photos WHERE timestamp IS NOT NULL ORDER BY timestamp ASC",
    )?;
    let photo_rows: Vec<Row> = stmt
        .query_map([], |row| {
            Ok(Row {
                id: row.get(0)?,
                timestamp: row.get(1)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    if photo_rows.is_empty() {
        return Ok(vec![]);
    }

    // ── 3. Split into clusters ─────────────────────────────────────────────
    // Each cluster is (start_ts, end_ts, Vec<photo_id>).
    let mut clusters: Vec<(i64, i64, Vec<i64>)> = Vec::new();
    let mut current_start = photo_rows[0].timestamp;
    let mut current_end = photo_rows[0].timestamp;
    let mut current_ids: Vec<i64> = vec![photo_rows[0].id];

    for row in &photo_rows[1..] {
        if row.timestamp - current_end > gap_seconds {
            clusters.push((current_start, current_end, std::mem::take(&mut current_ids)));
            current_start = row.timestamp;
        }
        current_end = row.timestamp;
        current_ids.push(row.id);
    }
    clusters.push((current_start, current_end, current_ids));

    // ── 4. Persist trips and assign photo IDs ─────────────────────────────
    let mut name_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut trip_ids: Vec<i64> = Vec::with_capacity(clusters.len());

    let mut insert_trip = conn.prepare_cached(
        // is_confirmed = 0: auto-grouped trips are "suggested" by default.
        "INSERT INTO trips (name, start_ts, end_ts, is_confirmed) VALUES (?1, ?2, ?3, 0) RETURNING id",
    )?;

    for (start_ts, end_ts, photo_ids) in clusters {
        // Derive the trip name from the start date (UTC).
        let date_str = ts_to_date_str(start_ts);
        let count = name_counts.entry(date_str.clone()).or_insert(0);
        *count += 1;
        let name = if *count == 1 {
            format!("Trip {date_str}")
        } else {
            format!("Trip {date_str} ({count})")
        };

        let trip_id: i64 = insert_trip.query_row(
            rusqlite::params![name, start_ts, end_ts],
            |row| row.get(0),
        )?;
        trip_ids.push(trip_id);

        // Batch-update photos using a temporary VALUES list.  rusqlite does not
        // support array parameters, so we build a parameterised IN clause.
        let placeholders = (1..=photo_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE photos SET trip_id = ?1 WHERE id IN ({placeholders})"
        );
        let mut upd = conn.prepare_cached(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> =
            Vec::with_capacity(1 + photo_ids.len());
        params.push(Box::new(trip_id));
        for pid in &photo_ids {
            params.push(Box::new(*pid));
        }
        upd.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;
    }

    Ok(trip_ids)
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

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
    fn auto_group_creates_suggested_trips() {
        let conn = mem_db();
        insert(&conn, "/a.jpg", Some(0));
        let trip_ids = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();
        let trip = get_trip(&conn, trip_ids[0]).unwrap().unwrap();
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
        let trip_ids = auto_group_trips(&conn, gap).unwrap();
        assert_eq!(trip_ids.len(), 2, "expected exactly 2 trips");

        let t1 = get_trip(&conn, trip_ids[0]).unwrap().unwrap();
        let t2 = get_trip(&conn, trip_ids[1]).unwrap().unwrap();
        assert_eq!(t1.photo_count, 2);
        assert_eq!(t2.photo_count, 2);
    }

    #[test]
    fn auto_group_with_no_photos_returns_empty() {
        let conn = mem_db();
        let trip_ids = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();
        assert!(trip_ids.is_empty());
    }

    #[test]
    fn auto_group_excludes_untimed_photos() {
        let conn = mem_db();
        insert(&conn, "/timed.jpg", Some(1_000_000));
        insert(&conn, "/untimed.jpg", None);

        let trip_ids = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();
        assert_eq!(trip_ids.len(), 1);
        let trip = get_trip(&conn, trip_ids[0]).unwrap().unwrap();
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

        let ids1 = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();
        let ids2 = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();

        // Same number of trips; old trips are gone.
        assert_eq!(ids1.len(), ids2.len());
        // First-run trip IDs are no longer valid.
        assert!(get_trip(&conn, ids1[0]).unwrap().is_none());
        // New trips are valid.
        assert!(get_trip(&conn, ids2[0]).unwrap().is_some());
    }

    #[test]
    fn auto_group_single_photo_creates_one_trip() {
        let conn = mem_db();
        insert(&conn, "/solo.jpg", Some(1_700_000_000));
        let trip_ids = auto_group_trips(&conn, DEFAULT_GAP_SECONDS).unwrap();
        assert_eq!(trip_ids.len(), 1);
        let trip = get_trip(&conn, trip_ids[0]).unwrap().unwrap();
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

        let trip_ids = auto_group_trips(&conn, 6 * 3600).unwrap();
        assert_eq!(trip_ids.len(), 2);
        let names: Vec<String> = trip_ids
            .iter()
            .map(|id| get_trip(&conn, *id).unwrap().unwrap().name)
            .collect();
        assert_eq!(names[0], "Trip 2024-01-01");
        assert_eq!(names[1], "Trip 2024-01-01 (2)");
    }
}

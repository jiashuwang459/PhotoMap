use rusqlite::{Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::schema::{ALL_MIGRATIONS, ADD_COLUMN_FILE_HASH};

// ──────────────────────────────────────────────────────────────────────────────
// Error type
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

// Make DbError serialisable so Tauri can forward it to the frontend as a JSON
// string.
impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────────────────

/// A single photo record returned by queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    pub id: i64,
    pub file_path: String,
    /// Unix epoch seconds (UTC).  `None` when no EXIF date is available.
    pub timestamp: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub thumbnail_path: Option<String>,
    pub blur_score: Option<f64>,
    pub trip_id: Option<i64>,
    /// SHA-256 hex digest of the file's raw bytes.  `None` until the
    /// background scanner has processed the file.  The scanner compares
    /// this value against a freshly computed digest to detect content
    /// changes (modified files) and uses its absence to identify files
    /// that have never been hashed (new files added since last scan).
    pub file_hash: Option<String>,
}

/// Input for inserting / upserting a photo record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertPhoto {
    pub file_path: String,
    pub timestamp: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub thumbnail_path: Option<String>,
    pub blur_score: Option<f64>,
    pub trip_id: Option<i64>,
    /// SHA-256 hex digest of the file's raw bytes; `None` when not yet computed.
    pub file_hash: Option<String>,
}

/// Pagination cursor used by all list queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    /// Maximum number of rows to return (capped at 500 internally).
    pub limit: u32,
    /// Row offset for keyset-style pagination.
    pub offset: u32,
}

impl Page {
    const MAX_LIMIT: u32 = 500;

    pub fn clamped_limit(&self) -> u32 {
        self.limit.min(Self::MAX_LIMIT)
    }
}

/// Bounding box for spatial queries (decimal degrees, WGS-84).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

// ──────────────────────────────────────────────────────────────────────────────
// Database initialisation
// ──────────────────────────────────────────────────────────────────────────────

/// Apply all DDL migrations to an open connection.
///
/// This is idempotent: all `CREATE` statements use `IF NOT EXISTS`, and
/// `ALTER TABLE … ADD COLUMN` migrations are guarded by a `PRAGMA
/// table_info` check so they are safe to re-run on any SQLite version.
pub fn run_migrations(conn: &Connection) -> SqlResult<()> {
    for sql in ALL_MIGRATIONS {
        conn.execute_batch(sql)?;
    }
    // Column additions introduced after the initial schema.  We use
    // PRAGMA table_info rather than `ADD COLUMN IF NOT EXISTS` for
    // compatibility with SQLite < 3.37.
    let (table, column, type_def) = ADD_COLUMN_FILE_HASH;
    add_column_if_missing(conn, table, column, type_def)?;
    Ok(())
}

/// Add `column` to `table` only if it does not already exist.
///
/// Uses `PRAGMA table_info` which is available in all SQLite versions
/// supported by rusqlite's bundled build.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    type_def: &str,
) -> SqlResult<()> {
    let sql = format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let exists: bool = conn
        .query_row(&sql, rusqlite::params![column], |row| row.get::<_, i64>(0))
        .map(|n| n > 0)?;
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {type_def};"
        ))?;
    }
    Ok(())
}

/// Open a connection with recommended performance settings for a
/// read-heavy desktop workload, then run all migrations.
pub fn open(path: &str) -> Result<Connection, DbError> {
    let conn = Connection::open(path)?;

    // WAL mode: writers don't block readers; readers don't block writers.
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    // Synchronous = NORMAL gives a good durability / throughput trade-off for
    // desktop use (data survives application crashes; OS crash may lose the
    // last committed transaction, acceptable here).
    conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
    // Increase the page cache to ~16 MB (default is ~2 MB) to keep hot index
    // pages in memory for 100k-row workloads.
    conn.execute_batch("PRAGMA cache_size = -16384;")?;
    // Store temporary tables in memory for fast sort/filter operations.
    conn.execute_batch("PRAGMA temp_store = MEMORY;")?;
    // Enable foreign-key enforcement.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    run_migrations(&conn)?;
    Ok(conn)
}

// ──────────────────────────────────────────────────────────────────────────────
// Writes
// ──────────────────────────────────────────────────────────────────────────────

/// Insert or update a photo record (upsert on `file_path`).
///
/// If a row with the same `file_path` already exists every column except
/// `id` is updated in place.  This makes the operation idempotent and safe
/// to call from the background scanner on re-runs.
pub fn upsert_photo(conn: &Connection, photo: &InsertPhoto) -> Result<i64, DbError> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO photos (
             file_path, timestamp, latitude, longitude,
             thumbnail_path, blur_score, trip_id, file_hash
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(file_path) DO UPDATE SET
             timestamp      = excluded.timestamp,
             latitude       = excluded.latitude,
             longitude      = excluded.longitude,
             thumbnail_path = excluded.thumbnail_path,
             blur_score     = excluded.blur_score,
             trip_id        = excluded.trip_id,
             file_hash      = excluded.file_hash
         RETURNING id",
    )?;

    let id: i64 = stmt.query_row(
        rusqlite::params![
            photo.file_path,
            photo.timestamp,
            photo.latitude,
            photo.longitude,
            photo.thumbnail_path,
            photo.blur_score,
            photo.trip_id,
            photo.file_hash,
        ],
        |row| row.get(0),
    )?;

    Ok(id)
}

// ──────────────────────────────────────────────────────────────────────────────
// Reads — time-range query
// ──────────────────────────────────────────────────────────────────────────────

/// Return photos whose timestamp falls within [`start_ts`, `end_ts`] (inclusive),
/// ordered by timestamp ascending.
///
/// Uses the `idx_photos_timestamp` partial index — no full table scan.
/// Results are paginated; callers must iterate with increasing `page.offset`
/// until fewer than `page.limit` rows are returned.
pub fn query_by_time_range(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    page: &Page,
) -> Result<Vec<Photo>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_path, timestamp, latitude, longitude,
                thumbnail_path, blur_score, trip_id, file_hash
         FROM   photos
         WHERE  timestamp BETWEEN ?1 AND ?2
         ORDER  BY timestamp ASC
         LIMIT  ?3 OFFSET ?4",
    )?;

    let photos = stmt
        .query_map(
            rusqlite::params![start_ts, end_ts, page.clamped_limit(), page.offset],
            map_row,
        )?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(photos)
}

// ──────────────────────────────────────────────────────────────────────────────
// Reads — bounding-box spatial query
// ──────────────────────────────────────────────────────────────────────────────

/// Return photos whose GPS coordinates fall within the given bounding box,
/// ordered by timestamp ascending (NULL timestamps come last).
///
/// Uses the `idx_photos_lat_lon` composite partial index.  SQLite's query
/// planner will use the `lat` component to prune rows before evaluating `lon`,
/// which is efficient for viewport-sized boxes.
///
/// Results are paginated; the caller should iterate with increasing
/// `page.offset` until fewer than `page.limit` rows are returned.
pub fn query_by_bounding_box(
    conn: &Connection,
    bbox: &BoundingBox,
    page: &Page,
) -> Result<Vec<Photo>, DbError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_path, timestamp, latitude, longitude,
                thumbnail_path, blur_score, trip_id, file_hash
         FROM   photos
         WHERE  latitude  BETWEEN ?1 AND ?2
           AND  longitude BETWEEN ?3 AND ?4
         ORDER  BY timestamp ASC NULLS LAST
         LIMIT  ?5 OFFSET ?6",
    )?;

    let photos = stmt
        .query_map(
            rusqlite::params![
                bbox.min_lat,
                bbox.max_lat,
                bbox.min_lon,
                bbox.max_lon,
                page.clamped_limit(),
                page.offset,
            ],
            map_row,
        )?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(photos)
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

fn map_row(row: &rusqlite::Row<'_>) -> SqlResult<Photo> {
    Ok(Photo {
        id: row.get(0)?,
        file_path: row.get(1)?,
        timestamp: row.get(2)?,
        latitude: row.get(3)?,
        longitude: row.get(4)?,
        thumbnail_path: row.get(5)?,
        blur_score: row.get(6)?,
        trip_id: row.get(7)?,
        file_hash: row.get(8)?,
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        open(":memory:").expect("open in-memory DB")
    }

    fn insert_sample(conn: &Connection, file: &str, ts: Option<i64>, lat: Option<f64>, lon: Option<f64>) -> i64 {
        upsert_photo(
            conn,
            &InsertPhoto {
                file_path: file.to_string(),
                timestamp: ts,
                latitude: lat,
                longitude: lon,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: None,
            },
        )
        .expect("upsert")
    }

    #[test]
    fn migrations_are_idempotent() {
        let conn = mem_db();
        // Running migrations twice must not fail.
        run_migrations(&conn).expect("second migration run");
    }

    #[test]
    fn upsert_insert_and_update() {
        let conn = mem_db();
        let id1 = insert_sample(&conn, "/photos/a.jpg", Some(1_000), Some(10.0), Some(20.0));
        let id2 = insert_sample(&conn, "/photos/a.jpg", Some(2_000), Some(11.0), Some(21.0));
        // Same file_path → same row id.
        assert_eq!(id1, id2);

        // Verify updated values.
        let photos = query_by_time_range(&conn, 2_000, 2_000, &Page { limit: 10, offset: 0 })
            .expect("query");
        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0].latitude, Some(11.0));
    }

    #[test]
    fn time_range_query_returns_ordered_results() {
        let conn = mem_db();
        insert_sample(&conn, "/photos/a.jpg", Some(100), None, None);
        insert_sample(&conn, "/photos/b.jpg", Some(200), None, None);
        insert_sample(&conn, "/photos/c.jpg", Some(300), None, None);

        let page = Page { limit: 10, offset: 0 };
        let results = query_by_time_range(&conn, 100, 300, &page).expect("query");
        assert_eq!(results.len(), 3);
        assert!(results[0].timestamp < results[1].timestamp);
        assert!(results[1].timestamp < results[2].timestamp);
    }

    #[test]
    fn time_range_query_pagination() {
        let conn = mem_db();
        for i in 0i64..10 {
            insert_sample(&conn, &format!("/photos/{i}.jpg"), Some(i * 100), None, None);
        }

        let page1 = query_by_time_range(&conn, 0, 900, &Page { limit: 4, offset: 0 }).expect("p1");
        let page2 = query_by_time_range(&conn, 0, 900, &Page { limit: 4, offset: 4 }).expect("p2");
        let page3 = query_by_time_range(&conn, 0, 900, &Page { limit: 4, offset: 8 }).expect("p3");

        assert_eq!(page1.len(), 4);
        assert_eq!(page2.len(), 4);
        assert_eq!(page3.len(), 2);
    }

    #[test]
    fn bounding_box_query() {
        let conn = mem_db();
        // Inside box (lat 10–20, lon 10–20)
        insert_sample(&conn, "/photos/inside.jpg",  Some(1), Some(15.0), Some(15.0));
        // Outside box
        insert_sample(&conn, "/photos/outside.jpg", Some(2), Some(50.0), Some(50.0));
        // No GPS
        insert_sample(&conn, "/photos/no_gps.jpg",  Some(3), None,       None);

        let bbox = BoundingBox { min_lat: 10.0, max_lat: 20.0, min_lon: 10.0, max_lon: 20.0 };
        let results = query_by_bounding_box(&conn, &bbox, &Page { limit: 10, offset: 0 }).expect("query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_path, "/photos/inside.jpg");
    }

    #[test]
    fn page_limit_is_capped() {
        let p = Page { limit: 9999, offset: 0 };
        assert_eq!(p.clamped_limit(), 500);
    }

    #[test]
    fn photos_without_timestamp_excluded_from_time_range() {
        let conn = mem_db();
        insert_sample(&conn, "/photos/no_ts.jpg", None, None, None);
        let results = query_by_time_range(&conn, 0, i64::MAX, &Page { limit: 10, offset: 0 }).expect("query");
        assert_eq!(results.len(), 0);
    }

    // ── file_hash tests ───────────────────────────────────────────────────────

    #[test]
    fn file_hash_stored_and_retrieved() {
        let conn = mem_db();
        let hash = "abc123def456".to_string();
        upsert_photo(
            &conn,
            &InsertPhoto {
                file_path: "/photos/hashed.jpg".to_string(),
                timestamp: Some(1_000),
                latitude: None,
                longitude: None,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: Some(hash.clone()),
            },
        )
        .expect("upsert");

        let results = query_by_time_range(&conn, 1_000, 1_000, &Page { limit: 10, offset: 0 })
            .expect("query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_hash, Some(hash));
    }

    #[test]
    fn file_hash_updated_on_upsert_detects_modification() {
        let conn = mem_db();
        let path = "/photos/changed.jpg";
        let original_hash = "aaaa".to_string();
        let new_hash = "bbbb".to_string();

        // Initial insert with original hash.
        upsert_photo(
            &conn,
            &InsertPhoto {
                file_path: path.to_string(),
                timestamp: Some(500),
                latitude: None,
                longitude: None,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: Some(original_hash),
            },
        )
        .expect("upsert");

        // Re-scan: same path, different hash (file was modified on disk).
        upsert_photo(
            &conn,
            &InsertPhoto {
                file_path: path.to_string(),
                timestamp: Some(600),
                latitude: None,
                longitude: None,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: Some(new_hash.clone()),
            },
        )
        .expect("upsert");

        let results = query_by_time_range(&conn, 600, 600, &Page { limit: 10, offset: 0 })
            .expect("query");
        assert_eq!(results.len(), 1);
        // The stored hash reflects the most recent scan.
        assert_eq!(results[0].file_hash, Some(new_hash));
    }

    #[test]
    fn file_hash_null_for_unprocessed_photos() {
        let conn = mem_db();
        insert_sample(&conn, "/photos/pending.jpg", Some(100), None, None);

        let results = query_by_time_range(&conn, 100, 100, &Page { limit: 10, offset: 0 })
            .expect("query");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_hash, None);
    }
}

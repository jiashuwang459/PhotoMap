/// Database schema SQL statements.
///
/// Schema design rationale
/// ──────────────────────
/// The `photos` table is the authoritative source for all indexed image
/// metadata.  Every heavy-read query (timeline, map viewport, trip grouping)
/// is served through dedicated covering indexes so that SQLite never needs
/// to perform a full table scan.
///
/// Index strategy
/// ──────────────
/// 1. `idx_photos_timestamp`
///    Covers time-range queries (ORDER BY timestamp).  A partial index
///    restricted to rows where `timestamp IS NOT NULL` keeps it small; photos
///    that have no EXIF date are excluded from timeline queries automatically.
///
/// 2. `idx_photos_lat_lon`
///    Covers bounding-box spatial queries (WHERE lat BETWEEN ? AND ? AND lon
///    BETWEEN ? AND ?).  Because SQLite does not support R-Tree on ordinary
///    tables, we use a composite B-Tree index on (lat, lon).  For the expected
///    workload – viewport queries that usually span ≤10° in each dimension –
///    the index on `lat` prunes the row set dramatically; the `lon` column
///    further refines it within the same leaf pages.  A partial index
///    restricted to rows where both columns are NOT NULL avoids storing
///    NULLs.
///
/// 3. `idx_photos_trip_id`
///    Covers trip-grouping queries ("give me all photos in trip X, ordered by
///    timestamp").  The index is sparse (partial on trip_id IS NOT NULL) so
///    that ungrouped photos do not pollute it.
///
/// 4. `idx_photos_file_path` (UNIQUE)
///    Enforced by the UNIQUE constraint on the column; SQLite implicitly
///    creates a unique index.  Used for idempotent upserts.
///
/// All indexes are created with `IF NOT EXISTS` so the migration is safe to
/// re-run.

pub const CREATE_PHOTOS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS photos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path      TEXT    NOT NULL UNIQUE,
    timestamp      INTEGER,             -- Unix epoch seconds (UTC); nullable when EXIF absent
    latitude       REAL,                -- WGS-84 decimal degrees; nullable
    longitude      REAL,                -- WGS-84 decimal degrees; nullable
    thumbnail_path TEXT,               -- Absolute path to cached thumbnail; nullable until generated
    blur_score     REAL,               -- Higher = sharper; nullable until computed
    trip_id        INTEGER             -- FK to trips.id; nullable until grouping runs
);
";

/// Partial index: only rows with a valid timestamp participate in timeline queries.
pub const CREATE_IDX_TIMESTAMP: &str = "
CREATE INDEX IF NOT EXISTS idx_photos_timestamp
    ON photos (timestamp)
    WHERE timestamp IS NOT NULL;
";

/// Composite spatial index on (lat, lon).  Partial: only geotagged photos.
pub const CREATE_IDX_LAT_LON: &str = "
CREATE INDEX IF NOT EXISTS idx_photos_lat_lon
    ON photos (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
";

/// Sparse trip index: only assigned photos.  Includes timestamp for ordered
/// retrieval without an extra sort step.
pub const CREATE_IDX_TRIP: &str = "
CREATE INDEX IF NOT EXISTS idx_photos_trip_id
    ON photos (trip_id, timestamp)
    WHERE trip_id IS NOT NULL;
";

/// All DDL statements in migration order.
pub const ALL_MIGRATIONS: &[&str] = &[
    CREATE_PHOTOS_TABLE,
    CREATE_IDX_TIMESTAMP,
    CREATE_IDX_LAT_LON,
    CREATE_IDX_TRIP,
];

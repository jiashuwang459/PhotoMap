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
/// 5. `idx_photos_file_hash`
///    Covers hash-based lookups used by the background scanner to detect new,
///    modified, and removed photos.  Partial (hash IS NOT NULL) so that rows
///    not yet hashed don't pollute the index.
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
    trip_id        INTEGER,            -- FK to trips.id; nullable until grouping runs
    file_hash      TEXT                -- SHA-256 hex digest of file contents; nullable until computed
);
";

/// ADD COLUMN migration for databases created before `file_hash` was
/// introduced.  Applied via `add_column_if_missing` in `run_migrations`
/// rather than directly, because `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
/// requires SQLite ≥ 3.37 and `PRAGMA table_info` is more portable.
pub const ADD_COLUMN_FILE_HASH: (&str, &str, &str) = ("photos", "file_hash", "TEXT");

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

/// Sparse hash index: only hashed photos.  Used by the scanner to look up
/// photos by content digest (detect duplicates and modifications).
pub const CREATE_IDX_FILE_HASH: &str = "
CREATE INDEX IF NOT EXISTS idx_photos_file_hash
    ON photos (file_hash)
    WHERE file_hash IS NOT NULL;
";

// ──────────────────────────────────────────────────────────────────────────────
// Trips table
// ──────────────────────────────────────────────────────────────────────────────

/// `trips` table: one row per automatically- or manually-grouped trip.
///
/// A trip is a time-bounded cluster of photos.  The background
/// `auto_group_trips` function creates trips by splitting the ordered photo
/// timeline wherever two consecutive (by timestamp) photos are more than a
/// configurable gap apart.
///
/// `cover_photo_id` is a nullable soft-reference to the photo that should be
/// displayed as the trip's representative image.
pub const CREATE_TRIPS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS trips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    start_ts       INTEGER,  -- Unix epoch seconds of the earliest photo in the trip
    end_ts         INTEGER,  -- Unix epoch seconds of the latest photo in the trip
    cover_photo_id INTEGER   -- Soft-ref to photos.id; null until set
);
";

/// Index for looking up trips ordered by start time (timeline view).
pub const CREATE_IDX_TRIPS_START_TS: &str = "
CREATE INDEX IF NOT EXISTS idx_trips_start_ts
    ON trips (start_ts)
    WHERE start_ts IS NOT NULL;
";

/// ADD COLUMN migration: `is_confirmed` was added to the `trips` table in
/// phase 6.  Databases created in phase 5 (before this column existed) need
/// this `ALTER TABLE` migration applied at startup.
///
/// `0` = suggested (auto-grouped, pending user review);
/// `1` = confirmed (user accepted).
pub const ADD_COLUMN_TRIPS_IS_CONFIRMED: (&str, &str, &str) =
    ("trips", "is_confirmed", "INTEGER NOT NULL DEFAULT 0");

/// All DDL statements in migration order.
pub const ALL_MIGRATIONS: &[&str] = &[
    CREATE_PHOTOS_TABLE,
    CREATE_IDX_TIMESTAMP,
    CREATE_IDX_LAT_LON,
    CREATE_IDX_TRIP,
    CREATE_IDX_FILE_HASH,
    CREATE_TRIPS_TABLE,
    CREATE_IDX_TRIPS_START_TS,
];

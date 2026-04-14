use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

use photomap_core::{
    upsert_photo, query_by_time_range, query_by_bounding_box, query_all_photos,
    get_photo_by_path, delete_photo_by_path, scan_directory,
    create_trip, list_trips, get_trip, delete_trip,
    query_photos_by_trip, auto_group_trips,
    BoundingBox, DbError, InsertPhoto, Page, Photo, ScanError, ScanReport, Trip,
};

// ──────────────────────────────────────────────────────────────────────────────
// Managed state
// ──────────────────────────────────────────────────────────────────────────────

/// Thread-safe wrapper around the single SQLite connection.
///
/// Using a `Mutex<Connection>` is appropriate here because rusqlite's
/// `Connection` is not `Send + Sync`, and our workload is read-heavy with
/// short-lived queries.  For higher write concurrency (future phases) this
/// can be replaced with a connection pool (e.g. `r2d2-sqlite`).
pub struct DbState(pub Mutex<Connection>);

// ──────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────────────────────

/// Insert or update a photo record in the database.
///
/// This command is idempotent: calling it twice with the same `file_path`
/// updates the existing row rather than inserting a duplicate.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_upsert_photo(state: State<'_, DbState>, photo: InsertPhoto) -> Result<i64, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    upsert_photo(&conn, &photo)
}

/// Query photos whose timestamp falls within [`start_ts`, `end_ts`] (Unix
/// epoch seconds, inclusive), ordered by timestamp ascending.
///
/// Results are paginated.  Pass increasing `page.offset` values and stop when
/// the returned slice is shorter than `page.limit`.
#[tauri::command]
pub fn cmd_query_by_time_range(
    state: State<'_, DbState>,
    start_ts: i64,
    end_ts: i64,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_by_time_range(&conn, start_ts, end_ts, &page)
}

/// Query photos whose GPS coordinates fall within the given bounding box,
/// ordered by timestamp ascending (ungeotagged photos are excluded).
///
/// Results are paginated.  Pass increasing `page.offset` values and stop when
/// the returned slice is shorter than `page.limit`.
#[tauri::command]
pub fn cmd_query_by_bounding_box(
    state: State<'_, DbState>,
    bbox: BoundingBox,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_by_bounding_box(&conn, &bbox, &page)
}

/// Scan a directory recursively, inserting new photos, updating modified ones,
/// and removing records for deleted files.
///
/// `dir` must be an absolute path to an existing directory.  The scan runs
/// synchronously on the calling thread; for large libraries callers should
/// invoke this command from a background Tauri task.
///
/// # Errors
/// Returns a string representation of the error if `dir` is not a directory
/// or a fatal I/O or database error occurs.  Per-file errors are collected
/// inside the returned [`ScanReport`] and do not abort the scan.
#[tauri::command]
pub fn cmd_scan_directory(state: State<'_, DbState>, dir: String) -> Result<ScanReport, ScanError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    println!("Scanning directory: {}", dir);
    scan_directory(&conn, Path::new(&dir))
}

/// Delete the photo record with the given `file_path`.
///
/// Returns `true` if a row was deleted, `false` if no such row existed.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_delete_photo(state: State<'_, DbState>, file_path: String) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    delete_photo_by_path(&conn, &file_path)
}

/// Return all photos ordered by timestamp ascending (NULL timestamps last),
/// then by file path.
///
/// Results are paginated.  Pass increasing `page.offset` values and stop when
/// the returned slice is shorter than `page.limit`.
#[tauri::command]
pub fn cmd_query_all_photos(state: State<'_, DbState>, page: Page) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_all_photos(&conn, &page)
}

/// Look up a single photo record by its absolute file path.
///
/// Returns `None` (serialised as JSON `null`) when no record exists for the
/// given path.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_get_photo_by_path(
    state: State<'_, DbState>,
    file_path: String,
) -> Result<Option<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    get_photo_by_path(&conn, &file_path)
}

// ──────────────────────────────────────────────────────────────────────────────
// Trip commands
// ──────────────────────────────────────────────────────────────────────────────

/// Return all trips ordered by start timestamp ascending, then by id.
///
/// Results are paginated.
#[tauri::command]
pub fn cmd_list_trips(
    state: State<'_, DbState>,
    page: Page,
) -> Result<Vec<Trip>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    list_trips(&conn, &page)
}

/// Return the trip with the given `trip_id`, or `null` if it does not exist.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_get_trip(
    state: State<'_, DbState>,
    trip_id: i64,
) -> Result<Option<Trip>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    get_trip(&conn, trip_id)
}

/// Create a new trip with the given name and optional time bounds.
///
/// Returns the id of the newly created trip.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_create_trip(
    state: State<'_, DbState>,
    name: String,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
) -> Result<i64, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    create_trip(&conn, &name, start_ts, end_ts)
}

/// Delete the trip with the given id.
///
/// Photos belonging to the trip have their `trip_id` set to `null` (they are
/// not removed from the library).
///
/// Returns `true` if a trip was deleted, `false` if none existed.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_delete_trip(
    state: State<'_, DbState>,
    trip_id: i64,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    delete_trip(&conn, trip_id)
}

/// Return all photos assigned to the given trip, ordered by timestamp ascending.
///
/// Results are paginated.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_query_photos_by_trip(
    state: State<'_, DbState>,
    trip_id: i64,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_photos_by_trip(&conn, trip_id, &page)
}

/// Cluster all timestamped photos into trips using a temporal-gap algorithm.
///
/// A new trip boundary is created whenever two consecutive photos (ordered by
/// timestamp) are more than `gap_seconds` apart.  Existing trips are cleared
/// before new ones are written, making this operation idempotent.
///
/// Photos without a timestamp are left ungrouped.
///
/// Returns the list of newly created trip ids.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_auto_group_trips(
    state: State<'_, DbState>,
    gap_seconds: i64,
) -> Result<Vec<i64>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    auto_group_trips(&conn, gap_seconds)
}

use std::sync::Mutex;
use std::path::Path;
use rusqlite::Connection;
use tauri::State;

use photomap_core::{
    upsert_photo, query_by_time_range, query_by_bounding_box, query_all_photos,
    delete_photo_by_path, scan_directory,
    BoundingBox, DbError, InsertPhoto, Page, Photo, ScanError, ScanReport,
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
pub fn cmd_upsert_photo(
    state: State<'_, DbState>,
    photo: InsertPhoto,
) -> Result<i64, DbError> {
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
pub fn cmd_scan_directory(
    state: State<'_, DbState>,
    dir: String,
) -> Result<ScanReport, ScanError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    scan_directory(&conn, Path::new(&dir))
}

/// Delete the photo record with the given `file_path`.
///
/// Returns `true` if a row was deleted, `false` if no such row existed.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_delete_photo(
    state: State<'_, DbState>,
    file_path: String,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    delete_photo_by_path(&conn, &file_path)
}

/// Return all photos ordered by timestamp ascending (NULL timestamps last),
/// then by file path.
///
/// Results are paginated.  Pass increasing `page.offset` values and stop when
/// the returned slice is shorter than `page.limit`.
#[tauri::command]
pub fn cmd_query_all_photos(
    state: State<'_, DbState>,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_all_photos(&conn, &page)
}

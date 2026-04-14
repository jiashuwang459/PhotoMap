use std::sync::Mutex;
use rusqlite::Connection;
use tauri::State;

use photomap_core::{
    upsert_photo, query_by_time_range, query_by_bounding_box,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
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

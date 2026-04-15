use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use photomap_core::{
    upsert_photo, query_by_time_range, query_by_bounding_box, query_all_photos,
    get_photo_by_path, delete_photo_by_path, scan_directory,
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    suggest_photos_for_trips,
    generate_thumbnails_batch, generate_thumbnail_for_photo, query_photos_needing_review,
    BoundingBox, DbError, InsertPhoto, Page, Photo, ScanError, ScanReport, Trip,
    ThumbnailBatchReport, ThumbnailError, TripPhotoSuggestion,
};

use crate::thumbnail_worker::ThumbnailCommand;

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

/// The directory where generated thumbnails are stored.
///
/// Resolved at startup to `{app_data_dir}/thumbnails/` and stored as managed
/// state so that thumbnail commands can resolve output paths without needing
/// the Tauri `App` handle inside commands.
pub struct ThumbnailDirState(pub PathBuf);

/// Channel sender used to control the background thumbnail worker thread.
///
/// Sending [`ThumbnailCommand::Start`] starts (or restarts) the generation
/// loop; [`ThumbnailCommand::Cancel`] requests an early stop.
pub struct ThumbnailJobSender(pub Mutex<std::sync::mpsc::Sender<ThumbnailCommand>>);

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

/// Delete the photo record with the given `file_path` and remove its thumbnail
/// from disk if one exists.
///
/// Returns `true` if a row was deleted, `false` if no such row existed.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_delete_photo(state: State<'_, DbState>, file_path: String) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    match delete_photo_by_path(&conn, &file_path)? {
        Some(thumbnail_path) => {
            if let Some(thumb) = thumbnail_path {
                let _ = std::fs::remove_file(&thumb);
            }
            Ok(true)
        }
        None => Ok(false),
    }
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
/// `is_confirmed` should be `true` for manually created trips.
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
    is_confirmed: bool,
) -> Result<i64, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    create_trip(&conn, &name, start_ts, end_ts, is_confirmed)
}

/// Mark the trip as confirmed (user accepted the auto-group suggestion).
///
/// Returns `true` if the trip was found and updated, `false` if it did not
/// exist.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_confirm_trip(
    state: State<'_, DbState>,
    trip_id: i64,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    confirm_trip(&conn, trip_id)
}

/// Rename a trip.
///
/// Returns `true` if the trip was found and renamed, `false` if it did not
/// exist.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_rename_trip(
    state: State<'_, DbState>,
    trip_id: i64,
    name: String,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    rename_trip(&conn, trip_id, &name)
}

/// Assign or unassign a photo to/from a trip.
///
/// Pass `Some(trip_id)` to add the photo, or `None` to remove it from its
/// current trip.
///
/// Returns `true` if the photo record was found and updated.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_set_photo_trip(
    state: State<'_, DbState>,
    photo_id: i64,
    trip_id: Option<i64>,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    set_photo_trip(&conn, photo_id, trip_id)
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

/// Return photos not assigned to any trip, ordered by timestamp ascending.
///
/// Results are paginated.  Used to populate the "add photos" picker in the
/// trip detail view.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_query_untripped_photos(
    state: State<'_, DbState>,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_untripped_photos(&conn, &page)
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

// ──────────────────────────────────────────────────────────────────────────────
// Thumbnail commands
// ──────────────────────────────────────────────────────────────────────────────

/// Generate thumbnails for up to `batch_size` photos that do not yet have one.
///
/// Thumbnails are stored in the application data directory under `thumbnails/`.
/// Call repeatedly until [`ThumbnailBatchReport::remaining`] reaches `0` to
/// process the entire library.
///
/// # Errors
/// Returns a string error on a fatal database failure.  Per-photo errors are
/// captured in [`ThumbnailBatchReport::errors`].
#[tauri::command]
pub fn cmd_generate_thumbnails_batch(
    db_state: State<'_, DbState>,
    thumb_state: State<'_, ThumbnailDirState>,
    batch_size: u32,
) -> Result<ThumbnailBatchReport, ThumbnailError> {
    let conn = db_state.0.lock().expect("db mutex poisoned");
    generate_thumbnails_batch(&conn, &thumb_state.0, batch_size)
}

/// Return photos that have been flagged for manual review because thumbnail
/// generation exceeded the maximum retry count.
///
/// Results are ordered by `file_path` and paginated.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_query_photos_needing_review(
    state: State<'_, DbState>,
    page: Page,
) -> Result<Vec<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    query_photos_needing_review(&conn, &page)
}

/// Generate (or re-generate) a thumbnail for a single photo identified by
/// `photo_id`, ignoring any retry limits or review flags.
///
/// This command is intended for manual invocation from the photo viewer UI,
/// allowing the user to retry a previously failed photo or generate a thumbnail
/// on demand.
///
/// Returns the absolute path of the newly written thumbnail file.
///
/// # Errors
/// Returns a string error if the photo does not exist or thumbnail generation
/// fails.
#[tauri::command]
pub fn cmd_generate_thumbnail_for_photo(
    db_state: State<'_, DbState>,
    thumb_state: State<'_, ThumbnailDirState>,
    photo_id: i64,
) -> Result<String, ThumbnailError> {
    let conn = db_state.0.lock().expect("db mutex poisoned");
    generate_thumbnail_for_photo(&conn, &thumb_state.0, photo_id)
}

/// Find untripped photos whose timestamps fall within confirmed trip windows.
///
/// Returns one [`TripPhotoSuggestion`] per confirmed trip that has at least
/// one eligible photo.  The caller can then decide to add the suggested photos
/// to the trip via [`cmd_set_photo_trip`].
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_suggest_photos_for_trips(
    state: State<'_, DbState>,
) -> Result<Vec<TripPhotoSuggestion>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    suggest_photos_for_trips(&conn)
}

// ──────────────────────────────────────────────────────────────────────────────
// Background thumbnail worker commands
// ──────────────────────────────────────────────────────────────────────────────

/// Start (or restart) the background thumbnail-generation worker.
///
/// The worker runs on a dedicated OS thread and emits Tauri events as it
/// progresses:
///
/// * `thumbnail_progress` — [`crate::thumbnail_worker::ThumbnailProgress`]
/// * `thumbnail_done`     — [`crate::thumbnail_worker::ThumbnailDone`]
/// * `thumbnail_error`    — `String`
///
/// Calling this command while the worker is already running causes it to
/// restart from the beginning (useful after a new scan adds more photos).
///
/// # Errors
/// Returns an error string if the worker channel has been unexpectedly
/// disconnected.
#[tauri::command]
pub fn cmd_start_thumbnail_worker(
    state: State<'_, ThumbnailJobSender>,
    batch_size: u32,
) -> Result<(), String> {
    state
        .0
        .lock()
        .expect("thumbnail job sender mutex poisoned")
        .send(ThumbnailCommand::Start { batch_size })
        .map_err(|e| e.to_string())
}

/// Request that the background thumbnail-generation worker stop after its
/// current batch completes.
///
/// A `thumbnail_done` event with `cancelled: true` will be emitted once the
/// worker has actually stopped.
///
/// # Errors
/// Returns an error string if the worker channel has been unexpectedly
/// disconnected.
#[tauri::command]
pub fn cmd_cancel_thumbnail_worker(
    state: State<'_, ThumbnailJobSender>,
) -> Result<(), String> {
    state
        .0
        .lock()
        .expect("thumbnail job sender mutex poisoned")
        .send(ThumbnailCommand::Cancel)
        .map_err(|e| e.to_string())
}

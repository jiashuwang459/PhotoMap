use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use photomap_core::{
    upsert_photo, query_by_time_range, query_by_bounding_box, query_all_photos,
    get_photo_by_path, get_photo_by_id, delete_photo_by_path, scan_directory,
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip, set_trip_cover_photo,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    delete_all_suggested_trips,
    suggest_photos_for_trips,
    generate_thumbnail_for_photo, query_photos_needing_review,
    delete_thumbnail, clear_all_thumbnails,
    get_home_location, set_home_location,
    infer_and_save_home_location,
    list_home_transitions, create_home_transition,
    confirm_home_transition, dismiss_home_transition,
    detect_home_transitions,
    BoundingBox, DbError, InsertPhoto, Page, Photo, ScanError, ScanReport, Trip,
    ThumbnailBatchReport, ThumbnailError, TripPhotoSuggestion, TripGroupResult,
    AutoGroupDefaults,
    HomeLocation, HomeTransition,
    get_auto_group_defaults,
    DEFAULT_MIN_TRIP_KM,
};
use photomap_core::thumbnail::{generate_thumbnail, thumbnail_path_for, MAX_THUMB_RETRIES, ThumbnailEntryError};

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

/// Return a single photo by its database id, or `null` / `None` if not found.
///
/// # Errors
/// Returns the database error string on failure.
#[tauri::command]
pub fn cmd_get_photo_by_id(
    state: State<'_, DbState>,
    photo_id: i64,
) -> Result<Option<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    get_photo_by_id(&conn, photo_id)
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

/// Set (or clear) the cover photo for a trip.
///
/// `photo_id` must be a photo that already belongs to `trip_id`.  Passing
/// `None` clears the cover.  Returns `true` on success, `false` when the trip
/// or photo is not found or the photo does not belong to the trip.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_set_trip_cover_photo(
    state: State<'_, DbState>,
    trip_id: i64,
    photo_id: Option<i64>,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    set_trip_cover_photo(&conn, trip_id, photo_id)
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

/// Cluster all timestamped photos into trips using a combined temporal-gap,
/// geographic-displacement, and photo-density algorithm.
///
/// A new trip boundary is created whenever two consecutive photos (ordered by
/// timestamp) are more than `gap_seconds` apart, or when both photos have GPS
/// coordinates that are more than 500 km apart.
///
/// When a home location is stored, clusters whose GPS centroid is within
/// `min_trip_km` km of home are only kept if their daily photo density
/// exceeds the library baseline by 3× (capturing dense local outings such as
/// day hikes while discarding routine home snapshots).  Pass `min_trip_km = 0`
/// to disable the home filter.
///
/// Existing unconfirmed (suggested) trips are cleared before new ones are
/// written, making this operation idempotent.  Confirmed trips are never
/// touched.  Photos without a timestamp are left ungrouped.
///
/// Returns a [`TripGroupResult`] for each newly created trip, including the
/// GPS centroid of the cluster so the frontend can perform reverse-geocoding.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_auto_group_trips(
    state: State<'_, DbState>,
    gap_seconds: i64,
    min_trip_km: f64,
    geo_split_km: f64,
    home_density_multiplier: f64,
    min_photos: u32,
) -> Result<Vec<TripGroupResult>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    auto_group_trips(&conn, gap_seconds, min_trip_km, geo_split_km, home_density_multiplier, min_photos)
}

/// Return the compile-time default values for every [`cmd_auto_group_trips`]
/// parameter so the frontend can initialise its controls without hard-coding
/// the numbers.
#[tauri::command]
pub fn cmd_get_auto_group_defaults() -> AutoGroupDefaults {
    get_auto_group_defaults()
}

/// Delete all unconfirmed (suggested) trips in one operation.
///
/// Photos that belonged to those trips have their `trip_id` set to `null`;
/// they are **not** removed from the library.
///
/// Returns the count of trips that were deleted.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_delete_all_suggested_trips(
    state: State<'_, DbState>,
) -> Result<u64, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    delete_all_suggested_trips(&conn)
}

// ──────────────────────────────────────────────────────────────────────────────
// Home location commands
// ──────────────────────────────────────────────────────────────────────────────

/// Return the stored home location, or `null` if none has been set.
///
/// The home location is used by [`cmd_auto_group_trips`] to distinguish away
/// trips (far from home) from everyday home snapshots.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_get_home_location(
    state: State<'_, DbState>,
) -> Result<Option<HomeLocation>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    get_home_location(&conn)
}

/// Persist a home location (overwrites any existing value).
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_set_home_location(
    state: State<'_, DbState>,
    lat: f64,
    lon: f64,
) -> Result<(), DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    set_home_location(&conn, lat, lon)
}

/// Infer the home location from the photo library and persist it.
///
/// Bins all GPS-tagged photos into a coarse ~10 km grid and returns the
/// centroid of the most-populated cell.  Requires at least 5 GPS-tagged
/// photos; returns `null` when the library is too small to make a reliable
/// inference.
///
/// The inferred location is automatically saved so subsequent calls to
/// [`cmd_auto_group_trips`] can use it.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_infer_home_location(
    state: State<'_, DbState>,
) -> Result<Option<HomeLocation>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    infer_and_save_home_location(&conn)
}

// ──────────────────────────────────────────────────────────────────────────────
// Home transition (move event) commands
// ──────────────────────────────────────────────────────────────────────────────

/// Return all home transitions ordered by transition date ascending.
///
/// Includes both confirmed (user-accepted) and unconfirmed (auto-detected)
/// transitions.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_list_home_transitions(
    state: State<'_, DbState>,
) -> Result<Vec<HomeTransition>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    list_home_transitions(&conn)
}

/// Analyse the photo timeline for sustained location shifts and populate
/// the `home_transitions` table with newly detected move events.
///
/// Previously detected **unconfirmed** transitions are replaced; **confirmed**
/// ones are preserved.  Returns the full list of transitions after the update.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_detect_home_transitions(
    state: State<'_, DbState>,
) -> Result<Vec<HomeTransition>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    detect_home_transitions(&conn)
}

/// Mark a home transition as confirmed (user accepted the detected move).
///
/// Returns `true` if the transition was found and updated.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_confirm_home_transition(
    state: State<'_, DbState>,
    id: i64,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    confirm_home_transition(&conn, id)
}

/// Delete a home transition (user rejected the detected move).
///
/// Returns `true` if the transition was found and deleted.
///
/// # Errors
/// Returns a string representation of the database error on failure.
#[tauri::command]
pub fn cmd_dismiss_home_transition(
    state: State<'_, DbState>,
    id: i64,
) -> Result<bool, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    dismiss_home_transition(&conn, id)
}

/// Insert a new confirmed home-transition record and return it.
///
/// Creates a manual "moved to" event that is immediately confirmed and
/// honoured by [`cmd_auto_group_trips`] when determining what counts as
/// an away trip.
#[tauri::command]
pub fn cmd_create_home_transition(
    state: State<'_, DbState>,
    transition_ts: i64,
    new_lat: f64,
    new_lon: f64,
) -> Result<HomeTransition, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    create_home_transition(&conn, transition_ts, new_lat, new_lon)
}

/// Return the default `min_trip_km` threshold used by [`cmd_auto_group_trips`].
///
/// Convenience constant so the frontend can initialise its slider without
/// hard-coding the value.
#[tauri::command]
pub fn cmd_get_default_min_trip_km() -> f64 {
    DEFAULT_MIN_TRIP_KM
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
pub async fn cmd_generate_thumbnails_batch(
    db_state: State<'_, DbState>,
    thumb_state: State<'_, ThumbnailDirState>,
    batch_size: u32,
) -> Result<ThumbnailBatchReport, ThumbnailError> {
    // 1) Select a batch of candidate rows while holding the DB lock,
    // then release the lock and perform heavy image work in the blocking task.
    struct Row {
        id: i64,
        file_path: String,
        retry_count: i64,
    }

    let rows_to_process: Vec<Row> = {
        let conn = db_state.0.lock().expect("db mutex poisoned");
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, file_path, thumbnail_retry_count
                 FROM   photos
                 WHERE  thumbnail_path IS NULL
                   AND  thumbnail_needs_review = 0
                   AND  thumbnail_retry_count < ?1
                 LIMIT  ?2",
            )
            .map_err(DbError::from)?;

        let rows = stmt
            .query_map(rusqlite::params![MAX_THUMB_RETRIES, batch_size], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    retry_count: row.get(2)?,
                })
            })
            .map_err(DbError::from)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::from)?;

        drop(stmt);
        rows
    };

    let thumb_dir = thumb_state.0.clone();

    // 2) Run the image decode/resize/write work on a blocking thread.
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let mut results: Vec<(i64, String, Result<String, String>, i64)> = Vec::with_capacity(rows_to_process.len());
        for r in rows_to_process {
            let file_path = r.file_path.clone();
            let out_path = thumbnail_path_for(&thumb_dir, r.id);
            match generate_thumbnail(std::path::Path::new(&file_path), &out_path) {
                Ok(()) => results.push((r.id, file_path, Ok(out_path.to_string_lossy().into_owned()), r.retry_count)),
                Err(e) => results.push((r.id, file_path, Err(e.to_string()), r.retry_count)),
            }
        }
        results
    });

    let work_results = worker.await.map_err(|je| ThumbnailError::HeicDecode(format!("thumbnail worker join error: {}", je)))?;

    // 3) Apply DB updates based on worker results.
    let mut report = ThumbnailBatchReport {
        processed: 0,
        remaining: 0,
        needs_review_count: 0,
        errors: Vec::new(),
    };

    {
        let conn = db_state.0.lock().expect("db mutex poisoned");

        let mut update_success = conn
            .prepare_cached(
                "UPDATE photos
                 SET    thumbnail_path = ?1, thumbnail_retry_count = 0
                 WHERE  id = ?2",
            )
            .map_err(DbError::from)?;

        let mut update_failure = conn
            .prepare_cached(
                "UPDATE photos
                 SET    thumbnail_retry_count  = ?1,
                        thumbnail_needs_review = ?2
                 WHERE  id = ?3",
            )
            .map_err(DbError::from)?;

        for (id, file_path, res, old_retry) in work_results {
            match res {
                Ok(path_str) => {
                    update_success.execute(rusqlite::params![path_str, id]).map_err(DbError::from)?;
                    report.processed += 1;
                }
                Err(err_msg) => {
                    let new_count = old_retry + 1;
                    let needs_review = i64::from(new_count >= MAX_THUMB_RETRIES);
                    update_failure
                        .execute(rusqlite::params![new_count, needs_review, id])
                        .map_err(DbError::from)?;
                    if needs_review == 1 {
                        report.needs_review_count += 1;
                    }
                    report.errors.push(ThumbnailEntryError {
                        photo_id: id,
                        file_path,
                        message: err_msg,
                        retry_count: new_count,
                        needs_review: needs_review == 1,
                    });
                }
            }
        }

        // Count remaining processable photos.
        let remaining: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM photos
                 WHERE  thumbnail_path IS NULL
                   AND  thumbnail_needs_review = 0
                   AND  thumbnail_retry_count < ?1",
                rusqlite::params![MAX_THUMB_RETRIES],
                |row| row.get(0),
            )
            .map_err(DbError::from)?;
        report.remaining = remaining;
    }

    Ok(report)
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

// ──────────────────────────────────────────────────────────────────────────────
// Thumbnail delete commands
// ──────────────────────────────────────────────────────────────────────────────

/// Clear the thumbnail for a single photo by its `photo_id`.
///
/// Deletes the thumbnail file from disk (best-effort), resets
/// `thumbnail_retry_count` and `thumbnail_needs_review` so the background
/// worker will regenerate it on the next run, and returns the updated
/// [`Photo`] record.
///
/// # Errors
/// Returns the database error if the update fails.  Returns `None` in the
/// `Ok` variant if no photo with the given id exists.
#[tauri::command]
pub fn cmd_delete_thumbnail(
    state: State<'_, DbState>,
    photo_id: i64,
) -> Result<Option<Photo>, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    if let Some(old_path) = delete_thumbnail(&conn, photo_id)? {
        let _ = std::fs::remove_file(&old_path);
    }
    get_photo_by_id(&conn, photo_id)
}

/// Clear thumbnails for **all** photos.
///
/// Deletes every thumbnail file from disk (best-effort) and resets the
/// thumbnail fields in the database so the background worker can regenerate
/// them.  Returns the number of thumbnails that were cleared.
///
/// # Errors
/// Returns the database error if the bulk update fails.
#[tauri::command]
pub fn cmd_clear_all_thumbnails(
    state: State<'_, DbState>,
) -> Result<u32, DbError> {
    let conn = state.0.lock().expect("db mutex poisoned");
    let paths = clear_all_thumbnails(&conn)?;
    let count = paths.len() as u32;
    for path in paths {
        let _ = std::fs::remove_file(&path);
    }
    Ok(count)
}

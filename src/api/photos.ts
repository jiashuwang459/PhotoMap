import { invoke } from "@tauri-apps/api/core";
import type { BoundingBox, InsertPhoto, Page, Photo, ScanReport, Trip, ThumbnailBatchReport, TripGroupResult, HomeLocation, HomeTransition } from "./types";

/**
 * Insert or update a photo record in the database.
 *
 * Idempotent: calling with the same `file_path` updates the existing row.
 *
 * @returns The row id of the inserted/updated photo.
 */
export async function upsertPhoto(photo: InsertPhoto): Promise<number> {
  return invoke<number>("cmd_upsert_photo", { photo });
}

/**
 * Fetch photos within a Unix-epoch timestamp range, ordered by timestamp
 * ascending.
 *
 * Paginated: increment `page.offset` by `page.limit` on each call until fewer
 * than `page.limit` results are returned.
 */
export async function queryByTimeRange(
  startTs: number,
  endTs: number,
  page: Page
): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_by_time_range", {
    startTs,
    endTs,
    page,
  });
}

/**
 * Fetch photos whose GPS coordinates fall within the given bounding box,
 * ordered by timestamp ascending.
 *
 * Paginated: increment `page.offset` by `page.limit` on each call until fewer
 * than `page.limit` results are returned.
 */
export async function queryByBoundingBox(
  bbox: BoundingBox,
  page: Page
): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_by_bounding_box", { bbox, page });
}

/**
 * Fetch all photos ordered by timestamp ascending (no timestamp → end),
 * then by file path.
 *
 * Paginated: increment `page.offset` by `page.limit` on each call until fewer
 * than `page.limit` results are returned.
 */
export async function queryAllPhotos(page: Page): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_all_photos", { page });
}

/**
 * Scan a directory recursively for image files, synchronising the database:
 * - New files are inserted.
 * - Modified files (hash changed) are updated.
 * - Records for deleted files are removed.
 *
 * @param dir Absolute path to the directory to scan.
 * @returns A {@link ScanReport} summarising what was added, updated, removed,
 *          and any per-file errors.
 */
export async function scanDirectory(dir: string): Promise<ScanReport> {
  return invoke<ScanReport>("cmd_scan_directory", { dir });
}

/**
 * Delete the photo record with the given absolute `filePath`.
 *
 * @returns `true` if a record was deleted, `false` if no such record existed.
 */
export async function deletePhoto(filePath: string): Promise<boolean> {
  return invoke<boolean>("cmd_delete_photo", { filePath });
}

/**
 * Look up a single photo record by its absolute file path.
 *
 * @returns The {@link Photo} record, or `null` if it has not been indexed.
 */
export async function getPhotoByPath(filePath: string): Promise<Photo | null> {
  return invoke<Photo | null>("cmd_get_photo_by_path", { filePath });
}

// ── Trip API ─────────────────────────────────────────────────────────────────

/**
 * Return all trips ordered by start timestamp ascending.
 *
 * Paginated: increment `page.offset` by `page.limit` on each call until fewer
 * than `page.limit` results are returned.
 */
export async function listTrips(page: Page): Promise<Trip[]> {
  return invoke<Trip[]>("cmd_list_trips", { page });
}

/**
 * Return the trip with the given `tripId`, or `null` if it does not exist.
 */
export async function getTrip(tripId: number): Promise<Trip | null> {
  return invoke<Trip | null>("cmd_get_trip", { tripId });
}

/**
 * Create a new trip with the given name and optional time bounds.
 *
 * @param isConfirmed Pass `true` for manually created trips.
 * @returns The id of the newly created trip.
 */
export async function createTrip(
  name: string,
  startTs: number | null,
  endTs: number | null,
  isConfirmed: boolean
): Promise<number> {
  return invoke<number>("cmd_create_trip", { name, startTs, endTs, isConfirmed });
}

/**
 * Mark the trip as confirmed (user accepted an auto-group suggestion).
 *
 * @returns `true` if the trip was found and updated.
 */
export async function confirmTrip(tripId: number): Promise<boolean> {
  return invoke<boolean>("cmd_confirm_trip", { tripId });
}

/**
 * Rename a trip.
 *
 * @returns `true` if the trip was found and renamed.
 */
export async function renameTrip(tripId: number, name: string): Promise<boolean> {
  return invoke<boolean>("cmd_rename_trip", { tripId, name });
}

/**
 * Assign or unassign a photo to/from a trip.
 *
 * @param tripId The trip id to assign the photo to, or `null` to unassign.
 * @returns `true` if the photo record was found and updated.
 */
export async function setPhotoTrip(
  photoId: number,
  tripId: number | null
): Promise<boolean> {
  return invoke<boolean>("cmd_set_photo_trip", { photoId, tripId });
}

/**
 * Delete the trip with the given `tripId`.
 *
 * Photos that belonged to the trip have their `trip_id` set to `null`; they
 * are not removed from the library.
 *
 * @returns `true` if a trip was deleted, `false` if none existed.
 */
export async function deleteTrip(tripId: number): Promise<boolean> {
  return invoke<boolean>("cmd_delete_trip", { tripId });
}

/**
 * Return all photos assigned to the given trip, ordered by timestamp ascending.
 *
 * Paginated: increment `page.offset` by `page.limit` on each call until fewer
 * than `page.limit` results are returned.
 */
export async function queryPhotosByTrip(
  tripId: number,
  page: Page
): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_photos_by_trip", { tripId, page });
}

/**
 * Return photos NOT assigned to any trip, ordered by timestamp ascending.
 *
 * Paginated.  Used to populate the "add photos" picker in the trip detail view.
 */
export async function queryUntrippedPhotos(page: Page): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_untripped_photos", { page });
}

/**
 * Cluster all timestamped photos into trips using a combined temporal-gap,
 * geographic-displacement, and photo-density algorithm.
 *
 * A new trip is created whenever two consecutive photos (by timestamp) are
 * more than `gapSeconds` apart, or when both have GPS coords more than 500 km
 * apart.
 *
 * When a home location is stored, clusters whose centroid is within
 * `minTripKm` km of home are only kept if their photo density exceeds the
 * library baseline by 3× (day hikes, local outings).  Pass `minTripKm = 0`
 * to disable the home filter.
 *
 * Existing unconfirmed trips are cleared first, making this operation
 * idempotent.  Photos without a timestamp are left ungrouped.
 *
 * @param gapSeconds   Gap threshold in seconds (default: 3 days = 259 200).
 * @param minTripKm    Min distance from home (km) to always qualify as a trip
 *                     (default: 50).  Pass 0 to disable.
 * @returns One {@link TripGroupResult} per newly created trip, including the
 *          GPS centroid for optional reverse-geocoding.
 */
export async function autoGroupTrips(
  gapSeconds: number,
  minTripKm: number
): Promise<TripGroupResult[]> {
  return invoke<TripGroupResult[]>("cmd_auto_group_trips", { gapSeconds, minTripKm });
}

/**
 * Delete all unconfirmed (suggested) trips in one operation.
 *
 * Photos that belonged to those trips have their `trip_id` set to `null`;
 * they are **not** removed from the library.
 *
 * @returns The count of trips that were deleted.
 */
export async function deleteAllSuggestedTrips(): Promise<number> {
  return invoke<number>("cmd_delete_all_suggested_trips");
}

// ── Thumbnail API ─────────────────────────────────────────────────────────────

/**
 * Generate thumbnails for up to `batchSize` photos that do not yet have one.
 *
 * Call repeatedly until `ThumbnailBatchReport.remaining` reaches 0.
 *
 * @param batchSize How many photos to process in one call (default: 20).
 */
export async function generateThumbnailsBatch(
  batchSize: number
): Promise<ThumbnailBatchReport> {
  return invoke<ThumbnailBatchReport>("cmd_generate_thumbnails_batch", { batchSize });
}

/**
 * Return photos whose thumbnail generation has failed the maximum number of
 * times and have been flagged for manual review.
 *
 * Paginated.
 */
export async function queryPhotosNeedingReview(page: Page): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_query_photos_needing_review", { page });
}

/**
 * Generate (or re-generate) a thumbnail for a single photo, ignoring retry
 * limits.  Intended for use from the photo viewer when the user clicks
 * "Generate thumbnail".
 *
 * @param photoId The database id of the photo to process.
 * @returns The absolute path of the newly written thumbnail file.
 */
export async function generateThumbnailForPhoto(photoId: number): Promise<string> {
  return invoke<string>("cmd_generate_thumbnail_for_photo", { photoId });
}

/**
 * Find untripped photos whose timestamps fall within confirmed trip windows
 * and return them as per-trip suggestions.
 *
 * @returns A list of {@link TripPhotoSuggestion} entries, one per qualifying
 *          confirmed trip.
 */
export async function suggestPhotosForTrips(): Promise<import("./types").TripPhotoSuggestion[]> {
  return invoke<import("./types").TripPhotoSuggestion[]>("cmd_suggest_photos_for_trips");
}

/**
 * Tell the background thumbnail worker to start (or restart) generating
 * thumbnails.  Progress is reported via Tauri events:
 *
 * - `thumbnail_progress` — `{ done, remaining, total }`
 * - `thumbnail_done`     — `{ done, cancelled }`
 * - `thumbnail_error`    — `string`
 *
 * @param batchSize Photos to process per backend iteration (default: 10).
 */
export async function startThumbnailWorker(batchSize: number): Promise<void> {
  return invoke<void>("cmd_start_thumbnail_worker", { batchSize });
}

/**
 * Ask the background thumbnail worker to stop after its current batch.
 * A `thumbnail_done` event with `cancelled: true` will follow shortly.
 */
export async function cancelThumbnailWorker(): Promise<void> {
  return invoke<void>("cmd_cancel_thumbnail_worker");
}

/**
 * Clear the thumbnail for a single photo by its id.
 *
 * Removes the thumbnail file from disk and resets the retry counter so
 * the background worker will regenerate it.  Returns the updated Photo
 * record, or `null` if no photo with the given id exists.
 */
export async function deleteThumbnail(photoId: number): Promise<Photo | null> {
  return invoke<Photo | null>("cmd_delete_thumbnail", { photoId });
}

/**
 * Clear all thumbnails across the entire library.
 *
 * Removes every thumbnail file from disk and resets retry counters so the
 * background worker can regenerate them all.  Returns the number of
 * thumbnails that were cleared.
 */
export async function clearAllThumbnails(): Promise<number> {
  return invoke<number>("cmd_clear_all_thumbnails");
}

// ── Home location API ─────────────────────────────────────────────────────────

/**
 * Return the stored home location, or `null` if none has been set.
 *
 * The home location is used by {@link autoGroupTrips} to distinguish away
 * trips from everyday home snapshots.
 */
export async function getHomeLocation(): Promise<HomeLocation | null> {
  return invoke<HomeLocation | null>("cmd_get_home_location");
}

/**
 * Persist a home location (overwrites any existing value).
 *
 * @param lat WGS-84 latitude in decimal degrees.
 * @param lon WGS-84 longitude in decimal degrees.
 */
export async function setHomeLocation(lat: number, lon: number): Promise<void> {
  return invoke<void>("cmd_set_home_location", { lat, lon });
}

/**
 * Infer the home location from the photo library and persist it.
 *
 * Bins all GPS-tagged photos into a coarse ~10 km grid and returns the
 * centroid of the most-populated cell.  Returns `null` when the library has
 * fewer than 5 GPS-tagged photos.
 *
 * The inferred location is automatically saved so subsequent
 * {@link autoGroupTrips} calls can use it.
 */
export async function inferHomeLocation(): Promise<HomeLocation | null> {
  return invoke<HomeLocation | null>("cmd_infer_home_location");
}

// ── Home transition (move event) API ─────────────────────────────────────────

/**
 * Return all home transitions ordered by transition date ascending.
 *
 * Includes both confirmed (user-accepted) and unconfirmed (auto-detected)
 * transitions.
 */
export async function listHomeTransitions(): Promise<HomeTransition[]> {
  return invoke<HomeTransition[]>("cmd_list_home_transitions");
}

/**
 * Insert a new confirmed home-transition record and return it.
 *
 * Use this to manually record a "moved to" event.  The transition is
 * immediately honoured by {@link autoGroupTrips} when determining what counts
 * as an away trip.
 *
 * @param transitionTs Unix epoch seconds of the approximate move date.
 * @param newLat       WGS-84 latitude of the new home in decimal degrees.
 * @param newLon       WGS-84 longitude of the new home in decimal degrees.
 * @returns The newly created {@link HomeTransition} record.
 */
export async function createHomeTransition(
  transitionTs: number,
  newLat: number,
  newLon: number
): Promise<HomeTransition> {
  return invoke<HomeTransition>("cmd_create_home_transition", {
    transitionTs,
    newLat,
    newLon,
  });
}

/**
 * Analyse the photo timeline for sustained location shifts and populate the
 * `home_transitions` table with newly detected move events.
 *
 * Previously detected unconfirmed transitions are replaced; confirmed ones
 * are preserved.  Returns the full list of transitions after the update.
 */
export async function detectHomeTransitions(): Promise<HomeTransition[]> {
  return invoke<HomeTransition[]>("cmd_detect_home_transitions");
}

/**
 * Mark a home transition as confirmed (user accepted the detected move).
 *
 * @returns `true` if the transition was found and updated.
 */
export async function confirmHomeTransition(id: number): Promise<boolean> {
  return invoke<boolean>("cmd_confirm_home_transition", { id });
}

/**
 * Delete a home transition (user rejected the detected move).
 *
 * @returns `true` if the transition was found and deleted.
 */
export async function dismissHomeTransition(id: number): Promise<boolean> {
  return invoke<boolean>("cmd_dismiss_home_transition", { id });
}

/**
 * Return the default `minTripKm` threshold for {@link autoGroupTrips}.
 *
 * Convenience function so the UI can initialise its slider without
 * hard-coding the backend default value.
 */
export async function getDefaultMinTripKm(): Promise<number> {
  return invoke<number>("cmd_get_default_min_trip_km");
}

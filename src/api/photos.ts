import { invoke } from "@tauri-apps/api/core";
import type { BoundingBox, InsertPhoto, Page, Photo, ScanReport, Trip } from "./types";

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
 * @returns The id of the newly created trip.
 */
export async function createTrip(
  name: string,
  startTs: number | null,
  endTs: number | null
): Promise<number> {
  return invoke<number>("cmd_create_trip", { name, startTs, endTs });
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
 * Cluster all timestamped photos into trips using a temporal-gap algorithm.
 *
 * A new trip is created whenever two consecutive photos (by timestamp) are
 * more than `gapSeconds` apart.  Existing trips are cleared first, making
 * this operation idempotent.  Photos without a timestamp are left ungrouped.
 *
 * @param gapSeconds Gap threshold in seconds (default: 6 hours = 21 600).
 * @returns The list of newly created trip ids.
 */
export async function autoGroupTrips(gapSeconds: number): Promise<number[]> {
  return invoke<number[]>("cmd_auto_group_trips", { gapSeconds });
}

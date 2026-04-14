import { invoke } from "@tauri-apps/api/core";
import type { BoundingBox, InsertPhoto, Page, Photo, ScanReport } from "./types";

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

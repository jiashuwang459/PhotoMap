import { invoke } from "@tauri-apps/api/core";
import type { BoundingBox, InsertPhoto, Page, Photo } from "./types";

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

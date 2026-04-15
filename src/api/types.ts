/**
 * Type definitions mirroring the Rust structs exposed via Tauri commands.
 */

/** A single photo record returned from the database. */
export interface Photo {
  id: number;
  file_path: string;
  /** Unix epoch seconds (UTC); null when EXIF date is absent. */
  timestamp: number | null;
  latitude: number | null;
  longitude: number | null;
  thumbnail_path: string | null;
  blur_score: number | null;
  trip_id: number | null;
  /**
   * SHA-256 hex digest of the file's raw bytes.
   * Null until the background scanner has processed the file.
   * A change in this value (for the same file_path) indicates the file was
   * modified on disk since the last scan.
   */
  file_hash: string | null;
  /**
   * Number of times thumbnail generation has been attempted and failed.
   * Resets to 0 on success.
   */
  thumbnail_retry_count: number;
  /**
   * `true` when thumbnail generation has exhausted all retries.
   * The user should inspect the file manually to resolve it.
   */
  thumbnail_needs_review: boolean;
}

/** Input for inserting or upserting a photo record. */
export interface InsertPhoto {
  file_path: string;
  timestamp: number | null;
  latitude: number | null;
  longitude: number | null;
  thumbnail_path: string | null;
  blur_score: number | null;
  trip_id: number | null;
  /** SHA-256 hex digest of the file's raw bytes; null when not yet computed. */
  file_hash: string | null;
}

/** Pagination parameters shared by all list queries. */
export interface Page {
  /** Max rows to return (server-side cap: 500). */
  limit: number;
  /** Row offset for paginating through results. */
  offset: number;
}

/** WGS-84 bounding box for spatial queries. */
export interface BoundingBox {
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
}

/** A trip record returned from the database. */
export interface Trip {
  id: number;
  name: string;
  /** Unix epoch seconds of the earliest photo in the trip; null if unset. */
  start_ts: number | null;
  /** Unix epoch seconds of the latest photo in the trip; null if unset. */
  end_ts: number | null;
  /** `id` of the cover photo; null until assigned. */
  cover_photo_id: number | null;
  /** Number of photos currently assigned to this trip. */
  photo_count: number;
  /**
   * Whether the user has confirmed (accepted) this trip.
   * Auto-grouped trips start as `false` (suggested); users confirm them.
   */
  is_confirmed: boolean;
}

/** A per-file error recorded inside {@link ThumbnailBatchReport}. */
export interface ThumbnailEntryError {
  photo_id: number;
  file_path: string;
  message: string;
  /** Retry count after this failure. */
  retry_count: number;
  /** Whether the photo has now been flagged for manual review. */
  needs_review: boolean;
}

/** Summary returned by {@link generateThumbnailsBatch}. */
export interface ThumbnailBatchReport {
  /** Thumbnails successfully generated in this batch. */
  processed: number;
  /** Photos still without a thumbnail and not yet flagged. */
  remaining: number;
  /** Photos newly flagged for manual review in this batch. */
  needs_review_count: number;
  /** Per-photo errors that did not abort the batch. */
  errors: ThumbnailEntryError[];
}

/** A per-file error recorded inside {@link ScanReport}. */
export interface ScanEntryError {
  /** Absolute path of the file that caused the error. */
  file_path: string;
  /** Human-readable description of the error. */
  message: string;
}

/** Summary returned by {@link scanDirectory}. */
export interface ScanReport {
  /** Files inserted into the database (first time seen). */
  added: number;
  /** Files updated in the database (hash changed since last scan). */
  updated: number;
  /** Database records removed (file deleted from disk). */
  removed: number;
  /** Files skipped because the hash was unchanged. */
  unchanged: number;
  /** Per-file errors that did not abort the scan. */
  errors: ScanEntryError[];
}

/** A suggestion to add untripped photos to an existing confirmed trip. */
export interface TripPhotoSuggestion {
  /** ID of the confirmed trip. */
  trip_id: number;
  /** Name of the trip. */
  trip_name: string;
  /** Photos that are unassigned but fall within the trip's time window. */
  photos: Photo[];
}

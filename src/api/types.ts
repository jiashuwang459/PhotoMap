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

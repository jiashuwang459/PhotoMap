//! Thumbnail generation for indexed photos.
//!
//! # Overview
//!
//! [`generate_thumbnail`] resizes a single image to fit within a
//! 300 × 300 pixel bounding box (preserving aspect ratio) and writes the
//! result as a JPEG to the supplied output path.
//!
//! [`generate_thumbnails_batch`] queries the database for photos that do not
//! yet have a `thumbnail_path`, processes up to `batch_size` of them, and
//! updates each row with the generated path.  Repeat calls until
//! [`ThumbnailBatchReport::remaining`] is `0` to process the entire library.
//!
//! # Thumbnail naming
//!
//! Thumbnails are stored as `{thumbnail_dir}/{photo_id}.jpg`.  Using the
//! stable primary key avoids name collisions and makes clean-up easy.

use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::ImageEncoder;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::db::photos::DbError;

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

/// Thumbnail dimensions: the long edge is capped at this many pixels.
const MAX_SIDE: u32 = 300;

/// JPEG encoding quality (0–100).
const JPEG_QUALITY: u8 = 80;

/// Errors that can occur during thumbnail generation.
#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("image decode error: {0}")]
    Decode(#[from] image::ImageError),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] DbError),
}

impl serde::Serialize for ThumbnailError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// A per-file error recorded inside [`ThumbnailBatchReport`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailEntryError {
    /// Database id of the photo that could not be processed.
    pub photo_id: i64,
    /// Absolute path of the source image.
    pub file_path: String,
    /// Human-readable description of the error.
    pub message: String,
}

/// Summary returned by [`generate_thumbnails_batch`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailBatchReport {
    /// Number of thumbnails successfully generated in this batch.
    pub processed: u32,
    /// Number of photos still without a thumbnail after this batch.
    pub remaining: u32,
    /// Per-file errors that did not abort the batch.
    pub errors: Vec<ThumbnailEntryError>,
}

// ──────────────────────────────────────────────────────────────────────────────
// Public functions
// ──────────────────────────────────────────────────────────────────────────────

/// Generate a thumbnail for the image at `source` and write it to `out_path`.
///
/// The image is resized to fit within a [`MAX_SIDE`] × [`MAX_SIDE`] bounding
/// box using Lanczos3 resampling, then encoded as JPEG at [`JPEG_QUALITY`].
///
/// # Errors
/// Returns [`ThumbnailError::Decode`] if the source image cannot be opened or
/// decoded, and [`ThumbnailError::Io`] if the output file cannot be written.
pub fn generate_thumbnail(source: &Path, out_path: &Path) -> Result<(), ThumbnailError> {
    let img = image::open(source)?;
    let thumbnail = img.resize(MAX_SIDE, MAX_SIDE, FilterType::Lanczos3);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Use JpegEncoder directly to control quality.
    let file = std::fs::File::create(out_path)?;
    let writer = std::io::BufWriter::new(file);
    let encoder = JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
    let rgb = thumbnail.to_rgb8();
    encoder.write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(())
}

/// Process one batch of photos that do not yet have a thumbnail.
///
/// The function:
/// 1. Queries up to `batch_size` photos where `thumbnail_path IS NULL`.
/// 2. For each photo, calls [`generate_thumbnail`] and writes the result to
///    `{thumbnail_dir}/{photo_id}.jpg`.
/// 3. Updates `photos.thumbnail_path` in the database on success.
/// 4. Records per-photo errors without aborting the whole batch.
/// 5. Counts remaining un-thumbnailed photos and includes that in the report.
///
/// Call repeatedly (incrementing nothing — the query always fetches the next
/// unprocessed page) until [`ThumbnailBatchReport::remaining`] reaches `0`.
///
/// # Errors
/// Returns [`ThumbnailError::Database`] on a fatal SQLite failure (e.g. unable
/// to query or update the table).  Per-photo decode/IO errors are captured in
/// [`ThumbnailBatchReport::errors`] instead.
pub fn generate_thumbnails_batch(
    conn: &Connection,
    thumbnail_dir: &Path,
    batch_size: u32,
) -> Result<ThumbnailBatchReport, ThumbnailError> {
    // ── 1. Fetch next batch ──────────────────────────────────────────────────
    struct Row {
        id: i64,
        file_path: String,
    }

    let mut stmt = conn
        .prepare_cached(
            "SELECT id, file_path FROM photos WHERE thumbnail_path IS NULL LIMIT ?1",
        )
        .map_err(DbError::from)?;

    let rows: Vec<Row> = stmt
        .query_map(rusqlite::params![batch_size], |row| {
            Ok(Row {
                id: row.get(0)?,
                file_path: row.get(1)?,
            })
        })
        .map_err(DbError::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(DbError::from)?;

    // ── 2. Generate thumbnails ───────────────────────────────────────────────
    let mut report = ThumbnailBatchReport {
        processed: 0,
        remaining: 0,
        errors: Vec::new(),
    };

    let mut update_stmt = conn
        .prepare_cached("UPDATE photos SET thumbnail_path = ?1 WHERE id = ?2")
        .map_err(DbError::from)?;

    for row in &rows {
        let out_path = thumbnail_path_for(thumbnail_dir, row.id);
        match generate_thumbnail(Path::new(&row.file_path), &out_path) {
            Ok(()) => {
                let path_str = out_path.to_string_lossy().into_owned();
                update_stmt
                    .execute(rusqlite::params![path_str, row.id])
                    .map_err(DbError::from)?;
                report.processed += 1;
            }
            Err(e) => {
                report.errors.push(ThumbnailEntryError {
                    photo_id: row.id,
                    file_path: row.file_path.clone(),
                    message: e.to_string(),
                });
            }
        }
    }

    // ── 3. Count remaining ───────────────────────────────────────────────────
    let remaining: u32 = conn
        .query_row(
            "SELECT COUNT(*) FROM photos WHERE thumbnail_path IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(DbError::from)?;
    report.remaining = remaining;

    Ok(report)
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Canonical thumbnail path for a given photo id.
pub fn thumbnail_path_for(thumbnail_dir: &Path, photo_id: i64) -> PathBuf {
    thumbnail_dir.join(format!("{photo_id}.jpg"))
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::photos::{run_migrations, upsert_photo, InsertPhoto};
    use tempfile::TempDir;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn insert_photo(conn: &Connection, path: &str) -> i64 {
        upsert_photo(
            conn,
            &InsertPhoto {
                file_path: path.to_owned(),
                timestamp: None,
                latitude: None,
                longitude: None,
                thumbnail_path: None,
                blur_score: None,
                trip_id: None,
                file_hash: None,
            },
        )
        .unwrap()
    }

    /// Create a minimal valid JPEG in a temp dir and return its path.
    fn write_test_jpeg(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        // Create a 10×10 white RGB image and save as JPEG.
        let img = image::RgbImage::from_fn(10, 10, |_, _| image::Rgb([255u8, 255, 255]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();
        path
    }

    #[test]
    fn generate_thumbnail_creates_file() {
        let src_dir = TempDir::new().unwrap();
        let out_dir = TempDir::new().unwrap();
        let src = write_test_jpeg(&src_dir, "photo.jpg");
        let out = out_dir.path().join("thumb.jpg");

        generate_thumbnail(&src, &out).unwrap();

        assert!(out.exists(), "thumbnail file should be created");
    }

    #[test]
    fn thumbnail_is_within_max_dimensions() {
        let src_dir = TempDir::new().unwrap();
        let out_dir = TempDir::new().unwrap();
        // Create a 1000×500 image (wider than tall).
        let path = src_dir.path().join("wide.jpg");
        let img = image::RgbImage::from_fn(1000, 500, |_, _| image::Rgb([0u8, 0, 0]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();

        let out = out_dir.path().join("thumb.jpg");
        generate_thumbnail(&path, &out).unwrap();

        let result = image::open(&out).unwrap();
        assert!(result.width() <= MAX_SIDE, "width should be ≤ {MAX_SIDE}");
        assert!(result.height() <= MAX_SIDE, "height should be ≤ {MAX_SIDE}");
    }

    #[test]
    fn batch_generates_thumbnails_and_updates_db() {
        let conn = mem_db();
        let src_dir = TempDir::new().unwrap();
        let thumb_dir = TempDir::new().unwrap();

        let src1 = write_test_jpeg(&src_dir, "a.jpg");
        let src2 = write_test_jpeg(&src_dir, "b.jpg");
        let id1 = insert_photo(&conn, src1.to_str().unwrap());
        let id2 = insert_photo(&conn, src2.to_str().unwrap());

        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 2);
        assert_eq!(report.remaining, 0);
        assert!(report.errors.is_empty());

        // Thumbnail files should exist.
        assert!(thumbnail_path_for(thumb_dir.path(), id1).exists());
        assert!(thumbnail_path_for(thumb_dir.path(), id2).exists());

        // DB rows should have thumbnail_path set.
        let path1: Option<String> = conn
            .query_row(
                "SELECT thumbnail_path FROM photos WHERE id = ?1",
                rusqlite::params![id1],
                |r| r.get(0),
            )
            .unwrap();
        assert!(path1.is_some(), "thumbnail_path should be set in DB");
    }

    #[test]
    fn batch_respects_batch_size() {
        let conn = mem_db();
        let src_dir = TempDir::new().unwrap();
        let thumb_dir = TempDir::new().unwrap();

        for i in 0..5 {
            let src = write_test_jpeg(&src_dir, &format!("{i}.jpg"));
            insert_photo(&conn, src.to_str().unwrap());
        }

        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 2).unwrap();
        assert_eq!(report.processed, 2);
        assert_eq!(report.remaining, 3);
    }

    #[test]
    fn batch_skips_already_thumbnailed() {
        let conn = mem_db();
        let src_dir = TempDir::new().unwrap();
        let thumb_dir = TempDir::new().unwrap();

        let src = write_test_jpeg(&src_dir, "a.jpg");
        let id = insert_photo(&conn, src.to_str().unwrap());

        // First batch.
        generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();

        // Second batch should find nothing to do.
        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 0);
        assert_eq!(report.remaining, 0);
        let _ = id;
    }

    #[test]
    fn batch_records_error_for_missing_source() {
        let conn = mem_db();
        let thumb_dir = TempDir::new().unwrap();

        insert_photo(&conn, "/does/not/exist.jpg");

        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 0);
        assert_eq!(report.errors.len(), 1);
        // remaining is still 1 because the photo still has no thumbnail.
        assert_eq!(report.remaining, 1);
    }
}

//! Thumbnail generation for indexed photos.
//!
//! # Overview
//!
//! [`generate_thumbnail`] resizes a single image to fit within a
//! 300 × 300 pixel bounding box (preserving aspect ratio) and writes the
//! result as a JPEG to the supplied output path.
//!
//! Standard formats (JPEG, PNG, TIFF, WebP) are handled by the `image`
//! crate.  `.heic` and `.heif` files are decoded by the `heic` crate via
//! [`decode_heic`] and then handed to the same resize / encode pipeline.
//!
//! # Retry limits
//!
//! [`generate_thumbnails_batch`] uses two additional database columns —
//! `thumbnail_retry_count` and `thumbnail_needs_review` — to cap the
//! number of decode attempts per photo.
//!
//! Each time a photo fails:
//! * `thumbnail_retry_count` is incremented.
//! * When the count reaches [`MAX_THUMB_RETRIES`], `thumbnail_needs_review`
//!   is set to `1` and the photo is excluded from all future batches until
//!   a user clears the flag.
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
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/// Thumbnail dimensions: the long edge is capped at this many pixels.
const MAX_SIDE: u32 = 300;

/// JPEG encoding quality (0–100).
const JPEG_QUALITY: u8 = 80;

/// Maximum number of thumbnail-generation attempts before a photo is flagged
/// for manual review.
pub const MAX_THUMB_RETRIES: i64 = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

/// Errors that can occur during thumbnail generation.
#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("image decode error: {0}")]
    Decode(#[from] image::ImageError),
    #[error("HEIC decode error: {0}")]
    HeicDecode(String),
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
    /// Retry count after this failure.
    pub retry_count: i64,
    /// Whether the photo has now been flagged for manual review.
    pub needs_review: bool,
}

/// Summary returned by [`generate_thumbnails_batch`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailBatchReport {
    /// Number of thumbnails successfully generated in this batch.
    pub processed: u32,
    /// Number of photos still without a thumbnail (and not yet flagged).
    pub remaining: u32,
    /// Number of photos flagged for manual review after this batch.
    pub needs_review_count: u32,
    /// Per-file errors that did not abort the batch.
    pub errors: Vec<ThumbnailEntryError>,
}

// ──────────────────────────────────────────────────────────────────────────────
// Public functions
// ──────────────────────────────────────────────────────────────────────────────

/// Generate a thumbnail for the image at `source` and write it to `out_path`.
///
/// Dispatches to [`decode_heic`] for `.heic` / `.heif` files and falls back
/// to the `image` crate for everything else.
///
/// The image is resized to fit within [`MAX_SIDE`] × [`MAX_SIDE`] pixels using
/// Lanczos3 resampling, then encoded as JPEG at [`JPEG_QUALITY`].
///
/// # Errors
/// Returns [`ThumbnailError::HeicDecode`] for HEIC/HEIF decode failures,
/// [`ThumbnailError::Decode`] for other format errors, and
/// [`ThumbnailError::Io`] if the output file cannot be written.
pub fn generate_thumbnail(source: &Path, out_path: &Path) -> Result<(), ThumbnailError> {
    let img = open_image(source)?;
    write_thumbnail(img, out_path)
}

/// Process one batch of photos that do not yet have a thumbnail.
///
/// The function:
/// 1. Queries up to `batch_size` photos where `thumbnail_path IS NULL AND
///    thumbnail_needs_review = 0 AND thumbnail_retry_count < MAX_THUMB_RETRIES`.
/// 2. For each photo, calls [`generate_thumbnail`] and writes the result to
///    `{thumbnail_dir}/{photo_id}.jpg`.
/// 3. On success: updates `photos.thumbnail_path` and resets
///    `thumbnail_retry_count` to `0`.
/// 4. On failure: increments `thumbnail_retry_count`.  If the count now
///    reaches [`MAX_THUMB_RETRIES`], also sets `thumbnail_needs_review = 1`.
/// 5. Returns counts of remaining processable photos and flagged photos.
///
/// Call repeatedly until [`ThumbnailBatchReport::remaining`] reaches `0` to
/// process the entire library.
///
/// # Errors
/// Returns [`ThumbnailError::Database`] on a fatal SQLite failure.
/// Per-photo decode/IO errors are captured in [`ThumbnailBatchReport::errors`].
pub fn generate_thumbnails_batch(
    conn: &Connection,
    thumbnail_dir: &Path,
    batch_size: u32,
) -> Result<ThumbnailBatchReport, ThumbnailError> {
    // ── 1. Fetch next batch ──────────────────────────────────────────────────
    struct Row {
        id: i64,
        file_path: String,
        retry_count: i64,
    }

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

    let rows: Vec<Row> = stmt
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

    // ── 2. Generate thumbnails ───────────────────────────────────────────────
    let mut report = ThumbnailBatchReport {
        processed: 0,
        remaining: 0,
        needs_review_count: 0,
        errors: Vec::new(),
    };

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

    for row in &rows {
        let out_path = thumbnail_path_for(thumbnail_dir, row.id);
        match generate_thumbnail(Path::new(&row.file_path), &out_path) {
            Ok(()) => {
                let path_str = out_path.to_string_lossy().into_owned();
                update_success
                    .execute(rusqlite::params![path_str, row.id])
                    .map_err(DbError::from)?;
                report.processed += 1;
            }
            Err(e) => {
                let new_count = row.retry_count + 1;
                let needs_review = i64::from(new_count >= MAX_THUMB_RETRIES);
                update_failure
                    .execute(rusqlite::params![new_count, needs_review, row.id])
                    .map_err(DbError::from)?;
                if needs_review == 1 {
                    report.needs_review_count += 1;
                }
                report.errors.push(ThumbnailEntryError {
                    photo_id: row.id,
                    file_path: row.file_path.clone(),
                    message: e.to_string(),
                    retry_count: new_count,
                    needs_review: needs_review == 1,
                });
            }
        }
    }

    // ── 3. Count remaining processable photos ────────────────────────────────
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

    Ok(report)
}

/// Generate a thumbnail for a single photo identified by `photo_id`.
///
/// Unlike [`generate_thumbnails_batch`] this function ignores `thumbnail_retry_count`
/// and `thumbnail_needs_review` flags, allowing the user to manually trigger
/// (or retry) thumbnail generation for a specific photo from the photo viewer.
///
/// On success, `photos.thumbnail_path` is updated and `thumbnail_retry_count` /
/// `thumbnail_needs_review` are reset.
///
/// # Errors
/// Returns [`ThumbnailError::Database`] if the photo record cannot be found
/// or a DB write fails.  Returns a decode or I/O error if the image itself
/// cannot be processed.
pub fn generate_thumbnail_for_photo(
    conn: &Connection,
    thumbnail_dir: &Path,
    photo_id: i64,
) -> Result<String, ThumbnailError> {
    let file_path: String = conn
        .query_row(
            "SELECT file_path FROM photos WHERE id = ?1",
            rusqlite::params![photo_id],
            |row| row.get(0),
        )
        .map_err(DbError::from)?;

    let out_path = thumbnail_path_for(thumbnail_dir, photo_id);
    generate_thumbnail(Path::new(&file_path), &out_path)?;

    let path_str = out_path.to_string_lossy().into_owned();
    conn.execute(
        "UPDATE photos
         SET    thumbnail_path        = ?1,
                thumbnail_retry_count = 0,
                thumbnail_needs_review = 0
         WHERE  id = ?2",
        rusqlite::params![path_str, photo_id],
    )
    .map_err(DbError::from)?;

    Ok(path_str)
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Canonical thumbnail path for a given photo id.
pub fn thumbnail_path_for(thumbnail_dir: &Path, photo_id: i64) -> PathBuf {
    thumbnail_dir.join(format!("{photo_id}.jpg"))
}

/// Open an image from `source`, routing `.heic`/`.heif` files through the
/// `heic` crate and all other formats through the `image` crate.
fn open_image(source: &Path) -> Result<image::DynamicImage, ThumbnailError> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext == "heic" || ext == "heif" {
        decode_heic(source)
    } else {
        Ok(image::open(source)?)
    }
}

/// Decode a HEIC/HEIF file into a [`image::DynamicImage`] using the `heic`
/// crate.
///
/// We use the zero-copy [`heic::DecoderConfig::decode_request`] +
/// [`decode_into`][heic::DecodeRequest::decode_into] path with
/// [`heic::PixelLayout::Rgb8`] to avoid an extra allocation and keep memory
/// usage low for large iPhone photos.
///
/// # Reference
/// <https://docs.rs/heic/latest/heic/>
fn decode_heic(source: &Path) -> Result<image::DynamicImage, ThumbnailError> {
    let data = std::fs::read(source)?;

    // Probe the image dimensions so we can pre-allocate the output buffer.
    let info = heic::ImageInfo::from_bytes(&data)
        .map_err(|e| ThumbnailError::HeicDecode(e.to_string()))?;

    let buf_len = info
        .output_buffer_size(heic::PixelLayout::Rgb8)
        .ok_or_else(|| ThumbnailError::HeicDecode("could not compute output buffer size".into()))?;

    let mut buf = vec![0u8; buf_len];

    let (width, height) = heic::DecoderConfig::new()
        .decode_request(&data)
        .with_output_layout(heic::PixelLayout::Rgb8)
        .decode_into(&mut buf)
        .map_err(|e| ThumbnailError::HeicDecode(e.to_string()))?;

    // Convert the raw RGB8 pixels into an image::RgbImage.
    let rgb = image::RgbImage::from_raw(width, height, buf)
        .ok_or_else(|| ThumbnailError::HeicDecode("buffer size mismatch".into()))?;

    Ok(image::DynamicImage::ImageRgb8(rgb))
}

/// Resize `img` to fit within [`MAX_SIDE`] × [`MAX_SIDE`] and encode it as a
/// JPEG at [`JPEG_QUALITY`] to `out_path`.
fn write_thumbnail(img: image::DynamicImage, out_path: &Path) -> Result<(), ThumbnailError> {
    let thumbnail = img.resize(MAX_SIDE, MAX_SIDE, FilterType::Lanczos3);

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

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
        let img = image::RgbImage::from_fn(10, 10, |_, _| image::Rgb([255u8, 255, 255]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();
        path
    }

    // ── generate_thumbnail ───────────────────────────────────────────────────

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

    // ── batch ────────────────────────────────────────────────────────────────

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

        assert!(thumbnail_path_for(thumb_dir.path(), id1).exists());
        assert!(thumbnail_path_for(thumb_dir.path(), id2).exists());

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

        generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();

        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 0);
        assert_eq!(report.remaining, 0);
        let _ = id;
    }

    // ── retry logic ──────────────────────────────────────────────────────────

    #[test]
    fn batch_increments_retry_count_on_failure() {
        let conn = mem_db();
        let thumb_dir = TempDir::new().unwrap();

        let id = insert_photo(&conn, "/does/not/exist.jpg");

        // First attempt: retry_count goes 0 → 1.
        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 0);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].retry_count, 1);
        assert!(!report.errors[0].needs_review);
        assert_eq!(report.remaining, 1, "still eligible for retry");

        let count: i64 = conn
            .query_row("SELECT thumbnail_retry_count FROM photos WHERE id = ?1",
                rusqlite::params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn batch_flags_photo_after_max_retries() {
        let conn = mem_db();
        let thumb_dir = TempDir::new().unwrap();

        let id = insert_photo(&conn, "/does/not/exist.jpg");

        // Exhaust retries — MAX_THUMB_RETRIES is 3.
        for attempt in 1..=MAX_THUMB_RETRIES {
            let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
            assert_eq!(report.processed, 0);
            if attempt < MAX_THUMB_RETRIES {
                assert!(report.remaining > 0, "should still be eligible before max");
                assert!(!report.errors[0].needs_review);
            } else {
                // On the final attempt remaining drops to 0 and flag is set.
                assert_eq!(report.remaining, 0, "flagged photos excluded from remaining");
                assert!(report.errors[0].needs_review, "should be flagged on last attempt");
                assert_eq!(report.needs_review_count, 1);
            }
        }

        let (retry, review): (i64, i64) = conn
            .query_row(
                "SELECT thumbnail_retry_count, thumbnail_needs_review FROM photos WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(retry, MAX_THUMB_RETRIES);
        assert_eq!(review, 1);
    }

    #[test]
    fn batch_excludes_flagged_photos_from_future_runs() {
        let conn = mem_db();
        let thumb_dir = TempDir::new().unwrap();

        insert_photo(&conn, "/does/not/exist.jpg");

        // Drive to flagged state.
        for _ in 0..MAX_THUMB_RETRIES {
            generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        }

        // Subsequent batch should see nothing to do.
        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 0);
        assert_eq!(report.remaining, 0);
        assert!(report.errors.is_empty(), "flagged photo must not be retried");
    }

    #[test]
    fn success_resets_retry_count() {
        let conn = mem_db();
        let src_dir = TempDir::new().unwrap();
        let thumb_dir = TempDir::new().unwrap();

        // Insert a photo that points at a non-existent path initially.
        let id = insert_photo(&conn, "/does/not/exist_yet.jpg");

        // Let it fail once.
        generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();

        let count_before: i64 = conn
            .query_row("SELECT thumbnail_retry_count FROM photos WHERE id = ?1",
                rusqlite::params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, 1);

        // Now create the file and update the path so it can succeed.
        let real_src = write_test_jpeg(&src_dir, "real.jpg");
        conn.execute(
            "UPDATE photos SET file_path = ?1 WHERE id = ?2",
            rusqlite::params![real_src.to_str().unwrap(), id],
        ).unwrap();

        let report = generate_thumbnails_batch(&conn, thumb_dir.path(), 10).unwrap();
        assert_eq!(report.processed, 1);

        let (count_after, review): (i64, i64) = conn
            .query_row(
                "SELECT thumbnail_retry_count, thumbnail_needs_review FROM photos WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count_after, 0, "retry_count should reset on success");
        assert_eq!(review, 0, "needs_review should stay 0");
    }
}

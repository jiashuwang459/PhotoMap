//! Background file-system scanner.
//!
//! # Overview
//!
//! `scan_directory` walks a given directory tree, hashes every recognised
//! image file with SHA-256, reads available EXIF metadata (timestamp and GPS),
//! and synchronises the results with the SQLite database:
//!
//! * **New file** — a file on disk that has no matching `file_path` row in the
//!   DB is inserted.
//! * **Modified file** — a file whose on-disk SHA-256 hash differs from the
//!   stored `file_hash` is updated in place (all columns refreshed from the
//!   current file contents).
//! * **Unchanged file** — if the hash matches the stored value the row is
//!   skipped entirely, keeping the scan fast on repeated runs.
//! * **Removed file** — a DB row whose `file_path` no longer exists under the
//!   scanned directory is deleted.
//!
//! # Image formats
//!
//! The scanner recognises files by extension: `.jpg`, `.jpeg`, `.png`,
//! `.tiff`, `.tif`, `.heic`, `.heif`, `.webp`.  The extension check is
//! case-insensitive.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use thiserror::Error;
use walkdir::WalkDir;

use crate::db::photos::{
    delete_photo_by_path, get_photo_by_path, list_photos_by_path_prefix, upsert_photo, InsertPhoto,
    Page,
};

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

/// Errors that can occur during a directory scan.
#[derive(Debug, Error)]
pub enum ScanError {
    #[error("directory not found or not accessible: {0}")]
    DirectoryNotFound(PathBuf),
    #[error("directory walk error: {0}")]
    Walk(#[from] walkdir::Error),
    #[error("database error: {0}")]
    Database(#[from] crate::db::photos::DbError),
}

impl serde::Serialize for ScanError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// A per-file error recorded inside [`ScanReport`] without aborting the scan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScanEntryError {
    /// The file that caused the error.
    pub file_path: String,
    /// Human-readable description of the error.
    pub message: String,
}

/// Summary returned by [`scan_directory`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScanReport {
    /// Files inserted (first time seen).
    pub added: u32,
    /// Files updated (hash changed since last scan).
    pub updated: u32,
    /// DB records removed (file deleted from disk).
    pub removed: u32,
    /// Files skipped (hash unchanged).
    pub unchanged: u32,
    /// Per-file errors that did not abort the scan.
    pub errors: Vec<ScanEntryError>,
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/// Scan `dir` recursively, synchronising the database with the current state
/// of all image files found.
///
/// The function is idempotent and safe to call on a directory that has already
/// been scanned: unchanged files are detected via the stored `file_hash` and
/// skipped without re-reading EXIF data.
pub fn scan_directory(conn: &Connection, dir: &Path) -> Result<ScanReport, ScanError> {
    if !dir.is_dir() {
        return Err(ScanError::DirectoryNotFound(dir.to_path_buf()));
    }

    let mut report = ScanReport {
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        errors: Vec::new(),
    };

    // ── Phase 1: walk and upsert ─────────────────────────────────────────────
    let mut seen_paths: HashSet<String> = HashSet::new();

    for entry in WalkDir::new(dir).follow_links(true) {
        let entry = entry?;
        let path = entry.path();

        if !entry.file_type().is_file() || !is_image_path(path) {
            continue;
        }

        let path_str = match path.to_str() {
            Some(s) => s.to_string(),
            None => {
                report.errors.push(ScanEntryError {
                    file_path: path.to_string_lossy().into_owned(),
                    message: "path contains non-UTF-8 characters".into(),
                });
                continue;
            }
        };

        seen_paths.insert(path_str.clone());

        // Compute hash; on I/O error record and continue.
        let hash = match compute_sha256(path) {
            Ok(h) => h,
            Err(e) => {
                report.errors.push(ScanEntryError {
                    file_path: path_str,
                    message: format!("hashing failed: {e}"),
                });
                continue;
            }
        };

        // Check existing record.
        let existing = get_photo_by_path(conn, &path_str)?;
        if let Some(ref rec) = existing {
            if rec.file_hash.as_deref() == Some(&hash) {
                report.unchanged += 1;
                continue;
            }
        }

        // New or modified — read EXIF and upsert.
        let exif = read_exif_metadata(path);
        let insert = InsertPhoto {
            file_path: path_str.clone(),
            timestamp: exif.timestamp,
            latitude: exif.latitude,
            longitude: exif.longitude,
            thumbnail_path: existing.as_ref().and_then(|r| r.thumbnail_path.clone()),
            blur_score: existing.as_ref().and_then(|r| r.blur_score),
            trip_id: existing.as_ref().and_then(|r| r.trip_id),
            file_hash: Some(hash),
        };

        match upsert_photo(conn, &insert) {
            Ok(_) => {
                if existing.is_none() {
                    report.added += 1;
                } else {
                    report.updated += 1;
                }
            }
            Err(e) => {
                report.errors.push(ScanEntryError {
                    file_path: path_str,
                    message: format!("db upsert failed: {e}"),
                });
            }
        }
    }

    // ── Phase 2: remove stale records ────────────────────────────────────────
    let dir_prefix = dir.to_str().unwrap_or("").to_string();
    let page_size = Page { limit: 500, offset: 0 };
    let mut offset = 0u32;
    loop {
        let page = Page { limit: 500, offset };
        let batch = list_photos_by_path_prefix(conn, &dir_prefix, &page)?;
        let batch_len = batch.len() as u32;
        for photo in batch {
            if !seen_paths.contains(&photo.file_path) {
                match delete_photo_by_path(conn, &photo.file_path) {
                    Ok(true) => report.removed += 1,
                    Ok(false) => {}
                    Err(e) => {
                        report.errors.push(ScanEntryError {
                            file_path: photo.file_path,
                            message: format!("db delete failed: {e}"),
                        });
                    }
                }
            }
        }
        if batch_len < page_size.limit {
            break;
        }
        offset += page_size.limit;
    }

    Ok(report)
}

/// Compute the SHA-256 hex digest of the file at `path`.
///
/// Reads the file in 64 KiB chunks to bound memory usage for large photos.
pub fn compute_sha256(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    // sha2 0.11 returns a hybrid_array::Array which does not implement LowerHex
    // directly — format each byte manually.
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex)
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/// EXIF fields extracted from a photo file.
struct ExifFields {
    timestamp: Option<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

/// Read EXIF metadata from an image file.
///
/// Returns `None`-filled fields on any parse error rather than propagating —
/// the caller treats these as "no metadata available".
fn read_exif_metadata(path: &Path) -> ExifFields {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return ExifFields { timestamp: None, latitude: None, longitude: None },
    };
    let mut bufreader = std::io::BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut bufreader) {
        Ok(e) => e,
        Err(_) => return ExifFields { timestamp: None, latitude: None, longitude: None },
    };

    let timestamp = extract_timestamp(&exif);
    let (latitude, longitude) = extract_gps(&exif);

    ExifFields { timestamp, latitude, longitude }
}

/// Parse DateTimeOriginal (or DateTime) into a Unix epoch seconds value.
fn extract_timestamp(exif: &exif::Exif) -> Option<i64> {
    use exif::{In, Tag};

    // Prefer DateTimeOriginal; fall back to DateTime.
    let field = exif
        .get_field(Tag::DateTimeOriginal, In::PRIMARY)
        .or_else(|| exif.get_field(Tag::DateTime, In::PRIMARY))?;

    // The value is an ASCII string "YYYY:MM:DD HH:MM:SS".
    let s = match &field.value {
        exif::Value::Ascii(v) => v.first()?,
        _ => return None,
    };
    let s = std::str::from_utf8(s).ok()?;
    parse_exif_datetime(s)
}

/// Parse "YYYY:MM:DD HH:MM:SS" into Unix epoch seconds (UTC, no timezone).
fn parse_exif_datetime(s: &str) -> Option<i64> {
    // Format: "YYYY:MM:DD HH:MM:SS"
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: i64 = s[5..7].parse().ok()?;
    let day: i64 = s[8..10].parse().ok()?;
    let hour: i64 = s[11..13].parse().ok()?;
    let minute: i64 = s[14..16].parse().ok()?;
    let second: i64 = s[17..19].parse().ok()?;

    if month < 1 || month > 12 || day < 1 || day > 31 {
        return None;
    }

    // Days since Unix epoch (1970-01-01) using the algorithm from the C
    // standard (proleptic Gregorian calendar, civil time assumed UTC).
    let y = if month <= 2 { year - 1 } else { year };
    let m = if month <= 2 { month + 9 } else { month - 3 };
    let d = day;

    // Days from civil epoch (0000-03-01) to Unix epoch (1970-01-01).
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400); // year-of-era [0, 399]
    let doy = (153 * m + 2) / 5 + d - 1; // day-of-year [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // day-of-era [0, 146096]
    let days = era * 146097 + doe - 719468; // days since Unix epoch

    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

/// Extract GPS decimal-degree coordinates from EXIF.
fn extract_gps(exif: &exif::Exif) -> (Option<f64>, Option<f64>) {
    use exif::{In, Tag};

    let lat = gps_rational_to_decimal(
        exif.get_field(Tag::GPSLatitude, In::PRIMARY),
        exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY),
        "S",
    );
    let lon = gps_rational_to_decimal(
        exif.get_field(Tag::GPSLongitude, In::PRIMARY),
        exif.get_field(Tag::GPSLongitudeRef, In::PRIMARY),
        "W",
    );

    (lat, lon)
}

/// Convert a GPS rational field (degrees, minutes, seconds) and its reference
/// field to a signed decimal-degree value.
///
/// `negative_ref` is the reference string that makes the value negative
/// (e.g. "S" for latitude, "W" for longitude).
fn gps_rational_to_decimal(
    coord_field: Option<&exif::Field>,
    ref_field: Option<&exif::Field>,
    negative_ref: &str,
) -> Option<f64> {
    let rationals = match &coord_field?.value {
        exif::Value::Rational(v) => v,
        _ => return None,
    };
    if rationals.len() < 3 {
        return None;
    }

    let deg = rationals[0].to_f64();
    let min = rationals[1].to_f64();
    let sec = rationals[2].to_f64();
    let decimal = deg + min / 60.0 + sec / 3600.0;

    let sign = match &ref_field?.value {
        exif::Value::Ascii(v) => {
            let r = v.first()?;
            let r_str = std::str::from_utf8(r).ok()?.trim();
            if r_str.eq_ignore_ascii_case(negative_ref) { -1.0 } else { 1.0 }
        }
        _ => return None,
    };

    Some(decimal * sign)
}

/// Return `true` if the path's extension indicates a supported image format.
fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "tiff" | "tif" | "heic" | "heif" | "webp")
    )
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    use crate::db::photos::{open, query_by_time_range, Page};

    fn mem_db() -> Connection {
        open(":memory:").expect("open in-memory DB")
    }

    fn write_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(contents).unwrap();
        p
    }

    // ── compute_sha256 ──────────────────────────────────────────────────────

    #[test]
    fn sha256_of_empty_file_is_known_value() {
        let dir = TempDir::new().unwrap();
        let path = write_file(dir.path(), "empty.jpg", &[]);
        let hash = compute_sha256(&path).unwrap();
        // SHA-256 of empty input
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_deterministic_for_same_content() {
        let dir = TempDir::new().unwrap();
        let data = b"hello photo";
        let p1 = write_file(dir.path(), "a.jpg", data);
        let p2 = write_file(dir.path(), "b.jpg", data);
        assert_eq!(compute_sha256(&p1).unwrap(), compute_sha256(&p2).unwrap());
    }

    #[test]
    fn sha256_differs_for_different_content() {
        let dir = TempDir::new().unwrap();
        let p1 = write_file(dir.path(), "a.jpg", b"aaa");
        let p2 = write_file(dir.path(), "b.jpg", b"bbb");
        assert_ne!(compute_sha256(&p1).unwrap(), compute_sha256(&p2).unwrap());
    }

    // ── is_image_path ───────────────────────────────────────────────────────

    #[test]
    fn image_extensions_recognised() {
        for ext in &["jpg", "jpeg", "JPG", "JPEG", "png", "PNG", "tiff", "heic", "heif", "webp"] {
            let name = format!("photo.{ext}");
            let p = Path::new(&name);
            assert!(is_image_path(p), "{ext} should be recognised");
        }
    }

    #[test]
    fn non_image_extensions_rejected() {
        for name in &["readme.txt", "archive.zip", "script.sh", "photo.bmp"] {
            assert!(!is_image_path(Path::new(name)), "{name} should not be recognised");
        }
    }

    // ── parse_exif_datetime ─────────────────────────────────────────────────

    #[test]
    fn parse_known_datetime() {
        // 2024-01-15 12:30:00 UTC → verify by manual calculation
        let ts = parse_exif_datetime("2024:01:15 12:30:00").unwrap();
        // Use a second known good value: 2000-01-01 00:00:00 = 946684800
        let epoch_2000 = parse_exif_datetime("2000:01:01 00:00:00").unwrap();
        assert_eq!(epoch_2000, 946_684_800);
        // And the Unix epoch itself
        let epoch_unix = parse_exif_datetime("1970:01:01 00:00:00").unwrap();
        assert_eq!(epoch_unix, 0);
        // ts is after 2000 epoch
        assert!(ts > epoch_2000);
    }

    #[test]
    fn parse_invalid_datetime_returns_none() {
        assert!(parse_exif_datetime("").is_none());
        assert!(parse_exif_datetime("not-a-date").is_none());
        assert!(parse_exif_datetime("2024:13:01 00:00:00").is_none()); // month 13
    }

    // ── scan_directory ──────────────────────────────────────────────────────

    #[test]
    fn scan_adds_new_image_files() {
        let conn = mem_db();
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "photo.jpg", b"fake jpeg data");
        write_file(dir.path(), "readme.txt", b"not an image"); // should be ignored

        let report = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(report.updated, 0);
        assert_eq!(report.removed, 0);
        assert!(report.errors.is_empty());
    }

    #[test]
    fn scan_unchanged_file_is_skipped() {
        let conn = mem_db();
        let dir = TempDir::new().unwrap();
        write_file(dir.path(), "photo.jpg", b"same content");

        // First scan: adds the file.
        let r1 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r1.added, 1);

        // Second scan: hash matches → unchanged.
        let r2 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r2.added, 0);
        assert_eq!(r2.updated, 0);
        assert_eq!(r2.unchanged, 1);
    }

    #[test]
    fn scan_modified_file_is_updated() {
        let conn = mem_db();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("photo.jpg");

        std::fs::write(&path, b"original").unwrap();
        let r1 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r1.added, 1);

        // Overwrite with different content.
        std::fs::write(&path, b"modified").unwrap();
        let r2 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r2.added, 0);
        assert_eq!(r2.updated, 1);
        assert_eq!(r2.unchanged, 0);
    }

    #[test]
    fn scan_removes_deleted_files() {
        let conn = mem_db();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("photo.jpg");

        std::fs::write(&path, b"data").unwrap();
        let r1 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r1.added, 1);

        // Remove the file from disk.
        std::fs::remove_file(&path).unwrap();
        let r2 = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(r2.removed, 1);

        // DB should now have no photos.
        let remaining =
            query_by_time_range(&conn, 0, i64::MAX, &Page { limit: 10, offset: 0 }).unwrap();
        // (photo had no EXIF timestamp, so it won't appear in time-range, but
        //  the row should be gone — verify via get_photo_by_path)
        let gone = get_photo_by_path(&conn, path.to_str().unwrap()).unwrap();
        assert!(gone.is_none(), "deleted photo should not be in DB");
        let _ = remaining; // suppress unused warning
    }

    #[test]
    fn scan_nonexistent_directory_returns_error() {
        let conn = mem_db();
        let result = scan_directory(&conn, Path::new("/nonexistent/path/xyz"));
        assert!(matches!(result, Err(ScanError::DirectoryNotFound(_))));
    }

    #[test]
    fn scan_recurses_into_subdirectories() {
        let conn = mem_db();
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        write_file(&sub, "deep.jpg", b"nested photo");

        let report = scan_directory(&conn, dir.path()).unwrap();
        assert_eq!(report.added, 1);
    }
}

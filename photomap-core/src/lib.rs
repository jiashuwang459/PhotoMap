pub mod db;
pub mod scanner;

pub use db::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    query_all_photos,
    get_photo_by_path, delete_photo_by_path, list_photos_by_path_prefix,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
};
pub use scanner::{scan_directory, compute_sha256, ScanError, ScanReport, ScanEntryError};

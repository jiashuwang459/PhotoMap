pub mod db;
pub mod scanner;
pub mod thumbnail;

pub use db::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    query_all_photos,
    get_photo_by_path, delete_photo_by_path, list_photos_by_path_prefix,
    query_photos_needing_review,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    suggest_photos_for_trips,
    Trip, TripPhotoSuggestion,
};
pub use scanner::{scan_directory, compute_sha256, ScanError, ScanReport, ScanEntryError};
pub use thumbnail::{
    generate_thumbnail, generate_thumbnails_batch, generate_thumbnail_for_photo,
    thumbnail_path_for,
    ThumbnailBatchReport, ThumbnailEntryError, ThumbnailError, MAX_THUMB_RETRIES,
};

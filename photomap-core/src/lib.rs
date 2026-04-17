pub mod db;
pub mod scanner;
pub mod thumbnail;

pub use db::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    query_all_photos,
    get_photo_by_path, get_photo_by_id, delete_photo_by_path, list_photos_by_path_prefix,
    query_photos_needing_review,
    delete_thumbnail, clear_all_thumbnails,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    delete_all_suggested_trips,
    suggest_photos_for_trips,
    Trip, TripPhotoSuggestion, TripGroupResult, AutoGroupDefaults,
    DEFAULT_GAP_SECONDS, DEFAULT_MIN_TRIP_KM,
    DEFAULT_GEO_SPLIT_KM, DEFAULT_HOME_DENSITY_MULTIPLIER, DEFAULT_MIN_PHOTOS_PER_TRIP,
    get_auto_group_defaults,
    get_home_location, set_home_location,
    infer_home_location, infer_and_save_home_location,
    home_at,
    list_home_transitions, create_home_transition,
    confirm_home_transition, dismiss_home_transition,
    detect_home_transitions,
    HomeLocation, HomeTransition,
};
pub use scanner::{scan_directory, compute_sha256, ScanError, ScanReport, ScanEntryError};
pub use thumbnail::{
    generate_thumbnail, generate_thumbnails_batch, generate_thumbnail_for_photo,
    count_pending_thumbnails, thumbnail_path_for,
    ThumbnailBatchReport, ThumbnailEntryError, ThumbnailError, MAX_THUMB_RETRIES, THUMB_SIZE,
};

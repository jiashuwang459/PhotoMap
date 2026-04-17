pub mod photos;
pub mod schema;
pub mod settings;
pub mod trips;

pub use photos::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    query_all_photos,
    get_photo_by_path, get_photo_by_id, delete_photo_by_path, list_photos_by_path_prefix,
    query_photos_needing_review,
    delete_thumbnail, clear_all_thumbnails,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
};

pub use trips::{
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    delete_all_suggested_trips,
    suggest_photos_for_trips,
    Trip, TripPhotoSuggestion, TripGroupResult,
    DEFAULT_GAP_SECONDS, DEFAULT_MIN_TRIP_KM,
};

pub use settings::{
    get_home_location, set_home_location,
    infer_home_location, infer_and_save_home_location,
    home_at,
    list_home_transitions, confirm_home_transition, dismiss_home_transition,
    detect_home_transitions,
    HomeLocation, HomeTransition,
};

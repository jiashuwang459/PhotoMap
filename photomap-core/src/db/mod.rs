pub mod photos;
pub mod schema;
pub mod trips;

pub use photos::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    query_all_photos,
    get_photo_by_path, delete_photo_by_path, list_photos_by_path_prefix,
    query_photos_needing_review,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
};

pub use trips::{
    create_trip, list_trips, get_trip, delete_trip,
    confirm_trip, rename_trip, set_photo_trip,
    query_photos_by_trip, query_untripped_photos, auto_group_trips,
    Trip,
};

pub mod photos;
pub mod schema;

pub use photos::{
    open, run_migrations,
    upsert_photo, query_by_time_range, query_by_bounding_box,
    get_photo_by_path, delete_photo_by_path, list_photos_by_path_prefix,
    BoundingBox, DbError, InsertPhoto, Page, Photo,
};

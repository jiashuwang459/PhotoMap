pub mod commands;
pub mod db;

use std::sync::Mutex;
use tauri::Manager;

use commands::{
    DbState, ThumbnailDirState,
    cmd_upsert_photo, cmd_query_by_time_range, cmd_query_by_bounding_box,
    cmd_scan_directory, cmd_delete_photo, cmd_query_all_photos, cmd_get_photo_by_path,
    cmd_list_trips, cmd_get_trip, cmd_create_trip, cmd_delete_trip,
    cmd_confirm_trip, cmd_rename_trip, cmd_set_photo_trip,
    cmd_query_photos_by_trip, cmd_query_untripped_photos, cmd_auto_group_trips,
    cmd_generate_thumbnails_batch, cmd_query_photos_needing_review,
    cmd_generate_thumbnail_for_photo, cmd_suggest_photos_for_trips,
};
use photomap_core::db as core_db;

/// Build and return the Tauri application.
///
/// Exposed as a public function so it can be driven from both `main.rs`
/// (production) and integration tests.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve the application data directory and open (or create) the
            // SQLite database there.  The path is platform-specific but always
            // writable by the application.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");

            std::fs::create_dir_all(&data_dir).expect("failed to create app data directory");

            let db_path = data_dir.join("photomap.db");
            let conn = core_db::open(db_path.to_str().expect("non-UTF-8 db path"))
                .expect("failed to open database");

            // Thumbnail output directory.
            let thumbnail_dir = data_dir.join("thumbnails");
            std::fs::create_dir_all(&thumbnail_dir)
                .expect("failed to create thumbnails directory");

            app.manage(DbState(Mutex::new(conn)));
            app.manage(ThumbnailDirState(thumbnail_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_upsert_photo,
            cmd_query_by_time_range,
            cmd_query_by_bounding_box,
            cmd_scan_directory,
            cmd_delete_photo,
            cmd_query_all_photos,
            cmd_get_photo_by_path,
            cmd_list_trips,
            cmd_get_trip,
            cmd_create_trip,
            cmd_delete_trip,
            cmd_confirm_trip,
            cmd_rename_trip,
            cmd_set_photo_trip,
            cmd_query_photos_by_trip,
            cmd_query_untripped_photos,
            cmd_auto_group_trips,
            cmd_generate_thumbnails_batch,
            cmd_query_photos_needing_review,
            cmd_generate_thumbnail_for_photo,
            cmd_suggest_photos_for_trips,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

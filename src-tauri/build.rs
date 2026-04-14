fn main() {
    // Generates the Tauri context into OUT_DIR so `tauri::generate_context!()` works.
    tauri_build::build();
}
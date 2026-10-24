#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One `.plugin(...)` per line, so feature branches union cleanly.
        .run(tauri::generate_context!())
        .expect("error while running the Planner desktop app");
}

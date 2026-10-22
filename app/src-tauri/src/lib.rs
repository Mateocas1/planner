mod deeplink;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One `.plugin(...)` per line, so feature branches union cleanly.
        // single-instance must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| deeplink::on_second_instance(app)))
        .plugin(tauri_plugin_deep_link::init())
        .manage(deeplink::PendingRoute::default())
        .invoke_handler(tauri::generate_handler![deeplink::deeplink_take_pending])
        .setup(|app| {
            deeplink::setup(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Planner desktop app");
}

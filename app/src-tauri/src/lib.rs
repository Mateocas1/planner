mod deeplink;
mod google_oauth;
mod quickadd;
mod idle;
mod notify;
mod tray;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One `.plugin(...)` per line, so feature branches union cleanly.
        // single-instance must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| deeplink::on_second_instance(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // One-time close-to-tray notice (T6); Rust shows it, no JS permission.
        .plugin(tauri_plugin_notification::init())
        .manage(deeplink::PendingRoute::default())
        .manage(google_oauth::OAuthFlow::default())
        .manage(quickadd::QuickAddState::default())
        .invoke_handler(tauri::generate_handler![
            deeplink::deeplink_take_pending,
            google_oauth::google_oauth_start,
            google_oauth::google_oauth_revoke,
            google_oauth::google_oauth_cancel,
            notify::notify_show,
            window::desktop_backdrop,
            quickadd::quickadd_get_config,
            quickadd::quickadd_set_shortcut,
            quickadd::quickadd_focus_main,
            idle::idle_seconds,
            tray::tray_sync,
        ])
        .setup(|app| {
            deeplink::setup(app.handle())?;
            quickadd::setup(app.handle())?;
            tray::setup(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Planner desktop app");
}

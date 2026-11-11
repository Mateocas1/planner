mod autostart;
mod chat;
mod deeplink;
mod google_oauth;
mod quickadd;
mod idle;
mod memory;
mod notify;
mod tray;
mod pill;
#[cfg(target_os = "linux")]
mod refresh;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux only, before any GTK or tauri init: WebKit reads this variable once
    // (`PLANNER_HZ=60` opts out). The webview half is in `window.rs`.
    #[cfg(target_os = "linux")]
    refresh::configure_env();
    let builder = tauri::Builder::default()
        // One `.plugin(...)` per line, so feature branches union cleanly.
        // single-instance must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| deeplink::on_second_instance(app, &argv)))
        // The pill window keeps its own position (src/pill.rs): the plugin's
        // `visible` restore would re-show it on launch without a session.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(autostart::window_state_flags())
                .with_filter(|label| label != "pill")
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // One-time close-to-tray notice; Rust shows it, no JS permission.
        .plugin(tauri_plugin_notification::init())
        .plugin(autostart::plugin())
        .manage(deeplink::PendingRoute::default())
        .manage(chat::ChatStreams::default())
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
            autostart::desktop_launched_at_sign_in,
            autostart::desktop_show_main,
            pill::pill_focus_main,
            pill::pill_main_focused,
            pill::pill_visibility_changed,
            chat::chat_key_status,
            chat::chat_key_set,
            chat::chat_key_clear,
            chat::chat_stream,
            chat::chat_cancel,
            chat::chat_complete,
            chat::memory_store::chat_memories_list,
            chat::memory_store::chat_memories_apply,
            chat::memory_store::chat_memories_delete,
            chat::memory_store::chat_memories_clear,
            chat::engram::engram_settings_get,
            chat::engram::engram_settings_set,
            chat::engram::engram_sync_now,
            chat::engram::engram_status,
        ])
        // A cold quick-add launch waits for the quick-add page (quickadd.rs).
        .on_page_load(|webview, payload| quickadd::on_page_load(webview, payload.event()))
        .setup(|app| {
            deeplink::setup(app.handle())?;
            quickadd::setup(app.handle())?;
            tray::setup(app.handle())?;
            autostart::setup(app.handle());
            pill::setup(app.handle())?;
            Ok(())
        });
    // Linux only, so the Windows builder is unchanged.
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(window::webkitgtk_marker());
    builder
        .run(tauri::generate_context!())
        .expect("error while running the Planner desktop app");
}

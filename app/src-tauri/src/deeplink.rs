//! `calendar://` deep links: the Tauri glue around `planner_core::route`.
//!
//! A link is parsed in Rust into a closed route set and stored; the webview is
//! only pinged ("a route is waiting") and then asks for it with
//! `deeplink_take_pending`. No URL text is ever evaluated or navigated to, and a
//! link that is not one of the known routes is dropped here.

use std::sync::Mutex;

use planner_core::route::{last_route, Route};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;

/// Emitted to the main window, without payload, when a route is waiting.
const PENDING_EVENT: &str = "deeplink-pending";

/// The last valid route that arrived and was not taken yet. It also covers a
/// link that launched the app before the webview finished loading.
#[derive(Default)]
pub struct PendingRoute(Mutex<Option<Route>>);

/// Brings the main window forward. Used for every link and for a second launch.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn handle_urls<R: Runtime, S: AsRef<str>>(app: &AppHandle<R>, urls: impl IntoIterator<Item = S>) {
    let Some(route) = last_route(urls) else { return };
    if let Ok(mut pending) = app.state::<PendingRoute>().0.lock() {
        *pending = Some(route);
    }
    focus_main(app);
    let _ = app.emit_to("main", PENDING_EVENT, ());
}

/// Hands the waiting route to the webview, once.
#[tauri::command]
pub fn deeplink_take_pending(state: State<'_, PendingRoute>) -> Option<Route> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

/// A second launch does not open a second window: it focuses the running one.
/// (The single-instance plugin's `deep-link` feature forwards a link in `argv`
/// to the deep-link handler registered in `setup`.)
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>) {
    focus_main(app);
}

/// Registers the live handler and picks up the link that started the app.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let links = app.deep_link();
    // An unbundled debug exe has no installer to write the registry entry.
    #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
    let _ = links.register_all();
    if let Some(urls) = links.get_current()? {
        handle_urls(app, urls.iter().map(|url| url.as_str()));
    }
    let handle = app.clone();
    links.on_open_url(move |event| {
        let urls = event.urls();
        handle_urls(&handle, urls.iter().map(|url| url.as_str()));
    });
    Ok(())
}

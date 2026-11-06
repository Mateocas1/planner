//! Window chrome for the desktop shell (task T3, spec S6).
//!
//! The window itself keeps native Windows decorations: the OS draws the
//! caption buttons (min / max-restore / close with the system hover states,
//! the red close hover and the snap-layouts flyout on maximize hover), and
//! the caption strip is a native drag region with double-click maximize.
//! Keeping `decorations` on is what guarantees that behaviour; see the T3
//! report for why `tauri-plugin-decorum` was rejected.
//!
//! What we add on top is the Windows 11 Mica backdrop: the webview is
//! transparent (wry only clears the WebView2 composition background), so the
//! DWM system backdrop shows through wherever the page paints nothing. On
//! Windows 10 (and Mica-less systems) `apply_mica` fails, the frontend drops
//! the `desktop-mica` class and the page keeps its opaque designed
//! background — a plain window, no crash.

use tauri::{Runtime, WebviewWindow};

/// Applies the Mica backdrop for `dark` or `light` appearance.
///
/// `Some(dark)` also flips `DWMWA_USE_IMMERSIVE_DARK_MODE`, so the native
/// caption strip (text colour, button glyphs) and the backdrop tint follow
/// the app's theme even when the OS setting differs. Called again on every
/// theme change from the frontend; re-applying is idempotent.
#[cfg(target_os = "windows")]
pub fn apply_backdrop<R: Runtime>(window: &WebviewWindow<R>, dark: bool) -> Result<(), String> {
    window_vibrancy::apply_mica(window, Some(dark)).map_err(|error| error.to_string())
}

/// Non-Windows builds (e.g. a Linux `cargo check` of this crate) never run
/// the shell; the frontend treats the error as "opaque window" and keeps the
/// web-only background.
#[cfg(not(target_os = "windows"))]
pub fn apply_backdrop<R: Runtime>(_window: &WebviewWindow<R>, _dark: bool) -> Result<(), String> {
    Err("window backdrops are Windows-only".into())
}

/// Frontend command: re-apply the Mica backdrop for the current theme.
///
/// Returns `Err` on Windows 10 / unsupported systems; the frontend then keeps
/// the page opaque (the web design), so the window degrades to a plain
/// opaque window instead of showing content over the raw desktop.
#[tauri::command]
pub fn desktop_backdrop<R: Runtime>(window: WebviewWindow<R>, dark: bool) -> Result<(), String> {
    apply_backdrop(&window, dark)
}

/// Linux: marks every webview as WebKitGTK before any app script runs
/// (`window.__WEBKITGTK__`), so `main.tsx` installs the end-of-animation guard
/// in `src/ui/compositorHandoff.ts` (Ronda 6 S5). WebKitGTK presents one stale
/// frame when a compositor animation ends; WebView2 does not, so Windows never
/// registers this plugin.
#[cfg(target_os = "linux")]
pub fn webkitgtk_marker<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webkitgtk-marker")
        .js_init_script("window.__WEBKITGTK__ = true;".to_string())
        .build()
}

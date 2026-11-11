//! Start at sign-in.
//!
//! The autostart entry (HKCU `Run`, no admin rights) launches Planner with
//! `--autostart`. Such a launch leaves the main window hidden: the frontend
//! (`src/desktop-autostart.ts`) shows it only when today's morning brief applies,
//! and otherwise the process waits in the tray. Every other launch shows
//! the window in `setup`, as before.
//!
//! The window is created hidden (`visible: false` in `tauri.conf.json`), so a
//! sign-in launch never flashes it. `tauri-plugin-window-state` would show a
//! window when its saved `visible` flag is set (or no state exists yet), so the
//! plugin does not manage visibility at all: see `window_state_flags`.
//!
//! A launch carrying the quick-add trigger (`--quickadd` or
//! `calendar://quickadd`, a Hyprland bind while nothing ran) also keeps the
//! main window hidden and opens the quick-add window instead.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

use crate::deeplink;

/// The argument the autostart entry passes to the executable.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Whether this process was started by the sign-in entry.
#[derive(Default)]
pub struct SignInLaunch(bool);

/// Enable / disable / is-enabled for the settings toggle (the plugin's default
/// permission set, `autostart:default`, in `capabilities/default.json`).
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG]))
}

/// Every window-state flag except visibility: the plugin restores and saves
/// size, position, maximized and fullscreen, never whether the window shows.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all().difference(StateFlags::VISIBLE)
}

/// Records how the app was started and shows the main window for every launch
/// except a sign-in or quick-add one. Runs after the window exists and its
/// state is restored.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .filter_map(|arg| arg.into_string().ok())
        .collect();
    let at_sign_in = args.iter().any(|arg| arg == AUTOSTART_ARG);
    let quick_add = planner_core::launch::quickadd_requested(&args);
    app.manage(SignInLaunch(at_sign_in));
    if quick_add {
        crate::quickadd::show_on_cold_start(app);
    } else if !at_sign_in {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
        }
    }
}

/// Frontend query: whether this launch came from the sign-in entry.
#[tauri::command]
pub fn desktop_launched_at_sign_in(state: State<'_, SignInLaunch>) -> bool {
    state.0
}

/// Frontend command: reveal the main window (a sign-in launch whose brief applies).
#[tauri::command]
pub fn desktop_show_main<R: Runtime>(app: AppHandle<R>) {
    deeplink::focus_main(&app);
}

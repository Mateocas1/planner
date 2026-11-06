//! The global quick-add window (task T5, spec S8.1).
//!
//! A global hotkey (`Ctrl+Alt+Space` by default, L12) toggles a small
//! frameless window that reuses the planner's natural-language quick add.
//! Everything the OS needs lives here: shortcut registration, the persisted
//! user choice, cursor-monitor centering and hide-on-blur. The webview owns
//! the parsing and the write path (the same `parseQuickAdd` → `addTask` /
//! `addSeries` used by the main window's sheet) — this module never sees task
//! data.
//!
//! Registration is best-effort by design: if another app already owns the
//! combination, the failure is recorded in state and surfaced by the settings
//! UI (`quickadd_get_config`); the app itself keeps working. The same holds
//! when the user picks a taken combination in Day settings —
//! `quickadd_set_shortcut` rolls back to the previous shortcut and reports the
//! failure instead of leaving the app hotkey-less.
//!
//! Under Wayland (Hyprland) an app cannot grab global keys: the plugin's X11
//! grab only sees XWayland windows. There the shell registers nothing, the
//! status reports the chord as unregistered, and the compositor binds the same
//! chord to `planner --quickadd` (or `calendar://quickadd`), which reaches
//! `toggle_window` through the single-instance plugin. A cold launch with the
//! trigger shows the window once its page has loaded (`on_page_load`), so the
//! reveal event that focuses the field is not sent before anyone listens.
//!
//! The Hyprland snippet binds the chord chosen here: under Wayland the shell
//! writes it to `$XDG_DATA_HOME/planner/quickadd.bind` (Hyprland's key-string
//! form, `planner_core::hyprbind`) and runs `hyprctl reload` inside a Hyprland
//! session, so a new chord in Day settings takes effect without editing the
//! compositor config.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State, Webview, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// L12: the user picked `Ctrl+Alt+Space` over the alternatives.
const DEFAULT_SHORTCUT: &str = "ctrl+alt+Space";

/// Emitted to the quick-add window every time the hotkey reveals it, so the
/// page can focus the field and replay its short entrance.
const SHOWN_EVENT: &str = "quickadd-shown";

/// Why the chord is not registered under Wayland (read by `quickadd_get_config`).
const WAYLAND_NOTE: &str =
    "Wayland: the compositor binds this chord to `planner --quickadd` (Planner's Hyprland snippet follows it).";

/// Whether this session runs on Wayland, where the shell leaves the chord to
/// the compositor. Always `false` off Linux.
fn wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        let display = std::env::var("WAYLAND_DISPLAY").ok();
        let backend = std::env::var("GDK_BACKEND").ok();
        planner_core::launch::wayland_session(display.as_deref(), backend.as_deref())
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Writes `shortcut` to the Hyprland snippet's bind file when it changed, then
/// reloads Hyprland when this session runs inside one. Best-effort and quiet:
/// a chord with no Hyprland form, an unwritable data dir or a missing `hyprctl`
/// leave the previous bind in place. At `startup` a missing file stays missing
/// for the default chord (the snippet falls back to it), so a first launch
/// does not reload the compositor.
#[cfg(target_os = "linux")]
fn sync_compositor_bind(shortcut: &str, startup: bool) {
    use planner_core::hyprbind;
    let Some(bind) = hyprbind::hyprland_bind(shortcut) else {
        eprintln!("quickadd: '{shortcut}' has no Hyprland form; the compositor bind is unchanged");
        return;
    };
    let xdg = std::env::var("XDG_DATA_HOME").ok();
    let home = std::env::var("HOME").ok();
    let Some(path) = hyprbind::bind_file(xdg.as_deref(), home.as_deref()) else { return };
    let current = std::fs::read_to_string(&path).ok();
    if !hyprbind::bind_needs_write(current.as_deref(), &bind, startup) {
        return;
    }
    if let Err(error) = planner_core::fsutil::atomic_write(&path, &hyprbind::bind_file_contents(&bind)) {
        eprintln!("quickadd: the Hyprland bind file was not written: {error}");
        return;
    }
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok_and(|value| !value.is_empty()) {
        // Off the caller's thread: the reload re-reads the whole config.
        std::thread::spawn(|| {
            let _ = std::process::Command::new("hyprctl")
                .arg("reload")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn sync_compositor_bind(_shortcut: &str, _startup: bool) {}

/// What the settings UI reads: the configured shortcut, whether the OS
/// actually accepted it, and why not when it did not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub shortcut: String,
    pub registered: bool,
    /// Set when the last registration attempt failed (another app owns the
    /// combination, or the OS refused it). `null` while registered.
    pub error: Option<String>,
}

/// The persisted shape of `app_config_dir/quickadd.json`.
#[derive(Debug, Deserialize, Serialize)]
struct ConfigFile {
    shortcut: String,
}

/// Live registration state, shared between `setup`, the hotkey handler and the
/// commands. `shortcut` is what the user configured; `registered` says whether
/// the OS currently honors it.
#[derive(Default)]
pub struct QuickAddState {
    shortcut: Mutex<Option<String>>,
    registered: AtomicBool,
    /// Cold launch with the trigger: `(asked, page_loaded)`. The window shows
    /// when both are true, whichever arrives second.
    cold_start: Mutex<(bool, bool)>,
}

impl QuickAddState {
    fn status(&self) -> ShortcutStatus {
        let shortcut = self
            .shortcut
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
        ShortcutStatus {
            shortcut,
            registered: self.registered.load(Ordering::Relaxed),
            error: wayland().then(|| WAYLAND_NOTE.to_string()),
        }
    }

    fn set(&self, shortcut: String, registered: bool) {
        if let Ok(mut guard) = self.shortcut.lock() {
            *guard = Some(shortcut);
        }
        self.registered.store(registered, Ordering::Relaxed);
    }
}

/// `app_config_dir/quickadd.json`, or `None` when the config dir cannot be
/// resolved (then the default shortcut applies and changes are not persisted).
fn config_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("quickadd.json"))
}

fn load_config<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let path = config_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ConfigFile>(&text).ok().map(|c| c.shortcut)
}

fn save_config<R: Runtime>(app: &AppHandle<R>, shortcut: &str) {
    let Some(path) = config_path(app) else { return };
    let Ok(text) = serde_json::to_string(&ConfigFile {
        shortcut: shortcut.to_string(),
    }) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, text);
}

/// Validates a shortcut string: it must parse as an accelerator and carry at
/// least one modifier — a bare key would swallow that key system-wide.
fn validate(shortcut: &str) -> Result<(), String> {
    let parsed = Shortcut::from_str(shortcut)
        .map_err(|_| "Include a modifier key (Ctrl, Alt, Shift or the Windows key) plus a regular key.".to_string())?;
    if parsed.mods.is_empty() {
        return Err("Include a modifier key (Ctrl, Alt, Shift or the Windows key) plus a regular key.".to_string());
    }
    Ok(())
}

/// Registers `shortcut` globally. The handler toggles the quick-add window on
/// the press edge only — the release must not toggle it straight back.
fn register<R: Runtime>(app: &AppHandle<R>, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_window(app);
            }
        })
        .map_err(|error| error.to_string())
}

/// Shows the quick-add window centered on the monitor that holds the cursor,
/// or hides it when it is already visible. The cursor monitor keeps the window
/// next to the user's attention on every multi-monitor desk.
pub fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("quickadd") else { return };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        // T12: hidden again — the popup's webview aims low between uses.
        crate::memory::sync_quickadd(&window);
        return;
    }
    center_on_cursor(&window);
    let _ = window.show();
    let _ = window.set_focus();
    // T12: on screen — back to the normal target before the user types.
    crate::memory::sync_quickadd(&window);
    let _ = app.emit_to("quickadd", SHOWN_EVENT, ());
}

/// Centers `window` on the monitor holding the cursor. Best-effort: without a
/// cursor or monitor reading, the window stays wherever the OS puts it.
fn center_on_cursor<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(cursor) = window.cursor_position() else { return };
    let Ok(size) = window.outer_size() else { return };
    let monitor = window
        .monitor_from_point(cursor.x, cursor.y)
        .or_else(|_| window.current_monitor())
        .ok()
        .flatten();
    let Some(monitor) = monitor else { return };
    let origin = monitor.position();
    let bounds = monitor.size();
    // Center, clamped so the window can never poke off-monitor.
    let x = origin.x + (((bounds.width as i32 - size.width as i32) / 2).max(0));
    let y = origin.y + (((bounds.height as i32 - size.height as i32) / 2).max(0));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Startup: load the persisted shortcut (default when missing or corrupt),
/// register it, remember the outcome and hide the quick-add window whenever it
/// loses focus. Every failure here degrades, never aborts: the shell must
/// start with or without a working hotkey.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = load_config(app)
        .filter(|stored| validate(stored).is_ok())
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());

    let status = if wayland() {
        sync_compositor_bind(&shortcut, true);
        ShortcutStatus { shortcut: shortcut.clone(), registered: false, error: Some(WAYLAND_NOTE.to_string()) }
    } else {
        match register(app, &shortcut) {
            Ok(()) => ShortcutStatus { shortcut: shortcut.clone(), registered: true, error: None },
            Err(error) => ShortcutStatus { shortcut: shortcut.clone(), registered: false, error: Some(error) },
        }
    };
    app.state::<QuickAddState>().set(status.shortcut.clone(), status.registered);
    if let Some(error) = &status.error {
        eprintln!("quickadd: hotkey '{}' not registered: {}", status.shortcut, error);
    }

    // Hide on blur: a floating palette that stays up after clicking elsewhere
    // is in the way, not on hand.
    if let Some(window) = app.get_webview_window("quickadd") {
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(false)) {
                if let Some(window) = handle.get_webview_window("quickadd") {
                    let _ = window.hide();
                    crate::memory::sync_quickadd(&window);
                }
            }
        });
        // T12: the window is created hidden and usually stays that way, so its
        // first state is LOW. The hotkey path flips it back to NORMAL.
        crate::memory::sync_quickadd(&window);
    }

    Ok(())
}

/// A launch that carried the quick-add trigger (`planner --quickadd` from a
/// compositor bind while nothing was running). Shows the window now if its
/// page already loaded, otherwise when it does.
pub fn show_on_cold_start<R: Runtime>(app: &AppHandle<R>) {
    let ready = {
        let state = app.state::<QuickAddState>();
        let Ok(mut cold) = state.cold_start.lock() else { return };
        cold.0 = true;
        cold.1
    };
    if ready {
        reveal_cold(app);
    }
}

/// `tauri::Builder::on_page_load` hook: records that the quick-add page
/// finished loading and shows the window when a cold start asked for it.
pub fn on_page_load<R: Runtime>(webview: &Webview<R>, event: PageLoadEvent) {
    if webview.label() != "quickadd" || event != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle();
    let asked = {
        let state = app.state::<QuickAddState>();
        let Ok(mut cold) = state.cold_start.lock() else { return };
        cold.1 = true;
        cold.0
    };
    if asked {
        reveal_cold(app);
    }
}

/// Shows the window for a cold start, once. The page registers its reveal
/// listener in an effect right after load, so the show waits a moment for it.
fn reveal_cold<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut cold) = app.state::<QuickAddState>().cold_start.lock() {
        if !cold.0 {
            return;
        }
        cold.0 = false;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let visible = inner
                .get_webview_window("quickadd")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if !visible {
                toggle_window(&inner);
            }
        });
    });
}

/// Frontend command: the current shortcut and whether the OS accepted it.
#[tauri::command]
pub fn quickadd_get_config(state: State<'_, QuickAddState>) -> ShortcutStatus {
    state.status()
}

/// Frontend command: switch the global shortcut (Day settings). Validates,
/// swaps the registration live, persists the choice and reports the new
/// status. On a failed registration the previous shortcut is restored, so a
/// taken combination never leaves the app without a working hotkey.
#[tauri::command]
pub fn quickadd_set_shortcut<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, QuickAddState>,
    shortcut: String,
) -> Result<ShortcutStatus, String> {
    let shortcut = shortcut.trim().to_string();
    validate(&shortcut)?;
    if wayland() {
        // Nothing to grab: keep the choice so the settings show it, and leave
        // the binding to the compositor.
        state.set(shortcut.clone(), false);
        save_config(&app, &shortcut);
        sync_compositor_bind(&shortcut, false);
        return Ok(state.status());
    }
    let previous = state.status();

    // Unregister first so re-using a modifier subset of the old combo works.
    let _ = app.global_shortcut().unregister_all();
    let registered = register(&app, &shortcut).is_ok();
    if !registered {
        // Roll back so the user keeps a working hotkey after a refused one.
        let restored = register(&app, &previous.shortcut).is_ok();
        state.set(previous.shortcut.clone(), restored);
        return Err("Another app may already use this combination.".to_string());
    }

    state.set(shortcut.clone(), true);
    save_config(&app, &shortcut);
    Ok(ShortcutStatus { shortcut, registered: true, error: None })
}

/// Frontend command: focus the main window. Used when the quick-add window is
/// opened signed out — the message tells the user to sign in there.
#[tauri::command]
pub fn quickadd_focus_main<R: Runtime>(app: AppHandle<R>) {
    crate::deeplink::focus_main(&app);
}

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
//! trigger shows the window once its page says it is listening
//! (`READY_EVENT`), so the reveal event that focuses the field is not sent
//! before anyone listens; a bounded wait after page load covers a page that
//! never says so.
//!
//! The Hyprland snippet binds the chord chosen here: under Wayland the shell
//! writes it to `$XDG_DATA_HOME/planner/quickadd.bind` (Hyprland's key-string
//! form, `planner_core::hyprbind`) and runs `hyprctl reload` inside a Hyprland
//! session, so a new chord in Day settings takes effect without editing the
//! compositor config. When the write or the reload fails, the
//! status reports that instead of the plain Wayland note, so Settings says the
//! chord is saved but not live yet. Syncs run one at a time (`SyncGate`), off
//! the UI thread, and the first config read waits for the startup sync, so its
//! note reaches Settings too.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition, Runtime, State, Webview, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// L12: the user picked `Ctrl+Alt+Space` over the alternatives.
const DEFAULT_SHORTCUT: &str = "ctrl+alt+Space";

/// Emitted to the quick-add window every time the hotkey reveals it, so the
/// page can focus the field and replay its short entrance.
const SHOWN_EVENT: &str = "quickadd-shown";

/// Emitted by the quick-add page once its `SHOWN_EVENT` listener exists
/// (`QUICKADD_READY_EVENT` in `quickAddWindow.ts`): the cold-start handshake.
const READY_EVENT: &str = "quickadd-ready";

/// How long a cold start waits after page load for `READY_EVENT` before it
/// shows the window anyway (an unfocused field beats no window).
const READY_FALLBACK: Duration = Duration::from_millis(1500);

/// How long a config read waits for a bind sync in flight: the reload wait
/// plus the file write.
const SYNC_READ_WAIT: Duration = Duration::from_secs(4);

/// How long a sync waits for the one in flight before it proceeds anyway:
/// a stuck sync delays a Settings save, it does not hang it.
const SYNC_BEGIN_WAIT: Duration = Duration::from_secs(8);

/// Why the chord is not registered under Wayland (read by `quickadd_get_config`).
const WAYLAND_NOTE: &str =
    "Wayland: the compositor binds this chord to `planner --quickadd` (Planner's Hyprland snippet follows it).";

/// Why the chord may not work under Wayland even though it was saved: the
/// Hyprland bind file could not be written, or `hyprctl reload` failed.
/// `desktop.ts` (`quickAddUnregisteredCause`) tells them apart by prefix.
const BIND_WRITE_NOTE: &str =
    "Hyprland bind not written: the chord is saved, but the compositor still binds the previous one.";
const RELOAD_NOTE: &str = "Hyprland reload failed: the chord is saved, but Hyprland did not reload.";

/// How long a bind sync waits for `hyprctl reload` before it stops asking.
#[cfg(target_os = "linux")]
const RELOAD_WAIT: Duration = Duration::from_secs(3);

/// What one compositor bind sync did. Only the two failures reach the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindSync {
    /// Nothing written: the file already matched, or the chord or data dir has
    /// no Hyprland form.
    Unchanged,
    /// Written, with no reload confirmed (no Hyprland session, or the reload
    /// still running after `RELOAD_WAIT`).
    Written,
    Reloaded,
    WriteFailed,
    ReloadFailed,
}

/// The bind-sync note after `outcome`. An unchanged file triggers no reload,
/// so an earlier failure still stands; a write clears it.
fn next_note(previous: Option<&'static str>, outcome: BindSync) -> Option<&'static str> {
    match outcome {
        BindSync::Unchanged => previous,
        BindSync::Written | BindSync::Reloaded => None,
        BindSync::WriteFailed => Some(BIND_WRITE_NOTE),
        BindSync::ReloadFailed => Some(RELOAD_NOTE),
    }
}

/// One compositor bind sync at a time: a Settings save waits for the startup
/// sync, so a stale startup chord can never land after a newer one, and a
/// config read can wait for the sync in flight to see its note. A turn is
/// released when its `SyncTurn` drops, so a sync that panics frees the gate.
#[derive(Default)]
struct SyncGate {
    turn: Mutex<GateTurn>,
    idle: Condvar,
}

/// The sync holding the gate, by token, and the next token to hand out.
#[derive(Default)]
struct GateTurn {
    holder: Option<u64>,
    next: u64,
}

/// A claimed turn at the gate; dropping it releases the gate.
struct SyncTurn<'a> {
    gate: &'a SyncGate,
    token: u64,
}

impl SyncTurn<'_> {
    /// Hands the turn to another thread: the gate stays claimed until
    /// `SyncGate::adopt` takes the token back.
    fn detach(self) -> u64 {
        let token = self.token;
        std::mem::forget(self);
        token
    }
}

impl Drop for SyncTurn<'_> {
    fn drop(&mut self) {
        self.gate.end(self.token);
    }
}

impl SyncGate {
    /// Waits up to `timeout` for the sync in flight, then claims the gate. A
    /// sync still running after that is reported and no longer waited on; its
    /// late release does not free the gate under the newer sync.
    fn begin(&self, timeout: Duration) -> SyncTurn<'_> {
        let mut turn = lock(&self.turn);
        let (guard, waited) = self
            .idle
            .wait_timeout_while(turn, timeout, |turn| turn.holder.is_some())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        turn = guard;
        if waited.timed_out() {
            eprintln!("quickadd: a bind sync is still running after {timeout:?}; proceeding without it");
        }
        let token = turn.next;
        turn.next += 1;
        turn.holder = Some(token);
        SyncTurn { gate: self, token }
    }

    /// Takes back a turn detached with `SyncTurn::detach`.
    fn adopt(&self, token: u64) -> SyncTurn<'_> {
        SyncTurn { gate: self, token }
    }

    fn end(&self, token: u64) {
        let mut turn = lock(&self.turn);
        if turn.holder == Some(token) {
            turn.holder = None;
        }
        drop(turn);
        self.idle.notify_all();
    }

    /// Waits up to `timeout` for no sync to be in flight; `false` on timeout.
    fn wait_idle(&self, timeout: Duration) -> bool {
        let turn = lock(&self.turn);
        self.idle
            .wait_timeout_while(turn, timeout, |turn| turn.holder.is_some())
            .map(|(_, result)| !result.timed_out())
            .unwrap_or(false)
    }
}

/// Locks `mutex`, recovering it from a panicked holder (the gate's state is
/// a plain token, always consistent).
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A cold launch with the trigger: the window shows once it was `asked` for
/// and the page is `ready`, whichever comes second, and only once.
#[derive(Debug, Default)]
struct ColdStart {
    asked: bool,
    ready: bool,
}

impl ColdStart {
    /// The trigger arrived; `true` when the window should show now.
    fn ask(&mut self) -> bool {
        self.asked = true;
        self.take()
    }

    /// The page is listening (or the fallback gave up waiting); `true` when
    /// the window should show now.
    fn ready(&mut self) -> bool {
        self.ready = true;
        self.take()
    }

    fn take(&mut self) -> bool {
        let reveal = self.asked && self.ready;
        if reveal {
            self.asked = false;
        }
        reveal
    }
}

/// Maps `hyprctl reload`'s result (`None` when it did not finish in time).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn reload_outcome(result: Option<std::io::Result<std::process::ExitStatus>>) -> BindSync {
    match result {
        None => BindSync::Written,
        Some(Ok(status)) if status.success() => BindSync::Reloaded,
        Some(_) => BindSync::ReloadFailed,
    }
}

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
/// reloads Hyprland when this session runs inside one, and reports what
/// happened. A chord with no Hyprland form or an unresolvable data dir leave
/// the previous bind in place quietly; a failed write or reload is returned so
/// Settings can say the chord is saved but not live. At `startup` a missing
/// file stays missing for the default chord (the snippet falls back to it), so
/// a first launch does not reload the compositor.
#[cfg(target_os = "linux")]
fn sync_compositor_bind(shortcut: &str, startup: bool) -> BindSync {
    use planner_core::hyprbind;
    let Some(bind) = hyprbind::hyprland_bind(shortcut) else {
        eprintln!("quickadd: '{shortcut}' has no Hyprland form; the compositor bind is unchanged");
        return BindSync::Unchanged;
    };
    let xdg = std::env::var("XDG_DATA_HOME").ok();
    let home = std::env::var("HOME").ok();
    let Some(path) = hyprbind::bind_file(xdg.as_deref(), home.as_deref()) else { return BindSync::Unchanged };
    let current = std::fs::read_to_string(&path).ok();
    if !hyprbind::bind_needs_write(current.as_deref(), &bind, startup) {
        return BindSync::Unchanged;
    }
    if let Err(error) = planner_core::fsutil::atomic_write(&path, &hyprbind::bind_file_contents(&bind)) {
        eprintln!("quickadd: the Hyprland bind file was not written: {error}");
        return BindSync::WriteFailed;
    }
    if !std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok_and(|value| !value.is_empty()) {
        return BindSync::Written;
    }
    // On its own thread, waited on for at most `RELOAD_WAIT`: the reload
    // re-reads the whole config and must not hang the caller.
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let status = std::process::Command::new("hyprctl")
            .arg("reload")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = sender.send(status);
    });
    let outcome = reload_outcome(receiver.recv_timeout(RELOAD_WAIT).ok());
    if outcome == BindSync::ReloadFailed {
        eprintln!("quickadd: `hyprctl reload` failed; the new bind is not live yet");
    }
    outcome
}

#[cfg(not(target_os = "linux"))]
fn sync_compositor_bind(_shortcut: &str, _startup: bool) -> BindSync {
    BindSync::Unchanged
}

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
    cold_start: Mutex<ColdStart>,
    /// Why the last compositor bind sync left the chord saved but not live
    /// (`next_note`); shown instead of `WAYLAND_NOTE`.
    bind_note: Mutex<Option<&'static str>>,
    sync_gate: SyncGate,
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
            error: wayland().then(|| self.bind_note().unwrap_or(WAYLAND_NOTE).to_string()),
        }
    }

    fn bind_note(&self) -> Option<&'static str> {
        self.bind_note.lock().ok().and_then(|guard| *guard)
    }

    fn record_bind_sync(&self, outcome: BindSync) {
        if let Ok(mut guard) = self.bind_note.lock() {
            *guard = next_note(*guard, outcome);
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

    let state = app.state::<QuickAddState>();
    let status = if wayland() {
        ShortcutStatus { shortcut: shortcut.clone(), registered: false, error: Some(WAYLAND_NOTE.to_string()) }
    } else {
        match register(app, &shortcut) {
            Ok(()) => ShortcutStatus { shortcut: shortcut.clone(), registered: true, error: None },
            Err(error) => ShortcutStatus { shortcut: shortcut.clone(), registered: false, error: Some(error) },
        }
    };
    state.set(status.shortcut.clone(), status.registered);
    if let Some(error) = &status.error {
        eprintln!("quickadd: hotkey '{}' not registered: {}", status.shortcut, error);
    }
    if wayland() {
        // Off the startup path (a reload can take a moment), with the gate
        // claimed here, before any command can run: a Settings save waits for
        // this sync and the first config read sees its note.
        let token = state.sync_gate.begin(SYNC_BEGIN_WAIT).detach();
        let handle = app.clone();
        std::thread::spawn(move || {
            let state = handle.state::<QuickAddState>();
            let _turn = state.sync_gate.adopt(token);
            state.record_bind_sync(sync_compositor_bind(&shortcut, true));
        });
    }

    // The cold-start handshake: the page emits this once it listens.
    let handle = app.clone();
    app.listen_any(READY_EVENT, move |_| mark_ready(&handle));

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
/// page is already listening, otherwise when it is.
pub fn show_on_cold_start<R: Runtime>(app: &AppHandle<R>) {
    let reveal = {
        let state = app.state::<QuickAddState>();
        let Ok(mut cold) = state.cold_start.lock() else { return };
        cold.ask()
    };
    if reveal {
        reveal_cold(app);
    }
}

/// `tauri::Builder::on_page_load` hook: once the quick-add page has loaded,
/// gives its `READY_EVENT` up to `READY_FALLBACK`, then treats it as ready.
pub fn on_page_load<R: Runtime>(webview: &Webview<R>, event: PageLoadEvent) {
    if webview.label() != "quickadd" || event != PageLoadEvent::Finished {
        return;
    }
    let handle = webview.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_FALLBACK);
        mark_ready(&handle);
    });
}

/// The page is listening (or the fallback stopped waiting): shows the window
/// when a cold start asked for it and it has not shown yet.
fn mark_ready<R: Runtime>(app: &AppHandle<R>) {
    let reveal = {
        let state = app.state::<QuickAddState>();
        let Ok(mut cold) = state.cold_start.lock() else { return };
        cold.ready()
    };
    if reveal {
        reveal_cold(app);
    }
}

/// Shows the window for a cold start on the main thread, unless the user
/// already toggled it in.
fn reveal_cold<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let visible = handle
            .get_webview_window("quickadd")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        if !visible {
            toggle_window(&handle);
        }
    });
}

/// Frontend command: the current shortcut and whether the OS accepted it.
/// Waits (bounded) for a bind sync in flight, so the startup sync's note is
/// not missed; on Linux it runs off the UI thread for that wait.
#[cfg_attr(target_os = "linux", tauri::command(async))]
#[cfg_attr(not(target_os = "linux"), tauri::command)]
pub fn quickadd_get_config(state: State<'_, QuickAddState>) -> ShortcutStatus {
    state.sync_gate.wait_idle(SYNC_READ_WAIT);
    state.status()
}

/// Frontend command: switch the global shortcut (Day settings). Validates,
/// swaps the registration live, persists the choice and reports the new
/// status. On a failed registration the previous shortcut is restored, so a
/// taken combination never leaves the app without a working hotkey. On Linux
/// it runs off the UI thread: a Hyprland reload is waited on for up to
/// `RELOAD_WAIT`. Windows keeps the synchronous command.
#[cfg_attr(target_os = "linux", tauri::command(async))]
#[cfg_attr(not(target_os = "linux"), tauri::command)]
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
        let turn = state.sync_gate.begin(SYNC_BEGIN_WAIT);
        state.set(shortcut.clone(), false);
        save_config(&app, &shortcut);
        state.record_bind_sync(sync_compositor_bind(&shortcut, false));
        drop(turn);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_write_or_reload_gets_its_own_note() {
        assert_eq!(next_note(None, BindSync::WriteFailed), Some(BIND_WRITE_NOTE));
        assert_eq!(next_note(None, BindSync::ReloadFailed), Some(RELOAD_NOTE));
        assert_ne!(BIND_WRITE_NOTE, RELOAD_NOTE);
        // `desktop.ts` tells the causes apart by prefix; none may read as the
        // plain Wayland note.
        for note in [BIND_WRITE_NOTE, RELOAD_NOTE] {
            assert!(!note.starts_with("Wayland:"), "{note}");
        }
        assert!(BIND_WRITE_NOTE.starts_with("Hyprland bind not written:"));
        assert!(RELOAD_NOTE.starts_with("Hyprland reload failed:"));
    }

    #[test]
    fn a_successful_sync_clears_the_note_and_an_unchanged_one_keeps_it() {
        assert_eq!(next_note(Some(RELOAD_NOTE), BindSync::Reloaded), None);
        assert_eq!(next_note(Some(BIND_WRITE_NOTE), BindSync::Written), None);
        // Nothing was written, so nothing was reloaded: the earlier failure stands.
        assert_eq!(next_note(Some(RELOAD_NOTE), BindSync::Unchanged), Some(RELOAD_NOTE));
        assert_eq!(next_note(None, BindSync::Unchanged), None);
    }

    #[test]
    fn a_cold_start_reveals_once_when_asked_and_ready() {
        let mut cold = ColdStart::default();
        assert!(!cold.ask(), "the page is not ready yet");
        assert!(cold.ready(), "the handshake reveals the asked window");
        // The fallback firing after the handshake must not reveal again.
        assert!(!cold.ready());

        let mut early = ColdStart::default();
        assert!(!early.ready(), "ready without a cold-start trigger shows nothing");
        assert!(early.ask(), "a trigger after the handshake reveals at once");
        assert!(!early.ready(), "a late fallback does not reveal it twice");
    }

    #[test]
    fn the_sync_gate_serializes_syncs_and_bounds_the_wait() {
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        let gate = Arc::new(SyncGate::default());
        assert!(gate.wait_idle(Duration::from_millis(1)), "idle at first");
        let first = gate.begin(Duration::from_secs(5));
        let started = Instant::now();
        assert!(!gate.wait_idle(Duration::from_millis(50)), "a stuck sync only delays the read");
        assert!(started.elapsed() < Duration::from_secs(2));
        let other = Arc::clone(&gate);
        let second = std::thread::spawn(move || {
            let _turn = other.begin(Duration::from_secs(5));
        });
        std::thread::sleep(Duration::from_millis(30));
        assert!(!second.is_finished(), "a second sync waits for the first");
        drop(first);
        second.join().unwrap();
        assert!(gate.wait_idle(Duration::from_millis(500)));
    }

    #[test]
    fn a_panicking_sync_releases_the_gate() {
        use std::sync::Arc;
        use std::time::Duration;
        let gate = Arc::new(SyncGate::default());
        let other = Arc::clone(&gate);
        let crashed = std::thread::spawn(move || {
            let _turn = other.begin(Duration::from_secs(5));
            panic!("sync crashed");
        });
        assert!(crashed.join().is_err());
        assert!(gate.wait_idle(Duration::from_millis(100)), "the gate is free again");

        // A turn adopted by the startup thread is released the same way.
        let token = gate.begin(Duration::from_secs(5)).detach();
        let other = Arc::clone(&gate);
        let crashed = std::thread::spawn(move || {
            let _turn = other.adopt(token);
            panic!("startup sync crashed");
        });
        assert!(crashed.join().is_err());
        assert!(gate.wait_idle(Duration::from_millis(100)), "the adopted turn is released");
    }

    #[test]
    fn a_stuck_sync_only_delays_the_next_begin() {
        use std::time::{Duration, Instant};
        let gate = SyncGate::default();
        let stuck = gate.begin(Duration::from_secs(5));
        let started = Instant::now();
        let next = gate.begin(Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_secs(2), "begin gave up waiting");
        // The stuck sync finishing late must not free the gate under the next one.
        drop(stuck);
        assert!(!gate.wait_idle(Duration::from_millis(20)), "the next sync still holds the gate");
        drop(next);
        assert!(gate.wait_idle(Duration::from_millis(20)));
    }

    #[cfg(unix)]
    #[test]
    fn the_reload_exit_status_decides_the_outcome() {
        use std::os::unix::process::ExitStatusExt;
        let ok = std::process::ExitStatus::from_raw(0);
        let failed = std::process::ExitStatus::from_raw(1 << 8);
        assert_eq!(reload_outcome(Some(Ok(ok))), BindSync::Reloaded);
        assert_eq!(reload_outcome(Some(Ok(failed))), BindSync::ReloadFailed);
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "hyprctl");
        assert_eq!(reload_outcome(Some(Err(missing))), BindSync::ReloadFailed);
        // Still running after the wait: unconfirmed, not reported as a failure.
        assert_eq!(reload_outcome(None), BindSync::Written);
    }
}

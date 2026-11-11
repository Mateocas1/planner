//! The mini floating focus-timer pill.
//!
//! A third window (`pill`) is created hidden at startup: small, frameless,
//! transparent, always on top, off the taskbar, and draggable from the page.
//! Its page is the same bundle — the builder injects `window.__PILL__ = true`
//! before any app script runs, and `main.tsx` renders `ui/FocusPill.tsx` alone
//! on that flag — so the timer state itself never passes through here: the
//! pill and the main window share `localStorage` on the same origin.
//!
//! What Rust owns is the one fact the page cannot see and the window's frame:
//!
//! - the main window's foreground state (focus, visibility and minimize state, forwarded as
//!   `pill://main-focus`), which decides whether the pill may show (it
//!   appears by itself only while the planner is not in the foreground);
//! - the pill's position: the default is the top-right of the primary work
//!   area, a position the user dragged to is remembered in the app config dir
//!   (the window-state plugin deliberately does not track this window — its
//!   `visible` restore would re-show the pill on launch without a session —
//!   and every restore is clamped so the pill can never land off-screen).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PILL_LABEL: &str = "pill";
const MAIN_LABEL: &str = "main";
/// Rust → every window: whether `main` currently owns the foreground.
const MAIN_FOCUS_EVENT: &str = "pill://main-focus";
/// Logical size of the pill; the page paints exactly this surface.
const PILL_SIZE: (f64, f64) = (220.0, 44.0);
/// Gap from the work area's top-right corner for the default position.
const EDGE_MARGIN_LOGICAL: f64 = 12.0;
/// The pill's saved position, next to the window-state plugin's own file.
const STATE_FILE: &str = "pill-window.json";

/// What the pill needs to know about `main`: the three facts the page folds
/// into "is the planner in front" (`mainInForeground` in `focusPillState.ts`,
/// the one place the rule lives). Focus alone is not enough: hiding to the tray
/// or minimizing must show the pill even if the OS never reports a focus loss.
#[derive(Clone, Copy, Serialize)]
pub struct MainState {
    focused: bool,
    visible: bool,
    minimized: bool,
}

fn main_state<R: Runtime>(app: &AppHandle<R>) -> MainState {
    match app.get_webview_window(MAIN_LABEL) {
        Some(main) => MainState {
            focused: main.is_focused().unwrap_or(false),
            visible: main.is_visible().unwrap_or(false),
            minimized: main.is_minimized().unwrap_or(false),
        },
        None => MainState { focused: false, visible: false, minimized: false },
    }
}

/// Tells the pill page where `main` stands now. Called from the window's own
/// events and, explicitly, after every hide/show the app performs itself (the
/// close-to-tray hide, the tray toggle, `focus_main`), so the pill never depends
/// on the OS delivering a `Focused(false)` for a hidden window.
pub fn sync_main<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(MAIN_FOCUS_EVENT, main_state(app));
}

#[derive(Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(STATE_FILE))
}

/// Saves the pill's position. Called on every `Moved` event: the file is a few
/// dozen bytes and drags are rare, so the newest position is always on disk —
/// no debounce, no lost tail when the app exits right after a drag.
fn save_position<R: Runtime>(app: &AppHandle<R>, position: PhysicalPosition<i32>) {
    let Some(path) = state_path(app) else { return };
    let Ok(payload) = serde_json::to_vec(&SavedPosition { x: position.x, y: position.y }) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, payload);
}

fn load_position<R: Runtime>(app: &AppHandle<R>) -> Option<SavedPosition> {
    let raw = fs::read_to_string(state_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The pill's physical size on `monitor`'s scale factor.
fn physical_size(monitor: &Monitor) -> (i32, i32) {
    let scale = monitor.scale_factor();
    ((PILL_SIZE.0 * scale).round() as i32, (PILL_SIZE.1 * scale).round() as i32)
}

/// Clamps a top-left so the whole window stays inside the monitor's work area
/// (the taskbar never covers it, and it can never land off-screen).
fn clamp_to_work_area(monitor: &Monitor, x: i32, y: i32, width: i32, height: i32) -> (i32, i32) {
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x, area.position.y);
    let (aw, ah) = (area.size.width as i32, area.size.height as i32);
    let width = width.min(aw);
    let height = height.min(ah);
    // A work area smaller than the pill pins it to the area's corner instead
    // of letting `clamp` panic on an inverted range.
    (
        if aw <= width { ax } else { x.clamp(ax, ax + aw - width) },
        if ah <= height { ay } else { y.clamp(ay, ay + ah - height) },
    )
}

/// Applies the pill's starting position: the position the user dragged to,
/// clamped to the monitor that now holds it, or the primary work area's
/// top-right when nothing (or nothing reachable) is saved.
fn apply_position<R: Runtime>(app: &AppHandle<R>, pill: &tauri::WebviewWindow<R>) {
    let monitors = pill.available_monitors().unwrap_or_default();
    let restored = load_position(app).and_then(|saved| {
        monitors.iter().find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            saved.x >= origin.x
                && saved.y >= origin.y
                && saved.x < origin.x + size.width as i32
                && saved.y < origin.y + size.height as i32
        }).map(|monitor| {
            let (width, height) = physical_size(monitor);
            let (x, y) = clamp_to_work_area(monitor, saved.x, saved.y, width, height);
            PhysicalPosition::new(x, y)
        })
    });
    let target = restored.or_else(|| {
        let primary = pill.primary_monitor().ok().flatten()?;
        let (width, _height) = physical_size(&primary);
        let area = primary.work_area();
        let margin = (EDGE_MARGIN_LOGICAL * primary.scale_factor()).round() as i32;
        let x = area.position.x + area.size.width as i32 - width - margin;
        let y = area.position.y + margin;
        Some(PhysicalPosition::new(x, y.max(area.position.y)))
    });
    if let Some(position) = target {
        let _ = pill.set_position(position);
    }
}

/// Creates the hidden pill window and wires its two Rust-side facts.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let builder = WebviewWindowBuilder::new(app, PILL_LABEL, WebviewUrl::App("index.html".into()))
        .title("Focus timer")
        .inner_size(PILL_SIZE.0, PILL_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true);
    // GTK sizes a non-resizable window to its content's natural height (65 px
    // for this page on Hyprland), not to `inner_size`; equal min and max
    // sizes pin the pill to the chip instead.
    #[cfg(target_os = "linux")]
    let builder = builder
        .resizable(true)
        .min_inner_size(PILL_SIZE.0, PILL_SIZE.1)
        .max_inner_size(PILL_SIZE.0, PILL_SIZE.1);
    #[cfg(not(target_os = "linux"))]
    let builder = builder.resizable(false);
    let pill = builder
        .focused(false)
        .visible(false)
        // Must match the config windows or WebView2 refuses to create it.
        .additional_browser_args(planner_core::webview::BROWSER_ARGS)
        .initialization_script("window.__PILL__ = true;")
        .build()?;
    apply_position(app, &pill);
    // Created hidden: aim low until the first session shows it.
    crate::memory::sync_pill(&pill);

    let mover = app.clone();
    pill.on_window_event(move |event| {
        if let WindowEvent::Moved(position) = event {
            save_position(&mover, *position);
        }
    });

    // Focus flips, minimize/restore (a `Resized` on Windows) and visibility
    // changes made by the app itself (`sync_main` callers) all re-announce
    // `main`'s state.
    let tracker = app.clone();
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        main.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
                sync_main(&tracker);
            }
        });
    }

    Ok(())
}

/// Clicking the pill body (a click, not a drag) hands control back to the
/// main window: restored, shown and focused — the same path a deep link takes.
#[tauri::command]
pub fn pill_focus_main<R: Runtime>(app: AppHandle<R>) {
    crate::deeplink::focus_main(&app);
}

/// The state the pill page needs before the first event arrives.
#[tauri::command]
pub fn pill_main_focused<R: Runtime>(app: AppHandle<R>) -> MainState {
    main_state(&app)
}

/// The page calls this right after it shows or hides the pill window, so the
/// WebView2 memory target follows visibility (LOW hidden, NORMAL shown).
#[tauri::command]
pub fn pill_visibility_changed<R: Runtime>(app: AppHandle<R>) {
    if let Some(pill) = app.get_webview_window(PILL_LABEL) {
        crate::memory::sync_pill(&pill);
    }
}

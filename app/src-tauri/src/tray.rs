//! The tray icon and the window's close button (T6, spec S8.2, decision L13).
//!
//! Three behaviours live here, all driven by one payload the webview pushes
//! through `tray_sync`:
//!
//! - **Close hides (L13).** The main window's close button saves the window
//!   state, hides the window and leaves the app running for the hotkey, the
//!   timer and the tray; the tray menu's Quit is the real exit.
//! - **The tray.** Left click toggles the main window, the right-click menu
//!   carries the disabled Up next line, the focus line while a session runs,
//!   "Open Planner" and Quit, and the tooltip mirrors Up next.
//! - **The taskbar bar.** A focus session paints its elapsed fraction on the
//!   window's taskbar button (`Normal` while running, `Paused` on pause, `None`
//!   when there is no session). The webview rate-limits pushes to one per 10 s
//!   (`trayPushDecision` in `src/desktop-tray.ts`, unit-tested), so this side
//!   simply applies what it receives.
//!
//! Every string drawn here and in `notify.rs` arrives translated in the
//! payload's `labels` (T10b): Rust keeps no translation table. Until the first
//! push the English defaults of `TrayLabels` stand in.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::deeplink::focus_main;

/// The tray icon's id: `tray_sync` and the builder agree on it.
const TRAY_ID: &str = "planner-tray";

const ITEM_UP_NEXT: &str = "tray-up-next";
const ITEM_FOCUS: &str = "tray-focus";
const MENU_OPEN: &str = "tray-open";
const MENU_QUIT: &str = "tray-quit";

/// The tray's line until the webview signs in and pushes the real one.
const SIGNED_OUT_UP_NEXT: &str = "Sign in to see Up next";

/// Where the one-time "still running in the tray" notice is remembered: the app
/// config dir, so it is once per install (and per user), not once per launch.
const NOTICE_FLAG: &str = "tray-notice.shown";

/// Windows tooltips are `szTip[128]`: 127 characters plus the terminator.
const TOOLTIP_MAX_CHARS: usize = 127;

/// A double click means "open". Its trailing click is ignored for this long,
/// so a double click does not toggle the window straight back to hidden.
const DOUBLE_CLICK_WINDOW: Duration = Duration::from_millis(500);

/// The static strings Rust draws, in the app's language (`TrayLabels` in
/// `src/desktop-tray.ts` has exactly these fields). `Default` is the English
/// copy shown before the webview's first push. The toast fields are read only
/// by the Windows notifier (`notify.rs`).
#[derive(Debug, Clone, serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    pub notice_title: String,
    pub notice_body: String,
    pub block_lead: String,
    pub block_snoozed_lead: String,
    pub block_start_focus: String,
    pub block_snooze: String,
    pub work_block: String,
    pub shutdown_title: String,
    pub shutdown_body: String,
    pub shutdown_action: String,
    pub weekly_title: String,
    pub weekly_body: String,
    pub weekly_start: String,
    pub weekly_later: String,
    pub weekly_skip: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open Planner".into(),
            quit: "Quit".into(),
            notice_title: "Planner is still running in the tray".into(),
            notice_body: "Closing hides the window: reopen it or quit from the tray icon.".into(),
            block_lead: "Deep work starts in 2 min".into(),
            block_snoozed_lead: "Starting now".into(),
            block_start_focus: "Start focus".into(),
            block_snooze: "+5 min".into(),
            work_block: "Work block".into(),
            shutdown_title: "Time to close the day.".into(),
            shutdown_body: "The shutdown ritual is ready.".into(),
            shutdown_action: "Close the day".into(),
            weekly_title: "Time to close the week.".into(),
            weekly_body: "The weekly review is ready.".into(),
            weekly_start: "Start review".into(),
            weekly_later: "Later".into(),
            weekly_skip: "Skip this week".into(),
        }
    }
}

/// The last labels the webview pushed, read by the close-to-tray notice and
/// by `notify.rs`. Managed by `setup`; a reader that finds it missing uses
/// the defaults.
#[derive(Default)]
pub struct Labels(Mutex<TrayLabels>);

/// The current labels (the English defaults when none were pushed yet).
pub fn labels<R: Runtime>(app: &AppHandle<R>) -> TrayLabels {
    app.try_state::<Labels>()
        .map(|state| state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone())
        .unwrap_or_default()
}

/// What the webview pushes (`src/desktop-tray.ts` sends exactly this shape).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPayload {
    /// The whole disabled Up next menu line, already worded.
    pub up_next: String,
    /// The focus line while a session runs; absent drops the row from the menu.
    #[serde(default)]
    pub focus: Option<String>,
    /// The taskbar bar; absent clears it.
    #[serde(default)]
    pub progress: Option<TrayProgress>,
    /// The translated static strings; absent keeps the last ones.
    #[serde(default)]
    pub labels: Option<TrayLabels>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProgress {
    /// Elapsed fraction of the session, 0.0..=1.0.
    pub fraction: f64,
    pub status: TrayProgressStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayProgressStatus {
    Normal,
    Paused,
}

/// The live pieces of the tray, kept so `tray_sync` re-words the menu instead
/// of rebuilding it on every push.
pub struct Tray<R: Runtime> {
    icon: TrayIcon<R>,
    menu: Menu<R>,
    up_next: MenuItem<R>,
    focus: MenuItem<R>,
    open: MenuItem<R>,
    quit: MenuItem<R>,
    /// Whether the focus row is currently in the menu.
    focus_row: Mutex<bool>,
    /// Set by a double click; its trailing click sees it and steps aside.
    last_double: Mutex<Option<Instant>>,
}

/// One tray menu: the Up next line, the focus row once a session runs, then the
/// actions. The focus row is inserted and removed in place (`tray_sync`), so
/// the separator only ever sits between the info lines and the actions.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let up_next = MenuItem::with_id(app, ITEM_UP_NEXT, SIGNED_OUT_UP_NEXT, false, None::<&str>)?;
    let focus = MenuItem::with_id(app, ITEM_FOCUS, "", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let defaults = TrayLabels::default();
    let open = MenuItem::with_id(app, MENU_OPEN, &defaults.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, &defaults.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&up_next, &separator, &open, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("the bundled app icon is missing")?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(SIGNED_OUT_UP_NEXT)
        // Left click belongs to the window toggle; the menu opens on right click.
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => focus_main(app),
            MENU_QUIT => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?;

    app.manage(Tray {
        icon: tray,
        menu,
        up_next,
        focus,
        open,
        quit,
        focus_row: Mutex::new(false),
        last_double: Mutex::new(None),
    });
    app.manage(Labels::default());
    attach_close_to_tray(app);
    Ok(())
}

/// Applies one webview payload: the two menu lines, the action rows' labels,
/// the tooltip and the taskbar bar. The focus row is only inserted or removed when the session
/// starts or ends; between those moments only its text changes.
#[tauri::command]
pub fn tray_sync<R: Runtime>(app: AppHandle<R>, payload: TrayPayload) -> Result<(), String> {
    let tray = app.state::<Tray<R>>();
    tray.up_next
        .set_text(payload.up_next.trim())
        .map_err(|error| error.to_string())?;

    let mut focus_row = tray.focus_row.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let want_row = payload.focus.is_some();
    if want_row != *focus_row {
        if want_row {
            tray.menu
                .insert(&tray.focus, 1)
                .map_err(|error| error.to_string())?;
        } else {
            tray.menu
                .remove(&tray.focus)
                .map_err(|error| error.to_string())?;
        }
        *focus_row = want_row;
    }
    drop(focus_row);

    if let Some(line) = &payload.focus {
        tray.focus.set_text(line).map_err(|error| error.to_string())?;
    }

    let tooltip: String = payload.up_next.chars().take(TOOLTIP_MAX_CHARS).collect();
    tray.icon
        .set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())?;

    if let Some(labels) = payload.labels {
        tray.open.set_text(&labels.open).map_err(|error| error.to_string())?;
        tray.quit.set_text(&labels.quit).map_err(|error| error.to_string())?;
        if let Some(state) = app.try_state::<Labels>() {
            *state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = labels;
        }
    }

    set_progress(&app, payload.progress);
    Ok(())
}

/// The taskbar button of the main window: `Normal` with the elapsed fraction
/// while the session runs, `Paused` while it is held, `None` without a session
/// (finished or stopped).
fn set_progress<R: Runtime>(app: &AppHandle<R>, progress: Option<TrayProgress>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = match progress {
        None => ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        },
        Some(value) => ProgressBarState {
            status: Some(match value.status {
                TrayProgressStatus::Normal => ProgressBarStatus::Normal,
                TrayProgressStatus::Paused => ProgressBarStatus::Paused,
            }),
            progress: Some((value.fraction.clamp(0.0, 1.0) * 100.0).round() as u64),
        },
    };
    let _ = window.set_progress_bar(state);
}

/// Left click: hide the window that is already in front, otherwise bring the
/// main window back (unminimized, shown and focused).
fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let in_front = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if in_front {
        let _ = window.hide();
        crate::pill::sync_main(app);
        crate::memory::sync_main(&window);
    } else {
        focus_main(app);
    }
}

fn on_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    let app = tray.app_handle();
    match event {
        TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
            if let Ok(mut slot) = app.state::<Tray<R>>().last_double.lock() {
                *slot = Some(Instant::now());
            }
            focus_main(app);
        }
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            let steps_aside = match app.state::<Tray<R>>().last_double.lock() {
                Ok(mut slot) => matches!(slot.take(), Some(at) if at.elapsed() < DOUBLE_CLICK_WINDOW),
                Err(_) => false,
            };
            if !steps_aside {
                toggle_main(app);
            }
        }
        _ => {}
    }
}

/// Quit is the real exit (L13): the geometry goes to disk first so a window
/// that was hidden to the tray cannot lose its state, then the app exits and
/// the window-state plugin saves once more on `RunEvent::Exit`.
fn quit_app<R: Runtime>(app: &AppHandle<R>) {
    // VISIBLE stays out of it on purpose: the window may be hidden right now,
    // and a state saved as invisible is one the next launch would not show.
    let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    app.exit(0);
}

/// L13, close-to-tray: the close button hides instead of quitting. The window
/// state is saved *before* the hide, while the window is still visible, and the
/// one-time notice fires on this path only (the tray's own toggle is a deliberate
/// action that needs no explanation).
fn attach_close_to_tray<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("tray: main window not found; close will not hide to the tray");
        return;
    };
    let handle = app.clone();
    let closing = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = handle.save_window_state(StateFlags::all());
                let _ = closing.hide();
                // T12: hidden to the tray — WebView2 aims low until it returns.
                crate::memory::sync_main(&closing);
                crate::pill::sync_main(&handle);
                show_tray_notice_once(&handle);
            }
            // A minimize and its restore arrive here as resizes; the sync reads
            // `is_minimized` and moves the memory target both ways.
            tauri::WindowEvent::Resized(_) => crate::memory::sync_main(&closing),
            _ => {}
        }
    });
}

/// The first close of an install says where the window went. The flag is
/// written only after the toast was accepted, so a build where the toast
/// cannot be shown keeps trying instead of silently swallowing the notice.
fn show_tray_notice_once<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let flag = dir.join(NOTICE_FLAG);
    if flag.exists() {
        return;
    }
    let labels = labels(app);
    let shown = app
        .notification()
        .builder()
        .title(labels.notice_title)
        .body(labels.notice_body)
        .show();
    if shown.is_ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&flag, b"shown");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `trayLabels()` in `src/desktop-tray.ts` sends: a field renamed
    /// on one side only fails here instead of silently keeping English.
    #[test]
    fn payload_with_labels_deserializes() {
        let json = r#"{
            "upNext": "A continuación: nada más por hoy", "focus": null, "progress": null,
            "labels": {
                "open": "Abrir Planner", "quit": "Salir",
                "noticeTitle": "t", "noticeBody": "b",
                "blockLead": "l", "blockSnoozedLead": "s", "blockStartFocus": "f", "blockSnooze": "+5 min",
                "workBlock": "Bloque de trabajo",
                "shutdownTitle": "t", "shutdownBody": "b", "shutdownAction": "Cerrar el día",
                "weeklyTitle": "t", "weeklyBody": "b", "weeklyStart": "s", "weeklyLater": "l", "weeklySkip": "k"
            }
        }"#;
        let payload: TrayPayload = serde_json::from_str(json).expect("payload");
        let labels = payload.labels.expect("labels");
        assert_eq!(labels.quit, "Salir");
        assert_eq!(labels.shutdown_action, "Cerrar el día");
    }

    #[test]
    fn payload_without_labels_keeps_the_last_ones() {
        let payload: TrayPayload = serde_json::from_str(r#"{ "upNext": "Up next: Nothing else today" }"#).expect("payload");
        assert!(payload.labels.is_none());
        assert_eq!(TrayLabels::default().open, "Open Planner");
    }
}

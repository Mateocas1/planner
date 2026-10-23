//! Actionable native toasts (task T7, spec S8.3).
//!
//! `tauri-plugin-notification` cannot add action buttons on desktop, so the
//! toasts go through `tauri-winrt-notification` (the Tauri-org fork of
//! `winrt-notification` that adds buttons and an in-process `Activated`
//! handler): each toast carries its actions, and the pressed action is
//! reported back to the webview as a `notify-action` event. The *scheduling*
//! decisions — what to notify when, dedupe, snooze — live in the frontend's
//! pure half (`src/desktop-notify.ts`); this module only draws a toast and
//! relays the answer, so no decision exists twice.
//!
//! ## AppUserModelID (why toasts would otherwise not show)
//!
//! A desktop toast notifier only shows toasts for an AUMID the system knows.
//! Tauri's NSIS installer stamps every shortcut (Start Menu, Desktop) with the
//! bundle identifier as the shortcut's `System.AppUserModel.ID`, so the
//! installed app's AUMID is `com.picala.planner` (here read from the app
//! config, so a bundle-id change cannot desync it). An exe run straight from
//! `target/debug` or `target/release` is not registered, so those toasts would
//! be invisible; like `tauri-plugin-notification` does, dev builds fall back to
//! the well-known PowerShell AUMID — the toast shows (with PowerShell's
//! identity), and the in-process `Activated` callback still works, because
//! activation never leaves this process.
//!
//! Respect for Focus Assist / Do Not Disturb is the OS's own behaviour for
//! toast notifications; this module does nothing about it on purpose (S10).

use serde::{Deserialize, Serialize};

/// What the frontend asks to draw. Only these shapes are ever acted on.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotifyRequest {
    /// The block-start toast: [Start focus] and [+5 min], body click opens.
    Block {
        /// The dedupe key (`blockId@start`), echoed back on every action.
        key: String,
        block_id: String,
        /// The block start's profile-zone day key, when the frontend knows it.
        date: Option<String>,
        /// The block's title as the sidebar would show it.
        title: Option<String>,
        /// True when this toast is a [+5 min] re-reminder.
        snoozed: Option<bool>,
    },
    /// The shutdown nudge: [Close the day].
    Shutdown,
    /// The weekly review nudge (S3): [Start review] / [Later] / [Skip this
    /// week]. The dedupe key is echoed back on every action.
    WeeklyReview { key: String },
}

/// What a pressed action means, as the `notify-action` event payload.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotifyAction {
    /// [Start focus] (or [Start focus] pressed on a re-reminder).
    BlockFocus { key: String, block_id: String },
    /// The toast body: open the main window on the block's day.
    BlockOpen { key: String, block_id: String, date: Option<String> },
    /// [+5 min]: only the reminder moves.
    BlockSnooze { key: String },
    /// [Close the day] (or the nudge's body): open the shutdown ritual.
    ShutdownOpen,
    /// The weekly review nudge: `action` is "start", "later" or "skip" — the
    /// writes behind each belong to the frontend, exactly as T7 arranged.
    WeeklyReview { key: String, action: String },
}

/// Shows the requested toast and wires its activation callbacks. The action
/// itself belongs to the frontend: Rust only reports what was pressed.
#[tauri::command]
pub fn notify_show(request: NotifyRequest, app: tauri::AppHandle) -> Result<(), String> {
    show(request, app)
}

/// Brings the main window back, for actions that mean "look at the app".
/// Safe from any thread: `show`/`set_focus` are proxied to the main thread.
#[cfg(windows)]
fn focus_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Emits the action event; a webview that is momentarily gone just misses it.
#[cfg(windows)]
fn report(app: &tauri::AppHandle, action: NotifyAction) {
    use tauri::Emitter;
    if let Err(error) = app.emit("notify-action", action) {
        eprintln!("could not report notification action: {error}");
    }
}

#[cfg(windows)]
fn show(request: NotifyRequest, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_winrt_notification::{Scenario, Toast};

    // Dev exes are not registered under the bundle id; installed ones are
    // (the NSIS shortcuts carry it). See the module docs.
    let app_id = dev_exe()
        .map(|_| tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string())
        .unwrap_or_else(|| app.config().identifier.clone());

    // WinRT activation is delivered to this process while it lives; the toast
    // is shown on its own thread so a slow call never blocks the IPC command.
    std::thread::Builder::new()
        .name("planner-notify".into())
        .spawn(move || {
            let result = match request {
                NotifyRequest::Block { key, block_id, date, title, snoozed } => {
                    let lead = if snoozed == Some(true) { "Starting now" } else { "Deep work starts in 2 min" };
                    let toast = Toast::new(&app_id)
                        .title(lead)
                        .text1(title.as_deref().unwrap_or("Work block"))
                        .scenario(Scenario::Reminder)
                        .add_button("Start focus", "start-focus")
                        .add_button("+5 min", "snooze-5")
                        .on_activated({
                            let app = app.clone();
                            let key = key.clone();
                            let block_id = block_id.clone();
                            let date = date.clone();
                            move |action| {
                                match action.as_deref() {
                                    Some("start-focus") => {
                                        focus_main(&app);
                                        report(&app, NotifyAction::BlockFocus { key: key.clone(), block_id: block_id.clone() });
                                    }
                                    Some("snooze-5") => {
                                        report(&app, NotifyAction::BlockSnooze { key: key.clone() });
                                    }
                                    // The toast body: open the window on the block's day.
                                    _ => {
                                        focus_main(&app);
                                        report(&app, NotifyAction::BlockOpen { key: key.clone(), block_id: block_id.clone(), date: date.clone() });
                                    }
                                }
                                Ok(())
                            }
                        });
                    toast.show().map_err(|error| error.to_string())
                }
                NotifyRequest::Shutdown => {
                    let toast = Toast::new(&app_id)
                        .title("Time to close the day.")
                        .text1("The shutdown ritual is ready.")
                        .scenario(Scenario::Reminder)
                        .add_button("Close the day", "close-day")
                        .on_activated({
                            let app = app.clone();
                            move |_action| {
                                focus_main(&app);
                                report(&app, NotifyAction::ShutdownOpen);
                                Ok(())
                            }
                        });
                    toast.show().map_err(|error| error.to_string())
                }
                NotifyRequest::WeeklyReview { key } => {
                    let toast = Toast::new(&app_id)
                        .title("Time to close the week.")
                        .text1("The weekly review is ready.")
                        .scenario(Scenario::Reminder)
                        .add_button("Start review", "start")
                        .add_button("Later", "later")
                        .add_button("Skip this week", "skip")
                        .on_activated({
                            let app = app.clone();
                            let key = key.clone();
                            move |action| {
                                // The toast body counts as Start: it means "open
                                // the review", the same sentence either way.
                                // Skip only silences the week; the window does
                                // not need to come forward for a "no".
                                let action = match action.as_deref() {
                                    Some("later") => "later",
                                    Some("skip") => "skip",
                                    _ => "start",
                                };
                                if action != "skip" {
                                    focus_main(&app);
                                }
                                report(&app, NotifyAction::WeeklyReview { key: key.clone(), action: action.to_string() });
                                Ok(())
                            }
                        });
                    toast.show().map_err(|error| error.to_string())
                }
            };
            if let Err(error) = result {
                eprintln!("could not show notification: {error}");
            }
        })
        .map_err(|error| format!("could not spawn notification thread: {error}"))?;
    Ok(())
}

/// True when this exe was run from a build directory (never the installed
/// app; the cross target dir `target/x86_64-pc-windows-msvc/release` counts).
#[cfg(windows)]
fn dev_exe() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_string_lossy().to_lowercase();
    let dev = format!("{}target{}debug", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
    let release = format!("{}target{}release", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
    (dir.contains(&dev) || dir.contains(&release)).then_some(exe)
}

/// Non-Windows builds (e.g. a Linux `cargo check`) never run the shell; the
/// request is dropped and the frontend's tick moves on.
#[cfg(not(windows))]
fn show(_request: NotifyRequest, _app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

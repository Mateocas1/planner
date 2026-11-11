//! Actionable native toasts.
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
//! toast notifications; this module does nothing about it on purpose.
//!
//! ## Linux
//!
//! On Linux the same requests become XDG desktop notifications through
//! `notify-rust` (already in the tree through `tauri-plugin-notification`).
//! Each one carries the same buttons plus the XDG `default` action, which
//! servers such as mako invoke on a body click. A worker thread waits for the
//! answer and maps it to the same `NotifyAction` the Windows toast reports;
//! closing or expiring the notification reports nothing. Do Not Disturb is the
//! notification server's business, as on Windows.
//!
//! A failed `show` (no notification server, a broken bus) is logged and
//! returned as `notify_show`'s error. Waiting threads are bounded: a new
//! notification for a live slot (the same block, the shutdown or the weekly
//! nudge) replaces it in place and inherits its thread, and past
//! `MAX_WAITERS` open notifications the oldest is replaced instead.

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
    /// The weekly review nudge: [Start review] / [Later] / [Skip this
    /// week]. The dedupe key is echoed back on every action.
    WeeklyReview { key: String },
}

/// What a pressed action means, as the `notify-action` event payload.
#[derive(Serialize, Clone, Debug, PartialEq)]
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
/// `show` may block on D-Bus (Linux), so it runs on the blocking pool and its
/// failure comes back to the caller as the command's error.
#[tauri::command]
pub async fn notify_show(request: NotifyRequest, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show(request, app))
        .await
        .map_err(|error| format!("notification task failed: {error}"))?
}

/// Brings the main window back, for actions that mean "look at the app".
/// Safe from any thread: `show`/`set_focus` are proxied to the main thread.
#[cfg(any(windows, target_os = "linux"))]
fn focus_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Emits the action event; a webview that is momentarily gone just misses it.
#[cfg(any(windows, target_os = "linux"))]
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
    // The toast's words, already in the app's language (pushed with `tray_sync`).
    let labels = crate::tray::labels(&app);

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
                    let lead = if snoozed == Some(true) { &labels.block_snoozed_lead } else { &labels.block_lead };
                    let toast = Toast::new(&app_id)
                        .title(lead)
                        .text1(title.as_deref().unwrap_or(labels.work_block.as_str()))
                        .scenario(Scenario::Reminder)
                        .add_button(&labels.block_start_focus, "start-focus")
                        .add_button(&labels.block_snooze, "snooze-5")
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
                        .title(&labels.shutdown_title)
                        .text1(&labels.shutdown_body)
                        .scenario(Scenario::Reminder)
                        .add_button(&labels.shutdown_action, "close-day")
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
                        .title(&labels.weekly_title)
                        .text1(&labels.weekly_body)
                        .scenario(Scenario::Reminder)
                        .add_button(&labels.weekly_start, "start")
                        .add_button(&labels.weekly_later, "later")
                        .add_button(&labels.weekly_skip, "skip")
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

#[cfg(target_os = "linux")]
use crate::tray::TrayLabels;

/// A Linux notification's words and actions, `(id, label)` in button order.
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct Content {
    summary: String,
    body: String,
    actions: Vec<(&'static str, String)>,
}

/// Draws a request with the pushed labels: the same title, text and buttons
/// as the Windows toast. `default` is the body click (its label is not shown
/// by servers that support it).
#[cfg(target_os = "linux")]
fn content(request: &NotifyRequest, labels: &TrayLabels) -> Content {
    let (summary, body, buttons) = match request {
        NotifyRequest::Block { title, snoozed, .. } => (
            if *snoozed == Some(true) { &labels.block_snoozed_lead } else { &labels.block_lead },
            title.as_ref().unwrap_or(&labels.work_block),
            vec![("start-focus", &labels.block_start_focus), ("snooze-5", &labels.block_snooze)],
        ),
        NotifyRequest::Shutdown => (&labels.shutdown_title, &labels.shutdown_body, vec![("close-day", &labels.shutdown_action)]),
        NotifyRequest::WeeklyReview { .. } => (
            &labels.weekly_title,
            &labels.weekly_body,
            vec![("start", &labels.weekly_start), ("later", &labels.weekly_later), ("skip", &labels.weekly_skip)],
        ),
    };
    let mut actions = vec![("default", summary.clone())];
    actions.extend(buttons.into_iter().map(|(id, label)| (id, label.clone())));
    Content { summary: summary.clone(), body: body.clone(), actions }
}

/// Maps the invoked action id to what the Windows `on_activated` handlers
/// report, plus whether the main window comes forward. `None` for a close
/// (`__closed`, notify-rust's dismissal or expiry): that is not an answer.
#[cfg(target_os = "linux")]
fn resolve(request: &NotifyRequest, action: &str) -> Option<(NotifyAction, bool)> {
    if action == "__closed" {
        return None;
    }
    Some(match request {
        NotifyRequest::Block { key, block_id, date, .. } => match action {
            "start-focus" => (NotifyAction::BlockFocus { key: key.clone(), block_id: block_id.clone() }, true),
            "snooze-5" => (NotifyAction::BlockSnooze { key: key.clone() }, false),
            _ => (NotifyAction::BlockOpen { key: key.clone(), block_id: block_id.clone(), date: date.clone() }, true),
        },
        NotifyRequest::Shutdown => (NotifyAction::ShutdownOpen, true),
        NotifyRequest::WeeklyReview { key } => {
            let action = match action {
                "later" => "later",
                "skip" => "skip",
                _ => "start",
            };
            (NotifyAction::WeeklyReview { key: key.clone(), action: action.to_string() }, action != "skip")
        }
    })
}

/// The most notifications (and so waiting threads) the app keeps open at once.
#[cfg(target_os = "linux")]
const MAX_WAITERS: usize = 4;

/// A shown notification whose thread waits for an answer. `request` is what
/// the answer means: a replacement swaps it in place.
#[cfg(target_os = "linux")]
struct Waiter {
    id: u32,
    slot: String,
    request: NotifyRequest,
}

/// The live notifications, oldest first.
#[cfg(target_os = "linux")]
static WAITERS: std::sync::Mutex<Vec<Waiter>> = std::sync::Mutex::new(Vec::new());

/// Requests in the same slot supersede each other: a block's re-reminder
/// replaces its first reminder, a new nudge replaces the last one.
#[cfg(target_os = "linux")]
fn slot(request: &NotifyRequest) -> String {
    match request {
        NotifyRequest::Block { block_id, .. } => format!("block:{block_id}"),
        NotifyRequest::Shutdown => "shutdown".into(),
        NotifyRequest::WeeklyReview { .. } => "weekly".into(),
    }
}

/// Which live notification a new one replaces: the one in its slot, else the
/// oldest once `cap` are open, else none (it gets its own waiting thread).
#[cfg(target_os = "linux")]
fn reuse(waiters: &[Waiter], slot: &str, cap: usize) -> Option<u32> {
    waiters
        .iter()
        .find(|waiter| waiter.slot == slot)
        .or_else(|| waiters.first().filter(|_| waiters.len() >= cap))
        .map(|waiter| waiter.id)
}

/// Records a shown notification and says whether it needs its own waiting
/// thread. A live waiter with the same id (an in-place replacement) keeps its
/// thread, which now answers for this request; it moves last, as the newest.
/// Any other waiter is left alone: if the server gave a new id, the old
/// notification may still be up and its thread still answers it.
#[cfg(target_os = "linux")]
fn record(waiters: &mut Vec<Waiter>, id: u32, slot: String, request: NotifyRequest) -> bool {
    let waiting = remove(waiters, id).is_some();
    waiters.push(Waiter { id, slot, request });
    !waiting
}

/// Takes a notification's waiter out of the registry, if it is still there.
#[cfg(target_os = "linux")]
fn remove(waiters: &mut Vec<Waiter>, id: u32) -> Option<Waiter> {
    let index = waiters.iter().position(|w| w.id == id)?;
    Some(waiters.remove(index))
}

/// Serializes `show` so two requests never pick the same notification to
/// replace. Only `show` takes it; waiting threads never block on D-Bus.
#[cfg(target_os = "linux")]
static SHOWING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "linux")]
fn waiters() -> std::sync::MutexGuard<'static, Vec<Waiter>> {
    WAITERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Linux: shows the notification synchronously, so a D-Bus failure is logged
/// and returned. A replacement (same XDG id, `replaces_id`) keeps the old
/// notification's waiting thread, which then answers for the new request; so
/// at most `MAX_WAITERS` threads wait, unless a server ignores `replaces_id`
/// (then each extra notification is still on screen and still answered).
/// `WAITERS` is never held across the D-Bus call, so an answer arriving
/// meanwhile is handled at once; `record` copes with the waiter it was going
/// to replace being gone by then.
#[cfg(target_os = "linux")]
fn show(request: NotifyRequest, app: tauri::AppHandle) -> Result<(), String> {
    use notify_rust::{Notification, Timeout};

    let content = content(&request, &crate::tray::labels(&app));
    let slot = slot(&request);
    let mut notification = Notification::new();
    notification
        .appname(&app.config().product_name.clone().unwrap_or_else(|| "Planner".into()))
        .summary(&content.summary)
        .body(&content.body)
        // Stays until answered, like the Windows Reminder scenario.
        .timeout(Timeout::Never);
    for (id, label) in &content.actions {
        notification.action(id, label);
    }

    let _showing = SHOWING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(id) = reuse(&waiters(), &slot, MAX_WAITERS) {
        notification.id(id);
    }
    let handle = notification.show().map_err(|error| {
        let error = format!("could not show notification: {error}");
        eprintln!("{error}");
        error
    })?;
    let id = handle.id();
    if !record(&mut waiters(), id, slot, request) {
        return Ok(());
    }

    // The wait for an answer blocks, so it runs on its own thread.
    std::thread::Builder::new()
        .name("planner-notify".into())
        .spawn(move || {
            let take = || remove(&mut waiters(), id);
            handle.wait_for_action(|action| {
                let Some(waiter) = take() else { return };
                if let Some((action, focus)) = resolve(&waiter.request, action) {
                    if focus {
                        focus_main(&app);
                    }
                    report(&app, action);
                }
            });
            // A lost bus ends the wait without an answer; free the slot anyway.
            take();
        })
        .map_err(|error| {
            remove(&mut waiters(), id);
            format!("could not spawn notification thread: {error}")
        })?;
    Ok(())
}

/// Other platforms (e.g. a macOS `cargo check`) never run the shell; the
/// request is dropped and the frontend's tick moves on.
#[cfg(not(any(windows, target_os = "linux")))]
fn show(_request: NotifyRequest, _app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn block(snoozed: Option<bool>, title: Option<&str>) -> NotifyRequest {
        NotifyRequest::Block {
            key: "b1@0900".into(),
            block_id: "b1".into(),
            date: Some("2026-11-06".into()),
            title: title.map(Into::into),
            snoozed,
        }
    }

    fn labels() -> TrayLabels {
        TrayLabels { block_lead: "Empieza en 2 min".into(), work_block: "Bloque de trabajo".into(), ..TrayLabels::default() }
    }

    #[test]
    fn block_content_uses_pushed_labels_and_both_buttons() {
        let labels = labels();
        let c = content(&block(None, None), &labels);
        assert_eq!(c.summary, "Empieza en 2 min");
        assert_eq!(c.body, "Bloque de trabajo");
        assert_eq!(c.actions, vec![("default", "Empieza en 2 min".to_string()), ("start-focus", labels.block_start_focus.clone()), ("snooze-5", labels.block_snooze.clone())]);
        let snoozed = content(&block(Some(true), Some("Write")), &labels);
        assert_eq!(snoozed.summary, labels.block_snoozed_lead);
        assert_eq!(snoozed.body, "Write");
    }

    #[test]
    fn shutdown_and_weekly_content() {
        let labels = TrayLabels::default();
        let c = content(&NotifyRequest::Shutdown, &labels);
        assert_eq!((c.summary.as_str(), c.body.as_str()), (labels.shutdown_title.as_str(), labels.shutdown_body.as_str()));
        assert_eq!(c.actions[1..], [("close-day", labels.shutdown_action.clone())]);
        let c = content(&NotifyRequest::WeeklyReview { key: "w".into() }, &labels);
        let ids: Vec<_> = c.actions.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, ["default", "start", "later", "skip"]);
        assert_eq!(c.actions[3].1, labels.weekly_skip);
    }

    #[test]
    fn block_actions_map_like_windows() {
        let request = block(None, None);
        assert_eq!(
            resolve(&request, "start-focus"),
            Some((NotifyAction::BlockFocus { key: "b1@0900".into(), block_id: "b1".into() }, true))
        );
        assert_eq!(resolve(&request, "snooze-5"), Some((NotifyAction::BlockSnooze { key: "b1@0900".into() }, false)));
        assert_eq!(
            resolve(&request, "default"),
            Some((NotifyAction::BlockOpen { key: "b1@0900".into(), block_id: "b1".into(), date: Some("2026-11-06".into()) }, true))
        );
    }

    #[test]
    fn shutdown_and_weekly_actions_map_like_windows() {
        assert_eq!(resolve(&NotifyRequest::Shutdown, "close-day"), Some((NotifyAction::ShutdownOpen, true)));
        assert_eq!(resolve(&NotifyRequest::Shutdown, "default"), Some((NotifyAction::ShutdownOpen, true)));
        let weekly = NotifyRequest::WeeklyReview { key: "w".into() };
        let review = |action: &str| NotifyAction::WeeklyReview { key: "w".into(), action: action.into() };
        assert_eq!(resolve(&weekly, "default"), Some((review("start"), true)));
        assert_eq!(resolve(&weekly, "start"), Some((review("start"), true)));
        assert_eq!(resolve(&weekly, "later"), Some((review("later"), true)));
        assert_eq!(resolve(&weekly, "skip"), Some((review("skip"), false)));
    }

    /// Dismissing or expiring a notification is not an answer: nothing is reported.
    #[test]
    fn closing_reports_nothing() {
        assert_eq!(resolve(&block(None, None), "__closed"), None);
        assert_eq!(resolve(&NotifyRequest::Shutdown, "__closed"), None);
        assert_eq!(resolve(&NotifyRequest::WeeklyReview { key: "w".into() }, "__closed"), None);
    }

    #[test]
    fn slots_group_requests_that_supersede_each_other() {
        assert_eq!(slot(&block(None, None)), "block:b1");
        assert_eq!(slot(&block(Some(true), Some("Write"))), "block:b1");
        assert_eq!(slot(&NotifyRequest::Shutdown), "shutdown");
        assert_eq!(slot(&NotifyRequest::WeeklyReview { key: "w".into() }), "weekly");
    }

    fn waiter(id: u32, slot: &str) -> Waiter {
        Waiter { id, slot: slot.into(), request: NotifyRequest::Shutdown }
    }

    /// A new notification for a live slot replaces that one; past the cap the
    /// oldest is replaced; otherwise it gets its own waiting thread.
    #[test]
    fn reuse_bounds_waiting_threads() {
        let live = [waiter(7, "block:b1"), waiter(9, "shutdown")];
        assert_eq!(reuse(&live, "shutdown", 4), Some(9));
        assert_eq!(reuse(&live, "block:b1", 4), Some(7));
        assert_eq!(reuse(&live, "weekly", 4), None);
        assert_eq!(reuse(&live, "weekly", 2), Some(7));
        assert_eq!(reuse(&[], "weekly", 4), None);
    }

    fn ids(waiters: &[Waiter]) -> Vec<(u32, &str)> {
        waiters.iter().map(|w| (w.id, w.slot.as_str())).collect()
    }

    /// A new id gets its own waiting thread and goes last (newest).
    #[test]
    fn record_new_id_needs_a_thread() {
        let mut live = vec![waiter(7, "block:b1")];
        assert!(record(&mut live, 9, "shutdown".into(), NotifyRequest::Shutdown));
        assert_eq!(ids(&live), [(7, "block:b1"), (9, "shutdown")]);
    }

    /// A replacement that kept its id is answered by the live thread, which now
    /// answers for the new request; it becomes the newest.
    #[test]
    fn record_same_id_swaps_the_request_in_place() {
        let mut live = vec![waiter(7, "block:b1"), waiter(9, "shutdown")];
        assert!(!record(&mut live, 7, "weekly".into(), NotifyRequest::WeeklyReview { key: "w".into() }));
        assert_eq!(ids(&live), [(9, "shutdown"), (7, "weekly")]);
        assert!(matches!(live[1].request, NotifyRequest::WeeklyReview { .. }));
    }

    /// The server ignored `replaces_id` (or the old one closed meanwhile): the
    /// old waiter stays, so its thread still answers its notification, and the
    /// new id gets its own thread.
    #[test]
    fn record_id_mismatch_keeps_the_old_waiter() {
        let mut live = vec![waiter(7, "block:b1")];
        assert!(record(&mut live, 8, "block:b1".into(), block(Some(true), None)));
        assert_eq!(ids(&live), [(7, "block:b1"), (8, "block:b1")]);
    }

    /// The replaced waiter was answered while `show` ran (its thread took it):
    /// even with the same id back, nothing waits, so a new thread is needed.
    #[test]
    fn record_after_the_old_thread_took_its_waiter_needs_a_thread() {
        let mut live = vec![waiter(7, "block:b1")];
        assert!(remove(&mut live, 7).is_some());
        assert!(record(&mut live, 7, "block:b1".into(), block(None, None)));
        assert_eq!(ids(&live), [(7, "block:b1")]);
    }

    #[test]
    fn remove_takes_only_the_given_id_once() {
        let mut live = vec![waiter(7, "block:b1"), waiter(9, "shutdown")];
        assert_eq!(remove(&mut live, 9).map(|w| w.id), Some(9));
        assert!(remove(&mut live, 9).is_none());
        assert!(remove(&mut live, 3).is_none());
        assert_eq!(ids(&live), [(7, "block:b1")]);
    }
}

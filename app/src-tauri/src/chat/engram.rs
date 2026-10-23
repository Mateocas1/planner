//! Tauri glue for the Engram write-through memory mirror (task R2 of
//! `odd/tasks/ronda3.md`, spec S2). The pure logic (settings validation,
//! payload mapping, client flow) lives in [`planner_core::engram`], tested
//! on Linux against a fake transport.
//!
//! Responsibilities here:
//! - the `chat-engram.json` settings file (Rust-owned, next to the memory
//!   file) and the `chat-engram-status.json` last-attempt record;
//! - the ureq [`EngramTransport`] implementation (short timeouts);
//! - the commands `engram_settings_get`, `engram_settings_set`,
//!   `engram_sync_now` and `engram_status`;
//! - the best-effort mirror hook [`mirror_after_write`] that
//!   `memory_store` fires after every successful local write: Engram is
//!   never on the UI path, so a dead Engram never fails or delays a local
//!   memory write (spec S2) — the hook runs on its own thread, ignores
//!   failures, and only records them in the status file.

use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use planner_core::chat::MemoryOp;
use planner_core::engram as core;
use planner_core::engram::EngramMirrorStatus;
use planner_core::engram::EngramRequest;
use planner_core::engram::EngramResponse;
use planner_core::engram::EngramSettings;
use planner_core::engram::EngramTransport;
use tauri::AppHandle;

use super::memory_store;

const SETTINGS_FILE_NAME: &str = "chat-engram.json";
const STATUS_FILE_NAME: &str = "chat-engram-status.json";

/// Connect timeout: a local Engram answers in milliseconds; anything slower
/// than a few seconds is down for the mirror's purposes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Whole-request timeout, per Engram call: the mirror never holds a worker
/// thread much past this.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// ureq transport

/// The real transport: one short-timeout ureq agent per call (the mirror is
/// low-frequency; agent construction cost is irrelevant next to the I/O).
struct UreqTransport;

impl EngramTransport for UreqTransport {
    fn call(&self, request: EngramRequest) -> Result<EngramResponse, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build();
        let call = match (request.method, request.json_body.as_deref()) {
            ("GET", _) => agent.get(&request.url).call(),
            ("DELETE", _) => agent.delete(&request.url).call(),
            (method, Some(body)) => agent
                .request(method, &request.url)
                .set("Content-Type", "application/json")
                .send_string(body),
            (method, None) => agent.request(method, &request.url).call(),
        };
        // Non-2xx replies arrive as Error::Status; the pure client owns the
        // meaning of every status, so surface them as responses.
        match call {
            Ok(response) => Ok(EngramResponse {
                status: response.status(),
                body: response.into_string().unwrap_or_default(),
            }),
            Err(ureq::Error::Status(status, response)) => Ok(EngramResponse {
                status,
                body: response.into_string().unwrap_or_default(),
            }),
            Err(ureq::Error::Transport(error)) => Err(error.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Settings and status files

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    memory_store::app_data_dir(app).map(|dir| dir.join(SETTINGS_FILE_NAME))
}

fn status_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    memory_store::app_data_dir(app).map(|dir| dir.join(STATUS_FILE_NAME))
}

/// The stored settings, or the spec defaults when nothing was saved yet. A
/// malformed settings file falls back to the defaults too (the mirror is
/// optional; nothing here may block the chat).
fn load_settings(app: &AppHandle) -> EngramSettings {
    let Ok(path) = settings_path(app) else {
        return EngramSettings::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<EngramSettings>(&text)
            .map(|settings| settings.normalized())
            .unwrap_or_default(),
        Err(_) => EngramSettings::default(),
    }
}

/// Serializes status writes (and sync-now's) through one lock so the temp
/// file never collides between the mirror threads and the UI command.
fn status_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

fn write_status(app: &AppHandle, status: &EngramMirrorStatus) {
    let _guard = status_lock();
    let Ok(path) = status_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string(status) {
        let _ = memory_store::atomic_write(&path, &json);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Best-effort mirror hook (fired by memory_store after successful writes)

/// Mirrors the ops of one successful local write, best effort. Called only
/// after the local save already succeeded: this function never reports a
/// failure upward (there is nothing to undo), never blocks the caller, and
/// does nothing when mirroring is off or the ops are empty.
pub(crate) fn mirror_after_write(app: &AppHandle, ops: &[MemoryOp]) {
    if ops.is_empty() {
        return;
    }
    let settings = load_settings(app);
    if !settings.enabled {
        return;
    }
    let app = app.clone();
    let ops = ops.to_vec();
    std::thread::spawn(move || {
        let mut synced = 0usize;
        let mut failure: Option<String> = None;
        for op in &ops {
            let result = match op {
                MemoryOp::Upsert {
                    topic_key,
                    title,
                    content,
                } => core::mirror_upsert(
                    &UreqTransport,
                    &settings,
                    &planner_core::chat::Memory {
                        // The remote row is keyed by topic_key; the local id
                        // and timestamp are not part of the mirror payload.
                        id: String::new(),
                        topic_key: topic_key.clone(),
                        title: title.clone(),
                        content: content.clone(),
                        updated_at: 0,
                    },
                )
                .map(|_| ()),
                MemoryOp::Delete { topic_key } => {
                    core::mirror_delete(&UreqTransport, &settings, topic_key).map(|_| ())
                }
            };
            match result {
                Ok(()) => synced += 1,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        write_status(
            &app,
            &EngramMirrorStatus {
                last_attempt_at: now_ms(),
                ok: failure.is_none(),
                synced,
                error: failure,
            },
        );
    });
}

// ---------------------------------------------------------------------------
// Commands

/// The stored Engram mirror settings (spec defaults when never saved).
#[tauri::command]
pub fn engram_settings_get(app: AppHandle) -> Result<EngramSettings, String> {
    Ok(load_settings(&app))
}

/// Saves the Engram mirror settings after validating them in Rust. The
/// address must be `https://` or loopback `http://` (the mirror talks to a
/// local Engram); the project name is capped and control-character free.
#[tauri::command]
pub fn engram_settings_set(app: AppHandle, settings: EngramSettings) -> Result<(), String> {
    let settings = core::validate_engram_settings(&settings)
        .map_err(|problem| problem.to_string())?;
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("the Engram settings could not be serialized: {error}"))?;
    memory_store::atomic_write(&path, &json)
}

/// "Sync now": pushes every local memory to Engram and removes every
/// mirrored topic the local store no longer has. The blocking HTTP work
/// runs on Tauri's blocking pool, never on the UI thread (same pattern as
/// `chat_complete`). The attempt is recorded in the status file either way.
#[tauri::command]
pub async fn engram_sync_now(app: AppHandle) -> Result<EngramMirrorStatus, String> {
    let settings = load_settings(&app);
    let attempt_at = now_ms();
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let memories = memory_store::load_all(&worker_app)?;
        core::sync_all(&UreqTransport, &settings, &memories)
    })
    .await
    .map_err(|error| format!("the sync worker failed: {error}"))?;
    let status = match result {
        Ok(report) => EngramMirrorStatus {
            last_attempt_at: attempt_at,
            ok: true,
            synced: report.upserted + report.deleted,
            error: None,
        },
        Err(error) => EngramMirrorStatus {
            last_attempt_at: attempt_at,
            ok: false,
            synced: 0,
            error: Some(error),
        },
    };
    write_status(&app, &status);
    Ok(status)
}

/// The last mirror attempt (any background write or "Sync now"), or `None`
/// before the first one.
#[tauri::command]
pub fn engram_status(app: AppHandle) -> Result<Option<EngramMirrorStatus>, String> {
    let path = status_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str::<EngramMirrorStatus>(&text).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "the Engram status could not be read: {error}"
        )),
    }
}

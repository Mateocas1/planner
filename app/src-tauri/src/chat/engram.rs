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
//!   memory write (spec S2) — the hook enqueues onto one mirror worker
//!   thread, which ignores failures and only records them in the status
//!   file.

use std::sync::mpsc::Sender;
use std::sync::OnceLock;
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
            // Never follow redirects: a loopback Engram could 307/308 a POST
            // to another host (ureq resends the body on those), and the
            // mirror must only ever talk to the configured address.
            .redirects(0)
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
        let _ = planner_core::fsutil::atomic_write(&path, &json);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Mirror worker (one ordered thread for every Engram side effect)

/// One unit of Engram work, processed strictly in arrival order by the
/// single mirror worker thread: per-op mirrors (upserts, deletes, clear-all
/// batches) and "Sync now" requests never race each other, so an upsert
/// followed by a delete of the same topic always leaves no remote row.
enum MirrorJob {
    /// Mirror the ops of one successful local write. Settings are loaded
    /// inside the worker (never on the caller/command thread).
    Ops {
        app: AppHandle,
        ops: Vec<MemoryOp>,
    },
    /// "Sync now": push every local memory, then report through `reply`.
    Sync {
        app: AppHandle,
        reply: std::sync::mpsc::Sender<Result<EngramMirrorStatus, String>>,
    },
}

/// The mirror worker's enqueue end. The thread is spawned once per process
/// and lives until exit; enqueueing never blocks and never fails the caller
/// (a dead worker only means the status file goes stale).
fn mirror_worker() -> &'static Sender<MirrorJob> {
    static WORKER: OnceLock<Sender<MirrorJob>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<MirrorJob>();
        let _ = std::thread::Builder::new()
            .name("engram-mirror".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    match job {
                        MirrorJob::Ops { app, ops } => {
                            let settings = load_settings(&app);
                            if !settings.enabled {
                                continue;
                            }
                            // The local write already succeeded; the report
                            // (including its failure) only feeds the status.
                            let report = core::mirror_ops(&UreqTransport, &settings, &ops);
                            write_status(
                                &app,
                                &EngramMirrorStatus {
                                    last_attempt_at: now_ms(),
                                    ok: report.failure.is_none(),
                                    synced: report.synced,
                                    error: report.failure,
                                },
                            );
                        }
                        MirrorJob::Sync { app, reply } => {
                            let settings = load_settings(&app);
                            let attempt_at = now_ms();
                            let result = memory_store::load_all(&app).and_then(|memories| {
                                core::sync_all(&UreqTransport, &settings, &memories)
                            });
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
                            let _ = reply.send(Ok(status));
                        }
                    }
                }
            });
        tx
    })
}

// ---------------------------------------------------------------------------
// Best-effort mirror hook (fired by memory_store after successful writes)

/// Mirrors the ops of one successful local write, best effort. Called only
/// after the local save already succeeded: this function never reports a
/// failure upward (there is nothing to undo), never blocks the caller, and
/// does nothing when mirroring is off or the ops are empty. The Engram work
/// runs on the single mirror worker, in order, off the caller thread.
pub(crate) fn mirror_after_write(app: &AppHandle, ops: &[MemoryOp]) {
    if ops.is_empty() {
        return;
    }
    let _ = mirror_worker().send(MirrorJob::Ops {
        app: app.clone(),
        ops: ops.to_vec(),
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
    planner_core::fsutil::atomic_write(&path, &json)
}

/// "Sync now": pushes every local memory to Engram and removes every
/// mirrored topic the local store no longer has. The job is queued behind
/// any pending per-op mirrors (one worker, so it observes the store's
/// latest state) and its blocking HTTP work runs on the worker thread, off
/// the async runtime. The attempt is recorded in the status file either way.
#[tauri::command]
pub async fn engram_sync_now(app: AppHandle) -> Result<EngramMirrorStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    mirror_worker()
        .send(MirrorJob::Sync {
            app,
            reply: tx,
        })
        .map_err(|error| format!("the mirror worker is gone: {error}"))?;
    // The worker always replies; wait off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|error| format!("the sync worker failed: {error}"))?
        .map_err(|error| format!("the mirror worker dropped the sync reply: {error}"))?
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

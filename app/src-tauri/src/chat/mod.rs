//! Desktop chat transport (task C1 of `odd/tasks/llm-chat.md`, specs S3 and
//! S5): the API key in the Windows Credential Manager, the non-secret
//! provider address in a Rust-owned settings file (the key is bound to its
//! provider: changing provider = setting the key again), SSE streaming
//! through `ureq` in a worker thread reporting over a Tauri `Channel`,
//! cancellation, non-streamed completions, and the local memory file store
//! ([`memory_store`]).
//!
//! Security invariants (spec S3): the key is read from the OS credential
//! store per request, is never returned to the webview, never logged, and
//! never written to disk by the app. Rust makes the HTTPS call, so the key
//! never reaches the page. The provider base URL is validated in Rust
//! (never taken from the webview per call) and never echoed in error
//! messages.

pub mod engram;
pub mod memory_store;

use std::collections::HashMap;
use std::fs;
use std::io;
use std::io::BufReader;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use planner_core::chat::chat_completions_url;
use planner_core::chat::error_code_for_status;
use planner_core::chat::validate_base_url;
use planner_core::chat::{read_limited_line, LineError};
use planner_core::chat::validate_key;
use planner_core::chat::ChatErrorCode;
use planner_core::chat::ChatEvent;
use planner_core::chat::KeyProblem;
use planner_core::chat::MAX_KEY_CHARS;
use planner_core::chat::MAX_SSE_LINE_BYTES;
use planner_core::chat::StreamDecoder;
use planner_core::chat::StreamEvent;
use serde::Deserialize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

/// Credential Manager service and account names (spec S3).
#[cfg(target_os = "windows")]
const KEY_SERVICE: &str = "com.picala.planner";
#[cfg(target_os = "windows")]
const KEY_USER: &str = "chat-api-key";

/// Longest accepted API key, in characters: [`planner_core::chat::MAX_KEY_CHARS`].
/// Connect timeout: the provider must answer fast; reasoning comes after.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-read timeout: one `read` that sees no data for this long is a stall
/// tick. The stream loop keeps waiting (checking the cancel flag between
/// ticks) until [`MAX_STALL`] passes without any data, so cancel is
/// observable within seconds even while the provider sends nothing.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Total time a stream may go without any data before it fails as
/// `network`: reasoning models can pause for a long time.
const MAX_STALL: Duration = Duration::from_secs(300);
/// Cap on the provider error text surfaced to the webview.
const ERROR_MESSAGE_MAX_CHARS: usize = 300;
/// Maximum number of streams running at the same time (security review #5).
const MAX_CONCURRENT_STREAMS: usize = 4;
/// Non-secret provider settings, bound to the stored key (security review
/// #3): the webview never sends a base URL per call.
const PROVIDER_FILE_NAME: &str = "chat-provider.json";

// ---------------------------------------------------------------------------
// IPC shapes (mirrors of `app/src/chat/types.ts`)

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

/// The rejection of a command call (`chat_complete` or the local checks of
/// `chat_stream`), serialized to the webview as `{code, message}`.
#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: ChatErrorCode,
    pub message: String,
}

impl IpcError {
    fn new(code: ChatErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Cancel flags of the running streams, keyed by the request id. The stream
/// worker removes its entry only if it still holds the same flag
/// (`Arc::ptr_eq`), so a finished stream can never delete a newer one's
/// entry (security review #5).
#[derive(Default)]
pub struct ChatStreams(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

/// Locks the registry without panicking on a poisoned lock (unreachable
/// under `panic = "abort"`, but never worth a crash).
fn lock_registry(
    registry: &Mutex<HashMap<String, Arc<AtomicBool>>>,
) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------
// Key storage (spec S3). The key only ever lives in the credential store.

#[cfg(target_os = "windows")]
fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER)
        .map_err(|error| format!("the credential store is unavailable: {error}"))
}

/// Reads the stored key, if any. Never logs or returns the key itself except
/// to the caller that uses it as a request header.
#[cfg(target_os = "windows")]
fn stored_key() -> Result<Option<String>, String> {
    match key_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("the stored key could not be read: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn store_key(key: &str) -> Result<(), String> {
    key_entry()
        .and_then(|entry| entry.set_password(key).map_err(|error| error.to_string()))
        .map_err(|error| format!("the key could not be saved: {error}"))
}

#[cfg(target_os = "windows")]
fn clear_stored_key() -> Result<(), String> {
    match key_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Removing a key that is not there is already the desired state.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("the key could not be removed: {error}")),
    }
}

/// Non-Windows builds (a Linux `cargo check` of this crate) have no shell to
/// hold a key; the desktop target is Windows-only.
#[cfg(not(target_os = "windows"))]
fn stored_key() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn store_key(_key: &str) -> Result<(), String> {
    Err("the credential store is only available on Windows".into())
}

#[cfg(not(target_os = "windows"))]
fn clear_stored_key() -> Result<(), String> {
    Ok(())
}

// --- Non-secret provider settings, bound to the stored key ---

/// The stored provider settings: which OpenAI-compatible endpoint the key
/// belongs to. The base URL is not secret; it lives next to the memory file
/// in the app data dir, in a Rust-owned file the webview cannot write.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    base_url: String,
}

/// The stored base URL, validated when it was saved. A missing or unreadable
/// settings file means "no provider configured"; the key is then unusable
/// until it is set again (changing provider = setting the key again).
fn stored_base_url(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let path = memory_store::app_data_dir(app)?.join(PROVIDER_FILE_NAME);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str::<ProviderConfig>(&text)
            .ok()
            .map(|config| config.base_url)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "the provider settings could not be read: {error}"
        )),
    }
}

fn store_base_url(app: &tauri::AppHandle, base_url: &str) -> Result<(), String> {
    let path = memory_store::app_data_dir(app)?.join(PROVIDER_FILE_NAME);
    let json = serde_json::to_string(&ProviderConfig {
        base_url: base_url.to_string(),
    })
    .map_err(|error| format!("the provider settings could not be serialized: {error}"))?;
    memory_store::atomic_write(&path, &json)
}

fn remove_base_url(app: &tauri::AppHandle) {
    if let Ok(path) = memory_store::app_data_dir(app) {
        let _ = fs::remove_file(path.join(PROVIDER_FILE_NAME));
    }
}

/// Whether an API key is saved, and which provider address it is bound to.
/// The key itself is never returned to the webview (spec S3); the base URL
/// is not secret.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatKeyStatus {
    pub has_key: bool,
    pub base_url: Option<String>,
}

#[tauri::command]
pub fn chat_key_status(app: tauri::AppHandle) -> Result<ChatKeyStatus, String> {
    let has_key = stored_key()?.is_some();
    let base_url = stored_base_url(&app)?;
    Ok(ChatKeyStatus { has_key, base_url })
}

/// Saves the API key together with the provider address it belongs to.
/// Empty/whitespace keys, keys over 512 characters, keys with control
/// characters (CRLF header injection) and disallowed addresses are rejected
/// before anything is stored. Changing the provider means setting the key
/// again.
#[tauri::command]
pub fn chat_key_set(
    app: tauri::AppHandle,
    key: String,
    base_url: String,
) -> Result<(), String> {
    let key = key.trim();
    if let Err(problem) = validate_key(key) {
        return Err(match problem {
            KeyProblem::TooLong => format!(
                "The API key must be at most {MAX_KEY_CHARS} characters."
            ),
            other => other.to_string(),
        });
    }
    let base_url = base_url.trim().to_string();
    if validate_base_url(&base_url).is_err() {
        // Never echo the raw URL: it may contain userinfo.
        return Err("The provider address is not allowed.".into());
    }
    store_key(key)?;
    store_base_url(&app, &base_url)
}

/// Removes the API key and the provider address bound to it.
#[tauri::command]
pub fn chat_key_clear(app: tauri::AppHandle) -> Result<(), String> {
    let result = clear_stored_key();
    remove_base_url(&app);
    result
}

// ---------------------------------------------------------------------------
// Streaming (spec S3)

/// Starts one streamed reply on a worker thread. Returns immediately; the
/// reply arrives as [`ChatEvent`]s on the channel, ending with `done`,
/// `cancelled`, or `error`. The provider address comes from the stored
/// settings (bound to the key), never from the webview. Only a local
/// rejection fails the call itself.
#[tauri::command]
pub fn chat_stream(
    streams: State<'_, ChatStreams>,
    app: tauri::AppHandle,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> Result<(), IpcError> {
    let base_url = stored_base_url(&app)
        .map_err(|message| IpcError::new(ChatErrorCode::Provider, message))?
        .ok_or_else(|| {
            IpcError::new(
                ChatErrorCode::NoKey,
                "No provider is configured. Save your API key in Settings.",
            )
        })?;
    if validate_base_url(&base_url).is_err() {
        return Err(IpcError::new(
            ChatErrorCode::InvalidRequest,
            "the provider address is not allowed",
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut registry = lock_registry(&streams.0);
    if registry.contains_key(&request.id) {
        return Err(IpcError::new(
            ChatErrorCode::InvalidRequest,
            "a reply with this id is already in flight",
        ));
    }
    if registry.len() >= MAX_CONCURRENT_STREAMS {
        return Err(IpcError::new(
            ChatErrorCode::InvalidRequest,
            "too many concurrent replies; stop one first",
        ));
    }
    registry.insert(request.id.clone(), Arc::clone(&cancel));
    drop(registry);
    let registry = Arc::clone(&streams.0);
    let id = request.id.clone();
    std::thread::spawn(move || {
        run_stream(request, base_url, Arc::clone(&cancel), &on_event);
        // Remove the entry only if it is still this stream's flag: a reused
        // id that was rejected must not let the old worker delete the new
        // stream's cancel flag.
        let mut registry = lock_registry(&registry);
        if registry
            .get(&id)
            .is_some_and(|flag| Arc::ptr_eq(flag, &cancel))
        {
            registry.remove(&id);
        }
    });
    Ok(())
}

fn run_stream(
    request: ChatRequest,
    base_url: String,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<ChatEvent>,
) {
    let key = match stored_key() {
        Ok(Some(key)) => key,
        Ok(None) => {
            let _ = on_event.send(ChatEvent::Error {
                code: ChatErrorCode::NoKey,
                message: "No API key is saved. Add one in Settings.".into(),
            });
            return;
        }
        Err(message) => {
            let _ = on_event.send(ChatEvent::Error {
                code: ChatErrorCode::Provider,
                message,
            });
            return;
        }
    };
    let body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "stream": true,
    });
    let url = chat_completions_url(&base_url);
    match http_agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(body)
    {
        Ok(response) => stream_response(response, &cancel, on_event),
        Err(ureq::Error::Status(status, response)) => {
            let _ = on_event.send(ChatEvent::Error {
                code: error_code_for_status(status),
                message: provider_error_message(status, response),
            });
        }
        Err(ureq::Error::Transport(error)) => {
            let _ = on_event.send(ChatEvent::Error {
                code: ChatErrorCode::Network,
                message: format!("could not reach the provider: {error}"),
            });
        }
    }
}

/// Whether this read error is a timeout (the provider sent nothing for
/// [`READ_TIMEOUT`]) rather than a real failure. ureq normalizes socket
/// read timeouts to `TimedOut`; the loop below keeps waiting until
/// [`MAX_STALL`] passes without data, checking the cancel flag between
/// ticks, so cancel stays observable during a stalled read.
fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

/// Reads the SSE body line by line, emitting events until `[DONE]`, EOF, a
/// malformed chunk, a failed send (webview gone), or the cancel flag.
/// Cancel is checked between lines and between stall ticks: a provider that
/// stops sending is cancelled within seconds or fails as `network` after
/// [`MAX_STALL`] without data.
fn stream_response(response: ureq::Response, cancel: &AtomicBool, on_event: &Channel<ChatEvent>) {
    let mut reader = BufReader::new(response.into_reader());
    let mut decoder = StreamDecoder::new();
    // The unfinished line survives stall ticks (read timeouts).
    let mut pending = Vec::new();
    let mut last_data = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = on_event.send(ChatEvent::Cancelled);
            return;
        }
        let line = match read_limited_line(&mut reader, &mut pending, MAX_SSE_LINE_BYTES) {
            Ok(Some(line)) => {
                last_data = Instant::now();
                line
            }
            Ok(None) => break, // EOF: a stream without `[DONE]` still ends
            Err(LineError::Overlong) => {
                let _ = on_event.send(ChatEvent::Error {
                    code: ChatErrorCode::Provider,
                    message: "the provider sent an oversized reply line".into(),
                });
                return;
            }
            Err(LineError::Io(error)) if is_timeout(&error) => {
                if last_data.elapsed() < MAX_STALL {
                    continue; // stall tick: re-check cancel at the loop head
                }
                let _ = on_event.send(ChatEvent::Error {
                    code: ChatErrorCode::Network,
                    message: "the provider stopped responding".into(),
                });
                return;
            }
            Err(LineError::Io(_)) => {
                // A read error (reset, TLS failure) interrupts the reply.
                let _ = on_event.send(ChatEvent::Error {
                    code: ChatErrorCode::Network,
                    message: "the reply stream was interrupted".into(),
                });
                return;
            }
        };
        for event in decoder.feed(&line) {
            match event {
                StreamEvent::Done => {}
                StreamEvent::Malformed => {
                    let _ = on_event.send(ChatEvent::Error {
                        code: ChatErrorCode::Provider,
                        message: "the provider sent a malformed reply stream".into(),
                    });
                    return;
                }
                StreamEvent::Reasoning => {
                    if on_event.send(ChatEvent::Reasoning).is_err() {
                        return; // the webview is gone; stop the work
                    }
                }
                StreamEvent::Delta(text) => {
                    if on_event.send(ChatEvent::Delta { text }).is_err() {
                        return;
                    }
                }
            }
        }
        if decoder.is_done() {
            let _ = on_event.send(ChatEvent::Done);
            return;
        }
    }
    if cancel.load(Ordering::Relaxed) {
        let _ = on_event.send(ChatEvent::Cancelled);
    } else {
        let _ = on_event.send(ChatEvent::Done);
    }
}

/// Marks the reply with this id as cancelled; its worker stops between lines
/// (or between stall ticks) and emits `cancelled`. Unknown ids (finished or
/// never started) are a no-op.
#[tauri::command]
pub fn chat_cancel(streams: State<'_, ChatStreams>, id: String) -> Result<(), String> {
    if let Some(cancel) = lock_registry(&streams.0).get(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// One non-streamed completion (memory extraction): same validation and error
/// codes as the stream, returned as a rejection instead of an event. The
/// blocking HTTP work runs on Tauri's blocking pool, never on the UI thread
/// (security review #4).
#[tauri::command]
pub async fn chat_complete(
    app: tauri::AppHandle,
    request: ChatRequest,
) -> Result<String, IpcError> {
    let base_url = stored_base_url(&app)
        .map_err(|message| IpcError::new(ChatErrorCode::Provider, message))?
        .ok_or_else(|| {
            IpcError::new(
                ChatErrorCode::NoKey,
                "No provider is configured. Save your API key in Settings.",
            )
        })?;
    tauri::async_runtime::spawn_blocking(move || run_complete(request, base_url))
        .await
        .map_err(|error| {
            IpcError::new(
                ChatErrorCode::Provider,
                format!("the completion worker failed: {error}"),
            )
        })?
}

/// The blocking body of [`chat_complete`]: key read, HTTP call, JSON parse.
fn run_complete(request: ChatRequest, base_url: String) -> Result<String, IpcError> {
    if validate_base_url(&base_url).is_err() {
        return Err(IpcError::new(
            ChatErrorCode::InvalidRequest,
            "the provider address is not allowed",
        ));
    }
    let key = stored_key()
        .map_err(|message| IpcError::new(ChatErrorCode::Provider, message))?
        .ok_or_else(|| {
            IpcError::new(ChatErrorCode::NoKey, "No API key is saved. Add one in Settings.")
        })?;
    let body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "stream": false,
    });
    let url = chat_completions_url(&base_url);
    match http_agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(body)
    {
        Ok(response) => {
            let value: serde_json::Value = response.into_json().map_err(|error| {
                IpcError::new(
                    ChatErrorCode::Provider,
                    format!("the completion reply was not valid JSON: {error}"),
                )
            })?;
            match value.pointer("/choices/0/message/content").and_then(|content| content.as_str()) {
                Some(content) => Ok(content.to_string()),
                None => Err(IpcError::new(
                    ChatErrorCode::Provider,
                    "the completion reply had no message content",
                )),
            }
        }
        Err(ureq::Error::Status(status, response)) => Err(IpcError {
            code: error_code_for_status(status),
            message: provider_error_message(status, response),
        }),
        Err(ureq::Error::Transport(error)) => Err(IpcError::new(
            ChatErrorCode::Network,
            format!("could not reach the provider: {error}"),
        )),
    }
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build()
}

fn provider_error_message(status: u16, response: ureq::Response) -> String {
    let body = response.into_string().unwrap_or_default();
    let body: String = body
        .chars()
        .take(ERROR_MESSAGE_MAX_CHARS)
        .collect();
    if body.trim().is_empty() {
        format!("The provider returned HTTP {status}.")
    } else {
        body
    }
}

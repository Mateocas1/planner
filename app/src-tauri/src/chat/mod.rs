//! Desktop chat transport (task C1 of `odd/tasks/llm-chat.md`, specs S3 and
//! S5): the API key in the Windows Credential Manager, SSE streaming through
//! `ureq` in a worker thread reporting over a Tauri `Channel`, cancellation,
//! non-streamed completions, and the local memory file store
//! ([`memory_store`]).
//!
//! Security invariants (spec S3): the key is read from the OS credential
//! store per request, is never returned to the webview, never logged, and
//! never written to disk by the app. Rust makes the HTTPS call, so the key
//! never reaches the page.

pub mod memory_store;

use std::collections::HashMap;
use std::io::BufRead;
use std::io::BufReader;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use planner_core::chat::chat_completions_url;
use planner_core::chat::error_code_for_status;
use planner_core::chat::validate_base_url;
use planner_core::chat::ChatErrorCode;
use planner_core::chat::ChatEvent;
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

/// Longest accepted API key, in characters.
const MAX_KEY_CHARS: usize = 512;
/// Connect timeout: the provider must answer fast; reasoning comes after.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Read timeout between chunks: reasoning models can pause for a long time.
const READ_TIMEOUT: Duration = Duration::from_secs(300);
/// Cap on the provider error text surfaced to the webview.
const ERROR_MESSAGE_MAX_CHARS: usize = 300;

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
/// worker removes its entry when the reply finishes or is dropped.
#[derive(Default)]
pub struct ChatStreams(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

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

/// Whether an API key is saved. It is only a boolean: the key itself is never
/// returned to the webview (spec S3).
#[tauri::command]
pub fn chat_key_status() -> Result<bool, String> {
    Ok(stored_key()?.is_some())
}

/// Saves the API key. Empty/whitespace keys and keys over 512 characters are
/// rejected before touching the credential store.
#[tauri::command]
pub fn chat_key_set(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("The API key must not be empty.".into());
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err(format!(
            "The API key must be at most {MAX_KEY_CHARS} characters."
        ));
    }
    store_key(key)
}

/// Removes the API key.
#[tauri::command]
pub fn chat_key_clear() -> Result<(), String> {
    clear_stored_key()
}

// ---------------------------------------------------------------------------
// Streaming (spec S3)

/// Starts one streamed reply on a worker thread. Returns immediately; the
/// reply arrives as [`ChatEvent`]s on the channel, ending with `done`,
/// `cancelled`, or `error`. Only a local rejection (bad base URL) fails the
/// call itself.
#[tauri::command]
pub fn chat_stream(
    streams: State<'_, ChatStreams>,
    request: ChatRequest,
    base_url: String,
    on_event: Channel<ChatEvent>,
) -> Result<(), IpcError> {
    let base_url = base_url.trim().to_string();
    if let Err(code) = validate_base_url(&base_url) {
        return Err(IpcError::new(
            code,
            format!("the provider address is not allowed: {base_url}"),
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    streams
        .0
        .lock()
        .expect("chat stream registry")
        .insert(request.id.clone(), Arc::clone(&cancel));
    let registry = Arc::clone(&streams.0);
    let id = request.id.clone();
    std::thread::spawn(move || {
        run_stream(request, base_url, cancel, &on_event);
        registry.lock().expect("chat stream registry").remove(&id);
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

/// Reads the SSE body line by line, emitting events until `[DONE]`, EOF, a
/// malformed chunk, a failed send (webview gone), or the cancel flag — which
/// is checked between lines.
fn stream_response(response: ureq::Response, cancel: &AtomicBool, on_event: &Channel<ChatEvent>) {
    let reader = response.into_reader();
    let mut decoder = StreamDecoder::new();
    for line in BufReader::new(reader).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = on_event.send(ChatEvent::Cancelled);
            return;
        }
        let Ok(line) = line else {
            // A read error (timeout, reset) interrupts the reply mid-stream.
            let _ = on_event.send(ChatEvent::Error {
                code: ChatErrorCode::Network,
                message: "the reply stream was interrupted".into(),
            });
            return;
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
    // A stream that ends without `[DONE]` still counts as finished.
    if cancel.load(Ordering::Relaxed) {
        let _ = on_event.send(ChatEvent::Cancelled);
    } else {
        let _ = on_event.send(ChatEvent::Done);
    }
}

/// Marks the reply with this id as cancelled; its worker stops between lines
/// and emits `cancelled`. Unknown ids (finished or never started) are a no-op.
#[tauri::command]
pub fn chat_cancel(streams: State<'_, ChatStreams>, id: String) -> Result<(), String> {
    if let Some(cancel) = streams.0.lock().expect("chat stream registry").get(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// One non-streamed completion (memory extraction): same validation and error
/// codes as the stream, returned as a rejection instead of an event.
#[tauri::command]
pub fn chat_complete(request: ChatRequest, base_url: String) -> Result<String, IpcError> {
    let base_url = base_url.trim().to_string();
    if let Err(code) = validate_base_url(&base_url) {
        return Err(IpcError::new(
            code,
            format!("the provider address is not allowed: {base_url}"),
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

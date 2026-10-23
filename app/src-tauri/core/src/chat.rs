//! Pure half of the desktop LLM chat (task C1 of `odd/tasks/llm-chat.md`,
//! specs S3 and S5). The Tauri glue lives in `../../src/chat/`.
//!
//! Everything here is platform-independent and unit-tested on Linux: the SSE
//! line decoder for OpenAI-compatible chat-completion streams, the base-URL
//! validation, the HTTP status → error-code mapping, and the memory-file
//! operation logic (topic-key upserts, caps). Serialization shapes mirror the
//! TypeScript contract in `app/src/chat/types.ts`.

use std::fmt;
use std::io;

use serde::{Deserialize, Serialize};

/// Error codes of the chat contract (`app/src/chat/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatErrorCode {
    /// No API key stored.
    NoKey,
    /// Provider rejected the key (401/403).
    Unauthorized,
    /// 429.
    RateLimited,
    /// DNS/TLS/connection/timeout.
    Network,
    /// Any other non-2xx or malformed stream.
    Provider,
    /// Rejected locally (bad base URL, empty messages).
    InvalidRequest,
}

/// One complete tool call proposed by the model: the id, the function name
/// and the JSON arguments concatenated across stream chunks. Serialized to
/// the webview as `{id, name, arguments}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallPayload {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One event of a streamed reply, serialized with `"type"` tags.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    /// The model started reasoning; its text is not shown.
    Reasoning,
    /// A piece of the answer text.
    Delta { text: String },
    /// The model proposed one complete tool call (its arguments are the
    /// concatenation of every fragment seen so far for its index).
    ToolCall { call: ToolCallPayload },
    /// The stream ended.
    Done,
    /// The stream was cancelled by the user.
    Cancelled,
    /// A terminal failure.
    Error { code: ChatErrorCode, message: String },
}

// ---------------------------------------------------------------------------
// SSE decoding

/// One decoded piece of an SSE reply body (the `data:` lines of an
/// OpenAI-compatible chat-completion stream).
#[derive(Debug, PartialEq)]
pub enum StreamEvent {
    /// The model started reasoning (`delta.reasoning_content` first appeared).
    Reasoning,
    /// A non-empty piece of the answer text.
    Delta(String),
    /// One tool call became complete: its id, function name and the arguments
    /// accumulated so far. Emitted when a later call index starts, or when
    /// the stream ends — never mid-call.
    ToolCall(ToolCallPayload),
    /// The stream ended (`data: [DONE]`).
    Done,
    /// A `data:` line that is neither `[DONE]` nor parseable stream JSON.
    Malformed,
}

/// One tool call being accumulated from `delta.tool_calls` fragments.
#[derive(Debug, Default, Clone)]
struct AccumToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Incremental decoder for the lines of one SSE reply body.
///
/// Feed it every body line (comments, empty lines and non-`data` fields are
/// ignored); collect the events it yields in order. `reasoning` is emitted
/// once per stream, on the first appearance of `delta.reasoning_content`;
/// chunks with an empty `delta` produce nothing; a `data:` line that does not
/// parse as a chunk is [`StreamEvent::Malformed`] and the caller must treat
/// the stream as failed.
///
/// Tool calls: `delta.tool_calls` fragments are accumulated per call `index`.
/// A chunk without an index continues the call being accumulated — unless it
/// carries a new call `id`, which starts a new call (a provider that never
/// sends indexes must still be able to open a second call). Calls may
/// interleave, so a call is emitted complete — one [`StreamEvent::ToolCall`],
/// in index order — only when the stream ends: `data: [DONE]`, or the caller
/// draining via [`StreamDecoder::flush_tool_calls`] at EOF. Every call event
/// therefore arrives before `Done`. A completed call without a function name
/// is `Malformed` — at `[DONE]` and at EOF flush alike, so the caller never
/// silently drops it.
#[derive(Debug, Default)]
pub struct StreamDecoder {
    reasoning_emitted: bool,
    done: bool,
    /// Calls being accumulated, ordered by their stream index.
    tool_calls: Vec<AccumToolCall>,
    /// How many of `tool_calls` were already emitted as complete events.
    emitted_calls: usize,
    /// The request's id, prepended to fallback call ids so a provider that
    /// omits ids still gets handles unique across requests (two turns of the
    /// same conversation both propose `call_0` otherwise, and one Confirm
    /// would resolve two cards).
    request_id: String,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Binds the decoder to one request id, used only to make fallback call
    /// ids unique per request.
    pub fn with_request_id(mut self, request_id: &str) -> Self {
        self.request_id = request_id.to_string();
        self
    }

    /// Whether `[DONE]` was seen; the caller can then stop reading.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Emits every accumulated-but-unfinished tool call, in index order. The
    /// caller uses this once at end of stream (EOF without `[DONE]`) so a
    /// reply whose calls were never followed by a higher index still delivers
    /// them before `Done`.
    pub fn flush_tool_calls(&mut self) -> Vec<StreamEvent> {
        self.emit_tool_calls(self.tool_calls.len())
    }

    /// Finalizes accumulated calls `from..limit` into complete events, in
    /// index order. A call with no function name is not a call the UI could
    /// act on: it fails the stream as malformed.
    fn emit_tool_calls(&mut self, limit: usize) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        while self.emitted_calls < limit {
            let index = self.emitted_calls;
            let call = &self.tool_calls[index];
            if call.name.is_empty() {
                return vec![StreamEvent::Malformed];
            }
            let id = if call.id.is_empty() {
                // OpenAI-compatible streams send an id in the first fragment;
                // a provider that omits it still gets a usable handle for the
                // tool result the UI answers with — unique per request, so
                // two turns cannot collide on the same fallback id.
                if self.request_id.is_empty() {
                    format!("call_{index}")
                } else {
                    format!("call_{}_{}", self.request_id, index)
                }
            } else {
                call.id.clone()
            };
            events.push(StreamEvent::ToolCall(ToolCallPayload {
                id,
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            }));
            self.emitted_calls += 1;
        }
        events
    }

    /// Accumulates one `delta.tool_calls` entry into the call at `index`.
    /// Calls are never finalized here: fragments may interleave, so a call is
    /// only complete when the stream ends (`[DONE]` or the caller's flush).
    fn accumulate_tool_call(&mut self, entry: &serde_json::Value, index: usize) -> Vec<StreamEvent> {
        if index == self.tool_calls.len() {
            self.tool_calls.push(AccumToolCall::default());
        } else if index > self.tool_calls.len() {
            // A gap means the provider is not speaking the protocol.
            return vec![StreamEvent::Malformed];
        }
        Vec::new()
    }

    /// Decodes one body line into zero or more events.
    pub fn feed(&mut self, line: &str) -> Vec<StreamEvent> {
        let line = line.trim_end_matches(['\r', '\n']);
        // SSE comment / keep-alive, and the empty dispatch separator.
        if line.is_empty() || line.starts_with(':') {
            return Vec::new();
        }
        // `event:`, `id:`, `retry:` fields are ignored; only `data:` carries
        // payload in OpenAI-compatible streams.
        let Some(data) = line.strip_prefix("data:") else {
            return Vec::new();
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.done = true;
            let mut events = self.emit_tool_calls(self.tool_calls.len());
            events.push(StreamEvent::Done);
            return events;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return vec![StreamEvent::Malformed];
        };
        if value.get("error").is_some() {
            return vec![StreamEvent::Malformed];
        }
        // A chunk without choices (e.g. a closing usage-only chunk) carries
        // no text: skip it rather than failing the reply.
        let Some(choice) = value
            .get("choices")
            .and_then(|choices| choices.as_array())
            .and_then(|choices| choices.first())
        else {
            return Vec::new();
        };
        let mut events = Vec::new();
        if let Some(delta) = choice.get("delta") {
            let reasons = matches!(
                delta.get("reasoning_content"),
                Some(serde_json::Value::String(_))
            );
            if reasons && !self.reasoning_emitted {
                self.reasoning_emitted = true;
                events.push(StreamEvent::Reasoning);
            }
            if let Some(text) = delta.get("content").and_then(|content| content.as_str()) {
                if !text.is_empty() {
                    events.push(StreamEvent::Delta(text.to_string()));
                }
            }
            if let Some(entries) = delta.get("tool_calls").and_then(|entries| entries.as_array()) {
                for entry in entries {
                    // OpenAI-compatible streams mark each fragment with the
                    // call's `index`. A stream that omits it continues the
                    // call being accumulated — unless the fragment opens with
                    // a new call `id`, which starts a new call (otherwise two
                    // index-less calls concatenate into one name). No index
                    // and no id at all, with no call accumulated yet, starts
                    // the first one.
                    let index = match entry
                        .get("index")
                        .and_then(|index| index.as_u64())
                        .map(|index| index as usize)
                    {
                        Some(index) => index,
                        None => {
                            let opens_new_call = entry
                                .get("id")
                                .and_then(|id| id.as_str())
                                .is_some_and(|id| !id.is_empty());
                            if opens_new_call {
                                self.tool_calls.len()
                            } else {
                                self.tool_calls.len().saturating_sub(1)
                            }
                        }
                    };
                    events.extend(self.accumulate_tool_call(entry, index));
                    if events.last() == Some(&StreamEvent::Malformed) {
                        return events;
                    }
                    let Some(call) = self.tool_calls.get_mut(index) else {
                        continue;
                    };
                    if let Some(id) = entry.get("id").and_then(|id| id.as_str()) {
                        call.id = id.to_string();
                    }
                    if let Some(function) = entry.get("function") {
                        if let Some(name) = function.get("name").and_then(|name| name.as_str()) {
                            call.name.push_str(name);
                        }
                        if let Some(arguments) = function.get("arguments").and_then(|arguments| arguments.as_str()) {
                            call.arguments.push_str(arguments);
                        }
                    }
                }
            }
            // An empty delta (`{}`) yields nothing: the signal the UI needs
            // already arrived through the chunks that carry text.
        }
        events
    }
}

// ---------------------------------------------------------------------------
// Request validation and error mapping

/// Longest accepted API key, in characters.
pub const MAX_KEY_CHARS: usize = 512;

// ---------------------------------------------------------------------------
// Provider wire shape (Ronda 3 R1)

/// One conversation turn as the webview sends it over IPC (camelCase
/// `toolCalls` / `toolCallId`), mirroring `app/src/chat/types.ts`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMessage {
    pub role: String,
    pub content: String,
    /// Assistant only: the tool calls this reply proposes, in the flat
    /// `{id, name, arguments}` IPC shape. [`provider_body`] converts them to
    /// the OpenAI wire shape — the single conversion point on the path to the
    /// provider, unit-tested in this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<WireToolCall>>,
    /// Tool only: the id of the call this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// One tool call over IPC, in the flat shape `app/src/chat/types.ts` calls
/// `ChatToolCall` (the same shape the `tool_call` event carries).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One message in the provider's wire shape: snake_case `tool_calls` /
/// `tool_call_id`, each call in the OpenAI `{id, type: "function",
/// function: {name, arguments}}` shape, and `content: null` on an assistant
/// turn that only proposes tool calls (the OpenAI protocol there expects
/// null, not `""`).
fn provider_message(message: &WireMessage) -> serde_json::Value {
    let only_tool_calls =
        message.role == "assistant" && message.content.is_empty() && message.tool_calls.is_some();
    let mut value = serde_json::json!({
        "role": message.role,
        "content": if only_tool_calls {
            serde_json::Value::Null
        } else {
            serde_json::json!(message.content)
        },
    });
    if let Some(tool_calls) = &message.tool_calls {
        value["tool_calls"] = serde_json::json!(tool_calls.iter().map(|call| serde_json::json!({
            "id": call.id,
            "type": "function",
            "function": {"name": call.name, "arguments": call.arguments},
        })).collect::<Vec<_>>());
    }
    if let Some(tool_call_id) = &message.tool_call_id {
        value["tool_call_id"] = serde_json::json!(tool_call_id);
    }
    value
}

/// The request body for `{base_url}/chat/completions`: `messages` mapped onto
/// the provider's wire shape, `tools` forwarded verbatim when present, and
/// `stream` as requested.
pub fn provider_body(model: &str, messages: &[WireMessage], tools: Option<&Vec<serde_json::Value>>, stream: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(provider_message).collect::<Vec<_>>(),
        "stream": stream,
    });
    if let Some(tools) = tools {
        body["tools"] = serde_json::json!(tools);
    }
    body
}

/// Why an API key was rejected before it may touch the credential store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProblem {
    /// Empty or whitespace only.
    Empty,
    /// More than [`MAX_KEY_CHARS`] characters.
    TooLong,
    /// Contains a control character: a CRLF would inject headers into the
    /// provider request (the `Authorization` header value is written
    /// unvalidated by ureq).
    ControlChars,
}

impl fmt::Display for KeyProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            KeyProblem::Empty => "The API key must not be empty.",
            KeyProblem::TooLong => "The API key is too long.",
            KeyProblem::ControlChars => "The API key must not contain control characters.",
        };
        f.write_str(text)
    }
}

/// Validates an API key before it is stored. The key is trimmed by the
/// caller before this runs, so [`KeyProblem::Empty`] covers whitespace-only
/// input too.
pub fn validate_key(key: &str) -> Result<(), KeyProblem> {
    let key = key.trim();
    if key.is_empty() {
        return Err(KeyProblem::Empty);
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err(KeyProblem::TooLong);
    }
    if key.chars().any(char::is_control) {
        return Err(KeyProblem::ControlChars);
    }
    Ok(())
}

/// Validates a provider base URL: `https://` anywhere, or `http://` on the
/// loopback hosts only (any port, so a local proxy or dev server works).
/// URLs carrying userinfo (`https://user:pass@host`) are rejected: the
/// credentials would be sent to the host, and callers must never echo the
/// raw URL back (it may contain secrets) — rejection messages say only that
/// the provider address is not allowed.
pub fn validate_base_url(base_url: &str) -> Result<(), ChatErrorCode> {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return Err(ChatErrorCode::InvalidRequest);
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ChatErrorCode::InvalidRequest);
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) => Ok(()),
        _ => Err(ChatErrorCode::InvalidRequest),
    }
}

/// The `{base_url}/chat/completions` endpoint for a base URL that may carry a
/// trailing slash.
pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// Maps a non-2xx status to the contract's error codes.
pub fn error_code_for_status(status: u16) -> ChatErrorCode {
    match status {
        401 | 403 => ChatErrorCode::Unauthorized,
        429 => ChatErrorCode::RateLimited,
        _ => ChatErrorCode::Provider,
    }
}

// ---------------------------------------------------------------------------
// Memory store

/// Cap on the number of memories in the local store.
pub const MAX_MEMORIES: usize = 200;

/// Cap on one memory's content, applied on upsert.
pub const MAX_CONTENT_CHARS: usize = 2000;

/// Cap on one memory's title, applied on upsert (longer titles are
/// truncated, never rejected).
pub const MAX_TITLE_CHARS: usize = 200;

/// Cap on one memory's topic key. A longer key rejects the whole call: the
/// model output is misbehaving and must not be saved silently.
pub const MAX_TOPIC_KEY_CHARS: usize = 120;

/// Maximum number of extraction operations accepted in one
/// `chat_memories_apply` call. More than that rejects the whole call.
pub const MAX_OPS_PER_CALL: usize = 64;

/// Maximum number of corrupt-file backups kept next to the memory file.
pub const MAX_BACKUPS: usize = 3;

/// Cap on one SSE body line, in bytes. A longer line means the provider is
/// not speaking SSE: the caller must fail the stream with a `provider`
/// error instead of buffering unboundedly.
pub const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;

/// One durable memory (spec S5). Serialized camelCase over IPC and into the
/// JSON file; `updated_at` is Unix epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub topic_key: String,
    pub title: String,
    pub content: String,
    pub updated_at: i64,
}

/// One memory-extraction operation, keyed by `topicKey`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum MemoryOp {
    Upsert {
        topic_key: String,
        title: String,
        content: String,
    },
    Delete {
        topic_key: String,
    },
}

/// Applies extraction operations to the store in order.
///
/// An upsert whose `topicKey` already exists updates that memory in place
/// (same id, never a duplicate); a new topic is appended unless the store is
/// already at [`MAX_MEMORIES`], in which case the op is dropped in place —
/// the cap never evicts existing memories. Content is truncated to
/// [`MAX_CONTENT_CHARS`] characters and titles to [`MAX_TITLE_CHARS`].
///
/// The whole call is rejected (`Err`) — leaving the caller to save nothing —
/// when there are more than [`MAX_OPS_PER_CALL`] ops or any topic key is
/// longer than [`MAX_TOPIC_KEY_CHARS`] characters. `now_ms` stamps updated
/// and new rows.
pub fn apply_memory_ops(
    mut memories: Vec<Memory>,
    ops: &[MemoryOp],
    mut new_id: impl FnMut() -> String,
    now_ms: i64,
) -> Result<Vec<Memory>, String> {
    if ops.len() > MAX_OPS_PER_CALL {
        return Err(format!(
            "the extraction sent {} operations but at most {MAX_OPS_PER_CALL} are allowed; nothing was saved",
            ops.len()
        ));
    }
    for op in ops {
        match op {
            MemoryOp::Upsert {
                topic_key,
                title,
                content,
            } => {
                let topic_key = topic_key.trim();
                if topic_key.is_empty() {
                    continue;
                }
                if topic_key.chars().count() > MAX_TOPIC_KEY_CHARS {
                    return Err(format!(
                        "a memory topic key is longer than {MAX_TOPIC_KEY_CHARS} characters; nothing was saved"
                    ));
                }
                let content = truncate_chars(content, MAX_CONTENT_CHARS);
                let title = truncate_chars(title, MAX_TITLE_CHARS);
                if let Some(existing) = memories
                    .iter_mut()
                    .find(|memory| memory.topic_key == topic_key)
                {
                    existing.title = title;
                    existing.content = content;
                    existing.updated_at = now_ms;
                } else if memories.len() < MAX_MEMORIES {
                    memories.push(Memory {
                        id: new_id(),
                        topic_key: topic_key.to_string(),
                        title,
                        content,
                        updated_at: now_ms,
                    });
                }
            }
            MemoryOp::Delete { topic_key } => {
                memories.retain(|memory| memory.topic_key != *topic_key);
            }
        }
    }
    Ok(memories)
}

/// A fresh random memory id (`mem-` + 24 hex chars). Falls back to a
/// time-derived id if the system randomness source fails, so a memory write
/// never panics the app.
pub fn new_memory_id() -> String {
    let mut bytes = [0u8; 12];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
            .to_le_bytes();
        bytes.copy_from_slice(&nanos[..12]);
    }
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("mem-{hex}")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

// ---------------------------------------------------------------------------
// Memory-file load classification and corrupt-file backups

/// What the caller of a memory-file load must do with the file.
#[derive(Debug, PartialEq)]
pub enum LoadDecision {
    /// No file (or nothing to load): start with an empty store.
    Empty,
    /// The file exists but its JSON is corrupt: the caller must move it
    /// aside (a timestamped backup) and start with an empty store.
    Corrupt,
    /// The file loaded fine.
    Loaded(Vec<Memory>),
    /// The file exists but cannot be read (permissions, sharing violation,
    /// invalid UTF-8). The caller must surface the error and refuse every
    /// write, so a transient read failure can never wipe the memories.
    Unreadable(String),
}

/// Classifies one attempt to read the memory file as text and parse it.
/// `NotFound` is an empty store; every other read error (including invalid
/// UTF-8, which `read_to_string` reports as `InvalidData`) is
/// [`LoadDecision::Unreadable`]; a successful read that fails to parse is
/// [`LoadDecision::Corrupt`].
pub fn classify_load(result: io::Result<String>) -> LoadDecision {
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => LoadDecision::Empty,
        Err(error) => LoadDecision::Unreadable(error.to_string()),
        Ok(text) => match serde_json::from_str::<Vec<Memory>>(&text) {
            Ok(memories) => LoadDecision::Loaded(memories),
            Err(_) => LoadDecision::Corrupt,
        },
    }
}

/// Prefix of the timestamped backups of a corrupt memory file.
pub const BACKUP_PREFIX: &str = "chat-memories.json.bak-";

/// A unique, chronologically sortable backup file name for one corrupt
/// memory file. Backups within the same millisecond differ by sequence
/// number, so a backup never overwrites an earlier one.
pub fn backup_file_name(now_ms: i64, seq: u32) -> String {
    format!("{BACKUP_PREFIX}{now_ms}-{seq:03}")
}

/// Which existing backup names to delete after one more backup was added,
/// keeping only the [`MAX_BACKUPS`] newest (the names sort
/// chronologically). Returns the names to remove, oldest first.
pub fn prune_backups(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    let keep_from = names.len().saturating_sub(MAX_BACKUPS);
    names.drain(..keep_from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(body: &str) -> Vec<StreamEvent> {
        let mut decoder = StreamDecoder::new();
        let mut events = Vec::new();
        for line in body.lines() {
            events.extend(decoder.feed(line));
        }
        events
    }

    fn chunk(delta: &str) -> String {
        format!(r#"data: {{"choices":[{{"delta":{delta},"index":0}}]}}"#)
    }

    #[test]
    fn reasoning_comes_first_then_content() {
        let body = format!(
            "{}\n\n{}\n\ndata: [DONE]\n",
            chunk(r#"{"role":"assistant","reasoning_content":"thinking"}"#),
            chunk(r#"{"content":"Hello"}"#)
        );
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::Reasoning,
                StreamEvent::Delta("Hello".into()),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn reasoning_is_emitted_once_across_chunks() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.feed(&chunk(r#"{"reasoning_content":"a"}"#)),
            vec![StreamEvent::Reasoning]
        );
        assert!(decoder.feed(&chunk(r#"{"reasoning_content":"b"}"#)).is_empty());
        assert!(decoder
            .feed(&chunk(r#"{"content":"x"}"#))
            .contains(&StreamEvent::Delta("x".into())));
    }

    #[test]
    fn done_terminates_the_stream() {
        assert_eq!(decode_all("data: [DONE]\n"), vec![StreamEvent::Done]);
        let mut decoder = StreamDecoder::new();
        let _ = decoder.feed("data: [DONE]");
        assert!(decoder.is_done());
    }

    #[test]
    fn empty_delta_yields_nothing() {
        let body = format!("{}\n\ndata: [DONE]\n", chunk("{}"));
        assert_eq!(decode_all(&body), vec![StreamEvent::Done]);
    }

    #[test]
    fn empty_content_string_yields_nothing() {
        let body = format!("{}\n\ndata: [DONE]\n", chunk(r#"{"content":""}"#));
        assert_eq!(decode_all(&body), vec![StreamEvent::Done]);
    }

    #[test]
    fn malformed_json_line_is_malformed() {
        let body = "data: {not json\n\ndata: [DONE]\n";
        assert_eq!(
            decode_all(body),
            vec![StreamEvent::Malformed, StreamEvent::Done]
        );
    }

    #[test]
    fn a_usage_only_chunk_without_choices_is_ignored() {
        // OpenAI-compatible providers may close with a usage chunk.
        let body = "data: {\"id\":\"x\",\"choices\":[],\"usage\":{\"total_tokens\":9}}\ndata: {\"id\":\"x\",\"usage\":{}}";
        assert_eq!(decode_all(body), Vec::<StreamEvent>::new());
    }

    #[test]
    fn an_error_object_in_the_stream_is_malformed() {
        let body = r#"data: {"error":{"message":"overloaded"}}"#;
        assert_eq!(decode_all(body), vec![StreamEvent::Malformed]);
    }

    #[test]
    fn comments_and_non_data_lines_are_ignored() {
        let body = ": keep-alive\n: 2026-01-01\nevent: ping\nid: 1\nretry: 500\n\n";
        assert_eq!(decode_all(body), Vec::<StreamEvent>::new());
    }

    #[test]
    fn reasoning_only_chunk_before_done() {
        // A stream that never answers (cancelled reasoning) still terminates.
        let body = format!("{}\ndata: [DONE]\n", chunk(r#"{"reasoning_content":"..."}"#));
        assert_eq!(
            decode_all(&body),
            vec![StreamEvent::Reasoning, StreamEvent::Done]
        );
    }

    // --- streamed tool calls (Ronda 3 R1, spec S1): recorded fixtures ---

    fn tool_chunk(entries: &str) -> String {
        format!(r#"data: {{"choices":[{{"delta":{{"tool_calls":[{entries}]}}}}]}}"#)
    }

    #[test]
    fn a_single_tool_call_is_emitted_complete_before_done() {
        let body = [
            tool_chunk(r#"{"index":0,"id":"call_1","type":"function","function":{"name":"create_task","arguments":""}}"#),
            tool_chunk(r#"{"index":0,"function":{"arguments":"{\"title\":\"Buy milk\"}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_1".into(),
                    name: "create_task".into(),
                    arguments: r#"{"title":"Buy milk"}"#.into(),
                }),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn arguments_split_across_chunks_are_concatenated() {
        let body = [
            tool_chunk(r#"{"index":0,"id":"call_a","function":{"name":"create_task","arguments":"{\"title\":"}}"#),
            tool_chunk(r#"{"index":0,"function":{"arguments":"\"Deep clean\", \"day\":"}}"#),
            tool_chunk(r#"{"index":0,"function":{"arguments":"\"2026-11-02\"}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_a".into(),
                    name: "create_task".into(),
                    arguments: r#"{"title":"Deep clean", "day":"2026-11-02"}"#.into(),
                }),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn two_calls_interleaved_emit_in_index_order_each_once() {
        let body = [
            tool_chunk(r#"{"index":0,"id":"call_0","function":{"name":"create_task","arguments":"{\"t"}}"#),
            tool_chunk(r#"{"index":1,"id":"call_1","function":{"name":"move_task","arguments":"{\"taskId\":"}}"#),
            tool_chunk(r#"{"index":0,"function":{"arguments":"itle\":\"A\"}"}}"#),
            tool_chunk(r#"{"index":1,"function":{"arguments":"\"t1\"}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_0".into(),
                    name: "create_task".into(),
                    arguments: r#"{"title":"A"}"#.into(),
                }),
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_1".into(),
                    name: "move_task".into(),
                    arguments: r#"{"taskId":"t1"}"#.into(),
                }),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn text_may_precede_calls_and_every_call_arrives_before_done() {
        let body = [
            chunk(r#"{"content":"Sure — proposing two changes."}"#),
            tool_chunk(r#"{"index":0,"id":"call_0","function":{"name":"create_task","arguments":"{}"}}"#),
            tool_chunk(r#"{"index":1,"id":"call_1","function":{"name":"move_task","arguments":"{}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::Delta("Sure — proposing two changes.".into()),
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_0".into(),
                    name: "create_task".into(),
                    arguments: "{}".into(),
                }),
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_1".into(),
                    name: "move_task".into(),
                    arguments: "{}".into(),
                }),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn a_call_without_a_name_is_malformed_not_a_ghost_call() {
        let body = [
            tool_chunk(r#"{"index":0,"id":"call_x","function":{"arguments":"{}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(decode_all(&body), vec![StreamEvent::Malformed, StreamEvent::Done]);
    }

    #[test]
    fn eof_without_done_still_flushes_the_pending_call() {
        let mut decoder = StreamDecoder::new();
        assert!(decoder
            .feed(&tool_chunk(r#"{"index":0,"id":"call_9","function":{"name":"move_task","arguments":"{}"}}"#))
            .is_empty());
        assert_eq!(
            decoder.flush_tool_calls(),
            vec![StreamEvent::ToolCall(ToolCallPayload {
                id: "call_9".into(),
                name: "move_task".into(),
                arguments: "{}".into(),
            })]
        );
    }

    #[test]
    fn a_gap_in_tool_call_indexes_is_malformed() {
        let body = [
            tool_chunk(r#"{"index":0,"id":"c0","function":{"name":"a","arguments":"{}"}}"#),
            tool_chunk(r#"{"index":2,"id":"c2","function":{"name":"b","arguments":"{}"}}"#),
        ]
        .join("\n\n");
        assert_eq!(decode_all(&body), vec![StreamEvent::Malformed]);
    }

    #[test]
    fn an_indexless_fragment_with_a_new_id_starts_a_new_call() {
        // A provider that never sends indexes but opens each call with its
        // own id: the second call must not concatenate into the first's name.
        let body = [
            tool_chunk(r#"{"id":"call_a","function":{"name":"create_task","arguments":"{}"}}"#),
            tool_chunk(r#"{"id":"call_b","function":{"name":"move_task","arguments":"{}"}}"#),
            "data: [DONE]".to_string(),
        ]
        .join("\n\n");
        assert_eq!(
            decode_all(&body),
            vec![
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_a".into(),
                    name: "create_task".into(),
                    arguments: "{}".into(),
                }),
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_b".into(),
                    name: "move_task".into(),
                    arguments: "{}".into(),
                }),
                StreamEvent::Done,
            ]
        );
    }

    #[test]
    fn fallback_ids_are_prefixed_with_the_request_id() {
        // A provider that omits ids entirely: the fallback handle must be
        // unique per request, so one Confirm can never resolve two cards.
        let mut decoder = StreamDecoder::new().with_request_id("r7");
        assert!(decoder
            .feed(&tool_chunk(r#"{"index":0,"function":{"name":"create_task","arguments":"{}"}}"#))
            .is_empty());
        assert!(decoder
            .feed(&tool_chunk(r#"{"index":1,"function":{"name":"move_task","arguments":"{}"}}"#))
            .is_empty());
        assert_eq!(
            decoder.flush_tool_calls(),
            vec![
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_r7_0".into(),
                    name: "create_task".into(),
                    arguments: "{}".into(),
                }),
                StreamEvent::ToolCall(ToolCallPayload {
                    id: "call_r7_1".into(),
                    name: "move_task".into(),
                    arguments: "{}".into(),
                }),
            ]
        );
    }

    #[test]
    fn tool_call_events_serialize_with_a_call_payload() {
        assert_eq!(
            serde_json::to_value(ChatEvent::ToolCall {
                call: ToolCallPayload {
                    id: "call_1".into(),
                    name: "create_task".into(),
                    arguments: "{}".into(),
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "tool_call",
                "call": {"id": "call_1", "name": "create_task", "arguments": "{}"},
            })
        );
    }

    #[test]
    fn https_base_urls_are_accepted() {
        assert_eq!(validate_base_url("https://api.nan.builders/v1"), Ok(()));
        assert_eq!(validate_base_url("  https://api.nan.builders/v1  "), Ok(()));
    }

    #[test]
    fn loopback_http_is_accepted() {
        assert_eq!(validate_base_url("http://localhost:1234/v1"), Ok(()));
        assert_eq!(validate_base_url("http://127.0.0.1/v1"), Ok(()));
    }

    #[test]
    fn plain_http_is_rejected() {
        assert_eq!(
            validate_base_url("http://evil.com/v1"),
            Err(ChatErrorCode::InvalidRequest)
        );
        assert_eq!(
            validate_base_url("http://localhost.evil.com"),
            Err(ChatErrorCode::InvalidRequest)
        );
        assert_eq!(
            validate_base_url("ftp://localhost"),
            Err(ChatErrorCode::InvalidRequest)
        );
        assert_eq!(
            validate_base_url("not a url"),
            Err(ChatErrorCode::InvalidRequest)
        );
        assert_eq!(
            validate_base_url(""),
            Err(ChatErrorCode::InvalidRequest)
        );
    }

    #[test]
    fn completions_url_appends_the_endpoint() {
        assert_eq!(
            chat_completions_url("https://api.nan.builders/v1"),
            "https://api.nan.builders/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.nan.builders/v1/"),
            "https://api.nan.builders/v1/chat/completions"
        );
    }

    #[test]
    fn status_codes_map_to_contract_codes() {
        assert_eq!(error_code_for_status(401), ChatErrorCode::Unauthorized);
        assert_eq!(error_code_for_status(403), ChatErrorCode::Unauthorized);
        assert_eq!(error_code_for_status(429), ChatErrorCode::RateLimited);
        assert_eq!(error_code_for_status(500), ChatErrorCode::Provider);
    }

    fn memory(id: &str, topic: &str) -> Memory {
        Memory {
            id: id.into(),
            topic_key: topic.into(),
            title: "Title".into(),
            content: "Content".into(),
            updated_at: 1,
        }
    }

    fn fixed_id() -> String {
        static COUNTER: std::sync::atomic::AtomicU32 =
            std::sync::atomic::AtomicU32::new(0);
        format!(
            "id-{}",
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    #[test]
    fn upsert_new_appends_a_memory() {
        let ops = [MemoryOp::Upsert {
            topic_key: "standup".into(),
            title: "Standup time".into(),
            content: "Standup is at 9:30.".into(),
        }];
        let memories = apply_memory_ops(Vec::new(), &ops, fixed_id, 10).unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].topic_key, "standup");
        assert_eq!(memories[0].updated_at, 10);
        assert!(memories[0].id.starts_with("id-"));
    }

    #[test]
    fn upsert_existing_keeps_the_id_and_updates_in_place() {
        let store = vec![memory("m1", "standup"), memory("m2", "other")];
        let ops = [MemoryOp::Upsert {
            topic_key: "standup".into(),
            title: "Moved".into(),
            content: "Standup moved to 10:00.".into(),
        }];
        let memories = apply_memory_ops(store, &ops, fixed_id, 20).unwrap();
        assert_eq!(memories.len(), 2);
        assert_eq!(memories[0].id, "m1");
        assert_eq!(memories[0].title, "Moved");
        assert_eq!(memories[0].content, "Standup moved to 10:00.");
        assert_eq!(memories[0].updated_at, 20);
    }

    #[test]
    fn delete_removes_by_topic_key() {
        let store = vec![memory("m1", "standup"), memory("m2", "other")];
        let ops = [MemoryOp::Delete {
            topic_key: "standup".into(),
        }];
        let memories = apply_memory_ops(store, &ops, fixed_id, 30).unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].topic_key, "other");
    }

    #[test]
    fn delete_of_an_unknown_topic_is_a_no_op() {
        let store = vec![memory("m1", "standup")];
        let ops = [MemoryOp::Delete {
            topic_key: "nope".into(),
        }];
        assert_eq!(apply_memory_ops(store, &ops, fixed_id, 40).unwrap().len(), 1);
    }

    #[test]
    fn content_is_truncated_to_the_cap() {
        let long = "x".repeat(MAX_CONTENT_CHARS + 100);
        let ops = [MemoryOp::Upsert {
            topic_key: "t".into(),
            title: "T".into(),
            content: long,
        }];
        let memories = apply_memory_ops(Vec::new(), &ops, fixed_id, 50).unwrap();
        assert_eq!(memories[0].content.chars().count(), MAX_CONTENT_CHARS);
    }

    #[test]
    fn memory_cap_drops_new_topics_but_keeps_updates() {
        let store: Vec<Memory> = (0..MAX_MEMORIES)
            .map(|i| memory(&format!("m{i}"), &format!("topic-{i}")))
            .collect();
        let ops = [
            MemoryOp::Upsert {
                topic_key: "topic-0".into(),
                title: "Updated".into(),
                content: "Updated content.".into(),
            },
            MemoryOp::Upsert {
                topic_key: "brand-new".into(),
                title: "New".into(),
                content: "New content.".into(),
            },
        ];
        let memories = apply_memory_ops(store, &ops, fixed_id, 60).unwrap();
        assert_eq!(memories.len(), MAX_MEMORIES);
        assert_eq!(memories[0].title, "Updated");
        assert!(memories.iter().all(|m| m.topic_key != "brand-new"));
    }

    #[test]
    fn empty_topic_key_upserts_are_ignored() {
        let ops = [MemoryOp::Upsert {
            topic_key: "   ".into(),
            title: "T".into(),
            content: "C".into(),
        }];
        assert!(apply_memory_ops(Vec::new(), &ops, fixed_id, 70).unwrap().is_empty());
    }

    // --- security fixes (chat-c1-sec review) ---

    #[test]
    fn api_keys_with_control_characters_are_rejected() {
        assert_eq!(validate_key("ok-key"), Ok(()));
        assert_eq!(validate_key("  padded key  "), Ok(()));
        assert_eq!(validate_key(""), Err(KeyProblem::Empty));
        assert_eq!(validate_key("   "), Err(KeyProblem::Empty));
        assert_eq!(validate_key(&"k".repeat(MAX_KEY_CHARS + 1)), Err(KeyProblem::TooLong));
        assert_eq!(validate_key(&"k".repeat(MAX_KEY_CHARS)), Ok(()));
        assert_eq!(validate_key("sk-abc\r\nX-Injected: 1"), Err(KeyProblem::ControlChars));
        assert_eq!(validate_key("sk-abc\nX"), Err(KeyProblem::ControlChars));
        assert_eq!(validate_key("sk-a\u{7f}c"), Err(KeyProblem::ControlChars));
    }

    #[test]
    fn userinfo_urls_are_rejected() {
        for url in [
            "https://user:pass@api.nan.builders/v1",
            "https://user@evil.com",
            "http://bob@localhost/v1",
        ] {
            assert_eq!(
                validate_base_url(url),
                Err(ChatErrorCode::InvalidRequest),
                "userinfo must be rejected: {url}"
            );
        }
        // Without userinfo the same hosts stay valid.
        assert_eq!(validate_base_url("https://api.nan.builders/v1"), Ok(()));
        assert_eq!(validate_base_url("http://localhost/v1"), Ok(()));
    }

    #[test]
    fn a_missing_memory_file_is_an_empty_store() {
        let decision = classify_load(Err(io::Error::from(io::ErrorKind::NotFound)));
        assert!(matches!(decision, LoadDecision::Empty));
    }

    #[test]
    fn any_other_read_error_is_unreadable_and_must_refuse_writes() {
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
            io::ErrorKind::InvalidData,
        ] {
            let decision = classify_load(Err(io::Error::from(kind)));
            assert!(
                matches!(decision, LoadDecision::Unreadable(_)),
                "non-NotFound error {kind:?} must be Unreadable"
            );
        }
    }

    #[test]
    fn non_utf8_memory_bytes_are_unreadable_so_an_apply_cannot_wipe_them() {
        // What `fs::read_to_string` returns for a file with invalid UTF-8.
        let bytes: Vec<u8> = vec![0xFF, 0xFE, b'{', 0x00];
        let result: io::Result<String> =
            String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        assert!(matches!(classify_load(result), LoadDecision::Unreadable(_)));
    }

    #[test]
    fn corrupt_memory_json_is_corrupt_and_valid_json_loads() {
        assert!(matches!(
            classify_load(Ok("not json at all".into())),
            LoadDecision::Corrupt
        ));
        let decision = classify_load(Ok(
            r#"[{"id":"m1","topicKey":"t","title":"T","content":"C","updatedAt":1}]"#.into(),
        ));
        assert!(matches!(decision, LoadDecision::Loaded(_)));
    }

    #[test]
    fn backup_names_are_timestamped_and_unique_within_a_millisecond() {
        let a = backup_file_name(1_700_000_000_000, 0);
        let b = backup_file_name(1_700_000_000_000, 1);
        let c = backup_file_name(1_700_000_000_001, 0);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("chat-memories.json.bak-"));
        // Timestamped names sort chronologically.
        assert!(a < c);
    }

    #[test]
    fn backup_pruning_keeps_only_the_newest_three() {
        let names: Vec<String> = (0..5)
            .map(|ms| backup_file_name(1_700_000_000_000 + ms, 0))
            .collect();
        let pruned = prune_backups(names.clone());
        // The three oldest go; the two newest stay.
        assert_eq!(pruned, names[0..2].to_vec());
        assert_eq!(prune_backups(names[..MAX_BACKUPS].to_vec()), Vec::<String>::new());
    }

    #[test]
    fn more_than_the_op_cap_rejects_the_whole_call() {
        let ops: Vec<MemoryOp> = (0..=MAX_OPS_PER_CALL)
            .map(|i| MemoryOp::Upsert {
                topic_key: format!("topic-{i}"),
                title: "T".into(),
                content: "C".into(),
            })
            .collect();
        let result = apply_memory_ops(Vec::new(), &ops, fixed_id, 80);
        assert!(result.is_err(), "65 ops must be rejected, not truncated");
        assert_eq!(
            apply_memory_ops(Vec::new(), &ops[..MAX_OPS_PER_CALL], fixed_id, 80).unwrap().len(),
            MAX_OPS_PER_CALL,
        );
    }

    #[test]
    fn over_long_topic_keys_reject_the_call_and_titles_are_capped() {
        let long_key = "k".repeat(MAX_TOPIC_KEY_CHARS + 1);
        let ops = [MemoryOp::Upsert {
            topic_key: long_key,
            title: "T".into(),
            content: "C".into(),
        }];
        assert!(apply_memory_ops(Vec::new(), &ops, fixed_id, 90).is_err());
        let long_title = "t".repeat(MAX_TITLE_CHARS + 50);
        let ops = [MemoryOp::Upsert {
            topic_key: "topic".into(),
            title: long_title,
            content: "C".into(),
        }];
        let memories = apply_memory_ops(Vec::new(), &ops, fixed_id, 95).unwrap();
        assert_eq!(memories[0].title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn memory_id_is_unique_and_prefixed() {
        let a = new_memory_id();
        let b = new_memory_id();
        assert_ne!(a, b);
        assert!(a.starts_with("mem-"));
        assert_eq!(a.len(), "mem-".len() + 24);
    }

    #[test]
    fn chat_events_serialize_with_type_tags() {
        assert_eq!(
            serde_json::to_value(ChatEvent::Reasoning).unwrap(),
            serde_json::json!({"type": "reasoning"})
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Delta { text: "Hi".into() }).unwrap(),
            serde_json::json!({"type": "delta", "text": "Hi"})
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Done).unwrap(),
            serde_json::json!({"type": "done"})
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Cancelled).unwrap(),
            serde_json::json!({"type": "cancelled"})
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Error {
                code: ChatErrorCode::NoKey,
                message: "m".into(),
            })
            .unwrap(),
            serde_json::json!({"type": "error", "code": "no_key", "message": "m"})
        );
    }

    #[test]
    fn memory_serializes_camel_case() {
        let value = serde_json::to_value(memory("m1", "standup")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": "m1", "topicKey": "standup", "title": "Title",
                "content": "Content", "updatedAt": 1,
            })
        );
    }

    #[test]
    fn memory_ops_deserialize_from_the_extraction_shape() {
        let ops: Vec<MemoryOp> = serde_json::from_str(
            r#"[
                {"op": "upsert", "topicKey": "t", "title": "T", "content": "C"},
                {"op": "delete", "topicKey": "t"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            ops,
            vec![
                MemoryOp::Upsert {
                    topic_key: "t".into(),
                    title: "T".into(),
                    content: "C".into(),
                },
                MemoryOp::Delete { topic_key: "t".into() },
            ]
        );
    }

    // --- provider wire shape (Ronda 3 R1) ---

    fn wire(role: &str, content: &str) -> WireMessage {
        WireMessage {
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    fn wire_call(id: &str, name: &str, arguments: &str) -> WireToolCall {
        WireToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }

    #[test]
    fn plain_messages_map_to_the_provider_shape() {
        assert_eq!(
            provider_body("m", &[wire("user", "hi"), wire("assistant", "hello")], None, true),
            serde_json::json!({
                "model": "m",
                "messages": [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "hello"},
                ],
                "stream": true,
            })
        );
    }

    #[test]
    fn a_follow_up_request_carries_the_openai_tool_call_wire_shape() {
        // The exact body of the request after a card was answered: the
        // assistant turn proposes its calls in the OpenAI shape ({id, type:
        // "function", function: {name, arguments}}) and each call is answered
        // by one `tool` message, in call order.
        let assistant = WireMessage {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: Some(vec![
                wire_call("call_1", "create_task", r#"{"title":"X"}"#),
                wire_call("call_2", "move_task", r#"{"taskId":"t1"}"#),
            ]),
            tool_call_id: None,
        };
        let tool = |id: &str, content: &str| WireMessage {
            role: "tool".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: Some(id.into()),
        };
        let body = provider_body(
            "deepseek-v4-flash",
            &[
                wire("user", "plan my errands"),
                assistant,
                tool("call_1", "The user confirmed and it was applied. Task created."),
                tool("call_2", "The user discarded this proposal. Nothing was changed."),
            ],
            Some(&vec![serde_json::json!({"type": "function", "function": {"name": "create_task"}})]),
            true,
        );
        assert_eq!(
            body,
            serde_json::json!({
                "model": "deepseek-v4-flash",
                "messages": [
                    {"role": "user", "content": "plan my errands"},
                    {
                        "role": "assistant",
                        "content": serde_json::Value::Null,
                        "tool_calls": [
                            {
                                "id": "call_1", "type": "function",
                                "function": {"name": "create_task", "arguments": r#"{"title":"X"}"#},
                            },
                            {
                                "id": "call_2", "type": "function",
                                "function": {"name": "move_task", "arguments": r#"{"taskId":"t1"}"#},
                            },
                        ],
                    },
                    {"role": "tool", "content": "The user confirmed and it was applied. Task created.", "tool_call_id": "call_1"},
                    {"role": "tool", "content": "The user discarded this proposal. Nothing was changed.", "tool_call_id": "call_2"},
                ],
                "stream": true,
                "tools": [{"type": "function", "function": {"name": "create_task"}}],
            })
        );
    }

    #[test]
    fn an_assistant_turn_with_text_and_calls_keeps_its_text() {
        let turn = WireMessage {
            role: "assistant".into(),
            content: "Here is my proposal.".into(),
            tool_calls: Some(vec![wire_call("c", "create_task", "{}")]),
            tool_call_id: None,
        };
        let body = provider_body("m", &[turn], None, false);
        assert_eq!(body["messages"][0]["content"], "Here is my proposal.");
    }

    #[test]
    fn tools_are_forwarded_verbatim_and_omitted_when_absent() {
        let tools = vec![serde_json::json!({"type": "function", "function": {"name": "create_task"}})];
        let body = provider_body("m", &[wire("user", "hi")], Some(&tools), true);
        assert_eq!(body["tools"], serde_json::json!(tools));
        let body = provider_body("m", &[wire("user", "hi")], None, true);
        assert!(body.get("tools").is_none(), "no tools key when absent");
    }

    #[test]
    fn wire_messages_deserialize_the_camel_case_ipc_shape() {
        let message: WireMessage = serde_json::from_str(
            r#"{"role": "assistant", "content": "", "toolCalls": [{"id": "c", "name": "create_task", "arguments": "{}"}], "toolCallId": null}"#,
        )
        .unwrap();
        assert_eq!(
            message.tool_calls,
            Some(vec![wire_call("c", "create_task", "{}")])
        );
        assert_eq!(message.tool_call_id, None);
    }
}

// ---------------------------------------------------------------------------
// Bounded SSE line reading

/// Why a line could not be read.
#[derive(Debug)]
pub enum LineError {
    /// A read error; timeouts surface here too and are retryable, because the
    /// partial line stays in the caller's buffer.
    Io(std::io::Error),
    /// The line grew past the cap: the provider is not speaking SSE. Fails
    /// the stream instead of buffering unboundedly.
    Overlong,
}

/// Reads one `\n`-terminated line (without the terminator) into a String.
/// `buf` holds the bytes of an unfinished line across calls, so a read
/// timeout mid-line loses nothing: call again with the same `buf`. Returns
/// `Ok(None)` at EOF once nothing is pending.
pub fn read_limited_line(
    reader: &mut impl std::io::BufRead,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<Option<String>, LineError> {
    loop {
        let available = reader.fill_buf().map_err(LineError::Io)?;
        if available.is_empty() {
            break; // EOF
        }
        match available.iter().position(|&byte| byte == b'\n') {
            Some(pos) => {
                buf.extend_from_slice(&available[..pos]);
                reader.consume(pos + 1);
                let line = String::from_utf8_lossy(buf).into_owned();
                buf.clear();
                return Ok(Some(line));
            }
            None => {
                buf.extend_from_slice(available);
                let len = available.len();
                reader.consume(len);
                if buf.len() > max {
                    return Err(LineError::Overlong);
                }
            }
        }
    }
    if buf.is_empty() {
        Ok(None)
    } else {
        let line = String::from_utf8_lossy(buf).into_owned();
        buf.clear();
        Ok(Some(line))
    }
}

#[cfg(test)]
mod line_reader_tests {
    use super::{read_limited_line, LineError};
    use std::collections::VecDeque;
    use std::io::{self, BufRead, BufReader, Read};

    /// A reader that replays scripted chunks and timeouts.
    struct Script(VecDeque<io::Result<&'static [u8]>>);

    impl Read for Script {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(Err(error)) => Err(error),
                Some(Ok(bytes)) => {
                    out[..bytes.len()].copy_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }
    }

    fn timeout() -> io::Result<&'static [u8]> {
        Err(io::Error::new(io::ErrorKind::TimedOut, "tick"))
    }

    fn reader(steps: Vec<io::Result<&'static [u8]>>) -> impl BufRead {
        BufReader::new(Script(steps.into()))
    }

    #[test]
    fn a_timeout_mid_line_keeps_the_partial_bytes() {
        let mut r = reader(vec![Ok(b"data: {\"a\""), timeout(), Ok(b":1}\nnext\n")]);
        let mut buf = Vec::new();
        assert!(matches!(read_limited_line(&mut r, &mut buf, 1024), Err(LineError::Io(_))));
        let line = read_limited_line(&mut r, &mut buf, 1024).unwrap();
        assert_eq!(line.as_deref(), Some("data: {\"a\":1}"));
        assert_eq!(read_limited_line(&mut r, &mut buf, 1024).unwrap().as_deref(), Some("next"));
        assert_eq!(read_limited_line(&mut r, &mut buf, 1024).unwrap(), None);
    }

    #[test]
    fn an_overlong_line_fails_instead_of_buffering() {
        let mut r = reader(vec![Ok(b"0123456789"), Ok(b"0123456789")]);
        let mut buf = Vec::new();
        assert!(matches!(read_limited_line(&mut r, &mut buf, 15), Err(LineError::Overlong)));
    }

    #[test]
    fn a_final_line_without_newline_is_returned_at_eof() {
        let mut r = reader(vec![Ok(b"data: [DONE]")]);
        let mut buf = Vec::new();
        assert_eq!(read_limited_line(&mut r, &mut buf, 64).unwrap().as_deref(), Some("data: [DONE]"));
        assert_eq!(read_limited_line(&mut r, &mut buf, 64).unwrap(), None);
    }
}

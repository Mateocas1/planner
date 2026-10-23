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

/// One event of a streamed reply, serialized with `"type"` tags.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    /// The model started reasoning; its text is not shown.
    Reasoning,
    /// A piece of the answer text.
    Delta { text: String },
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
    /// The stream ended (`data: [DONE]`).
    Done,
    /// A `data:` line that is neither `[DONE]` nor parseable stream JSON.
    Malformed,
}

/// Incremental decoder for the lines of one SSE reply body.
///
/// Feed it every body line (comments, empty lines and non-`data` fields are
/// ignored); collect the events it yields in order. `reasoning` is emitted
/// once per stream, on the first appearance of `delta.reasoning_content`;
/// chunks with an empty `delta` produce nothing; a `data:` line that does not
/// parse as a chunk is [`StreamEvent::Malformed`] and the caller must treat
/// the stream as failed.
#[derive(Debug, Default)]
pub struct StreamDecoder {
    reasoning_emitted: bool,
    done: bool,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `[DONE]` was seen; the caller can then stop reading.
    pub fn is_done(&self) -> bool {
        self.done
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
            return vec![StreamEvent::Done];
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
}

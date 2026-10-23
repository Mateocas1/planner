//! Pure half of the Engram write-through memory mirror (task R2 of
//! `odd/tasks/ronda3.md`, spec S2). The Tauri glue (settings file, ureq
//! transport, commands, background mirror threads) lives in
//! `../../src/chat/engram.rs`.
//!
//! The local Rust-owned memory store stays the source of truth (offline
//! first, parent decision L2); Engram is an optional mirror only. Everything
//! here is platform-independent and unit-tested on Linux: settings and their
//! validation, the memory → Engram-observation payload mapping, the
//! observation lookup by topic key, and the mirror/sync client logic over an
//! injected [`EngramTransport`] (the ureq implementation is a thin shell in
//! the `planner` crate).
//!
//! Engram HTTP routes relied on (Engram v3.4.1, `engram serve`):
//! - `POST /sessions` — `{id, project}`; idempotent for a live session id,
//!   `201` both times. Every later call validates that the observation's
//!   session belongs to the requested project, so the mirror owns one fixed
//!   session id ([`ENGRAM_SESSION_ID`]).
//! - `POST /observations` — `{session_id, project, scope, type, title,
//!   content, topic_key, capture_prompt}` → `201 {id, status:"saved"}`.
//!   Same project + scope + `topic_key` upserts the same observation row
//!   (same id), so mirroring the same memory twice never duplicates it.
//! - `GET /observations/recent?project=X&limit=N` — array of observations
//!   with `id` and `topic_key`; used to find the row a delete must remove.
//! - `DELETE /observations/{id}?expected_project=X` — `200` deleted,
//!   `404` already gone (both treated as success by [`mirror_delete`]).

use serde::{Deserialize, Serialize};

use crate::chat::Memory;

// ---------------------------------------------------------------------------
// Settings

/// Default Engram address (spec S2): the local `engram serve` port.
pub const DEFAULT_ENGRAM_ADDRESS: &str = "http://127.0.0.1:7437";

/// Default Engram project the mirror writes into.
pub const DEFAULT_ENGRAM_PROJECT: &str = "calendar-assistant";

/// The one session the mirror owns inside the Engram project. Engram
/// validates `session_id` → `project` ownership on every observation write,
/// so the mirror registers this session once per process (idempotent) and
/// names it on every upsert.
pub const ENGRAM_SESSION_ID: &str = "calendar-app-mirror";

/// Longest accepted Engram project name, in characters.
pub const MAX_ENGRAM_PROJECT_CHARS: usize = 120;

/// The persisted Engram mirror settings (spec S2): on/off, address, project.
/// Stored by Rust next to the memory file; the webview reaches it only
/// through the settings commands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngramSettings {
    /// Whether every applied memory op is mirrored. Off by default.
    pub enabled: bool,
    /// Base address of the local Engram server.
    pub address: String,
    /// Engram project the mirror writes into.
    pub project: String,
}

impl Default for EngramSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            address: DEFAULT_ENGRAM_ADDRESS.to_string(),
            project: DEFAULT_ENGRAM_PROJECT.to_string(),
        }
    }
}

impl EngramSettings {
    /// Trims the address and project; an empty project falls back to the
    /// default so a save of blank fields can never break the mirror.
    pub fn normalized(&self) -> Self {
        let project = self.project.trim();
        Self {
            enabled: self.enabled,
            address: self.address.trim().to_string(),
            project: if project.is_empty() {
                DEFAULT_ENGRAM_PROJECT.to_string()
            } else {
                project.to_string()
            },
        }
    }
}

/// Why a settings save was rejected before anything was persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngramProblem {
    /// Empty or whitespace-only address.
    AddressEmpty,
    /// The address is not `https://`, nor `http://` on the loopback hosts.
    AddressDisallowed,
    /// Empty or whitespace-only project name.
    ProjectEmpty,
    /// More than [`MAX_ENGRAM_PROJECT_CHARS`] characters.
    ProjectTooLong,
    /// Control characters in the project name.
    ProjectControlChars,
}

impl std::fmt::Display for EngramProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            EngramProblem::AddressEmpty => "The Engram address must not be empty.",
            EngramProblem::AddressDisallowed => {
                "The Engram address must be https://, or http:// on this computer (localhost)."
            }
            EngramProblem::ProjectEmpty => "The Engram project must not be empty.",
            EngramProblem::ProjectTooLong => {
                "The Engram project name is too long."
            }
            EngramProblem::ProjectControlChars => {
                "The Engram project name must not contain control characters."
            }
        };
        f.write_str(text)
    }
}

/// Validates an Engram address with the same rules as the chat provider base
/// URL (`core::chat::validate_base_url`): `https://` anywhere, `http://` only
/// on the loopback hosts (the mirror is a local service), never userinfo —
/// credentials inside the URL would be sent to the host and echoed in
/// errors.
pub fn validate_engram_address(address: &str) -> Result<(), EngramProblem> {
    let address = address.trim();
    if address.is_empty() {
        return Err(EngramProblem::AddressEmpty);
    }
    let Ok(url) = url::Url::parse(address) else {
        return Err(EngramProblem::AddressDisallowed);
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(EngramProblem::AddressDisallowed);
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) => Ok(()),
        _ => Err(EngramProblem::AddressDisallowed),
    }
}

/// Validates an Engram project name before it is stored.
pub fn validate_engram_project(project: &str) -> Result<(), EngramProblem> {
    let project = project.trim();
    if project.is_empty() {
        return Err(EngramProblem::ProjectEmpty);
    }
    if project.chars().count() > MAX_ENGRAM_PROJECT_CHARS {
        return Err(EngramProblem::ProjectTooLong);
    }
    if project.chars().any(char::is_control) {
        return Err(EngramProblem::ProjectControlChars);
    }
    Ok(())
}

/// Validates both fields of a settings save.
pub fn validate_engram_settings(settings: &EngramSettings) -> Result<EngramSettings, EngramProblem> {
    let settings = settings.normalized();
    validate_engram_address(&settings.address)?;
    validate_engram_project(&settings.project)?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Memory → Engram observation mapping

/// The observation type the mirror writes. Engram treats the type as a free
/// label; `note` keeps the assistant's memories out of the coding-agent
/// type vocabulary (`bugfix`, `decision`, …) used by Pi and friends.
pub const ENGRAM_MEMORY_TYPE: &str = "note";

/// The observation scope. `project` scopes the memories to the configured
/// Engram project, so the assistant's notes never leak into other scopes.
pub const ENGRAM_MEMORY_SCOPE: &str = "project";

/// How many recent observations a delete lookup fetches. The local store
/// caps memories at [`crate::chat::MAX_MEMORIES`], so 200 recent rows always
/// cover every topic the mirror could have written.
pub const RECENT_LOOKUP_LIMIT: usize = 200;

/// The `POST /sessions` body that registers the mirror's session.
pub fn session_body(settings: &EngramSettings) -> String {
    serde_json::json!({
        "id": ENGRAM_SESSION_ID,
        "project": settings.project,
    })
    .to_string()
}

/// The `POST /observations` body for one memory upsert. The memory's
/// `topicKey` rides as `topic_key`, so the same topic updates the same
/// observation (never a duplicate); `capture_prompt: false` keeps Engram
/// from recording anything besides the memory itself.
pub fn upsert_body(settings: &EngramSettings, memory: &Memory) -> String {
    serde_json::json!({
        "session_id": ENGRAM_SESSION_ID,
        "project": settings.project,
        "scope": ENGRAM_MEMORY_SCOPE,
        "type": ENGRAM_MEMORY_TYPE,
        "title": memory.title,
        "content": memory.content,
        "topic_key": memory.topic_key,
        "capture_prompt": false,
    })
    .to_string()
}

/// `{base}/{path}` for an address that may carry a trailing slash.
pub fn engram_url(address: &str, path: &str) -> String {
    format!("{}/{}", address.trim_end_matches('/'), path.trim_start_matches('/'))
}

// ---------------------------------------------------------------------------
// Transport

/// One outbound HTTP request to Engram, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngramRequest {
    pub method: &'static str,
    pub url: String,
    /// JSON body, present for POSTs.
    pub json_body: Option<String>,
}

/// One Engram reply: status plus body, so the client logic (not the
/// transport) decides what a status means and stays testable with a fake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngramResponse {
    pub status: u16,
    pub body: String,
}

/// The outbound HTTP surface. The `planner` crate implements it with `ureq`
/// (short timeouts); tests inject a scripted fake.
pub trait EngramTransport {
    /// Transport-level failure (unreachable, DNS, TLS, timeout) is an `Err`;
    /// any HTTP reply — including 4xx/5xx — is an `Ok` response.
    fn call(&self, request: EngramRequest) -> Result<EngramResponse, String>;
}

// ---------------------------------------------------------------------------
// Client logic

/// One "Sync now" outcome: how many remote observations were upserted and
/// how many stale ones deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SyncReport {
    pub upserted: usize,
    pub deleted: usize,
}

/// Health probe (`GET /health`, status 200 = reachable).
pub fn check_health(transport: &impl EngramTransport, address: &str) -> Result<(), String> {
    let response = transport
        .call(EngramRequest {
            method: "GET",
            url: engram_url(address, "health"),
            json_body: None,
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    if response.status == 200 {
        Ok(())
    } else {
        Err(format!("Engram answered HTTP {} on /health.", response.status))
    }
}

/// Registers the mirror's session in the project (idempotent: Engram
/// answers `201` for a session that already exists).
fn ensure_session(transport: &impl EngramTransport, settings: &EngramSettings) -> Result<(), String> {
    let response = transport
        .call(EngramRequest {
            method: "POST",
            url: engram_url(&settings.address, "sessions"),
            json_body: Some(session_body(settings)),
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(format!(
            "Engram refused the mirror session (HTTP {}).",
            response.status
        ))
    }
}

/// Mirrors one memory upsert. `Ok` carries the remote observation id.
pub fn mirror_upsert(
    transport: &impl EngramTransport,
    settings: &EngramSettings,
    memory: &Memory,
) -> Result<i64, String> {
    ensure_session(transport, settings)?;
    post_observation(transport, settings, memory)
}

/// Posts one observation upsert (session already ensured).
fn post_observation(
    transport: &impl EngramTransport,
    settings: &EngramSettings,
    memory: &Memory,
) -> Result<i64, String> {
    let response = transport
        .call(EngramRequest {
            method: "POST",
            url: engram_url(&settings.address, "observations"),
            json_body: Some(upsert_body(settings, memory)),
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    if response.status != 201 && response.status != 200 {
        return Err(format!(
            "Engram refused the memory upsert (HTTP {}).",
            response.status
        ));
    }
    serde_json::from_str::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|value| value.get("id").and_then(|id| id.as_i64()))
        .ok_or_else(|| "Engram's upsert reply had no observation id.".to_string())
}

/// Finds the remote observation id carrying this topic key in one
/// `GET /observations/recent` reply body. Unknown or malformed bodies are
/// `Ok(None)` — the caller must treat "cannot see it" as "leave it alone",
/// never as permission to skip the delete silently... it returns `Ok(None)`
/// and [`mirror_delete`] reports `false` so callers can log the doubt.
pub fn remote_topic_id(recent_json: &str, topic_key: &str) -> Option<i64> {
    let observations = serde_json::from_str::<serde_json::Value>(recent_json).ok()?;
    let observations = observations.as_array()?;
    observations
        .iter()
        .find(|observation| {
            observation.get("topic_key").and_then(|key| key.as_str()) == Some(topic_key)
        })
        .and_then(|observation| observation.get("id").and_then(|id| id.as_i64()))
}

/// Mirrors one memory delete by topic key: finds the remote row through the
/// recent-observations list, then deletes it. A `404` (already gone) is
/// success — idempotent. `Ok(false)` means nothing was found to delete (the
/// mirror never wrote it, or it was already removed); the local delete still
/// stands either way.
pub fn mirror_delete(
    transport: &impl EngramTransport,
    settings: &EngramSettings,
    topic_key: &str,
) -> Result<bool, String> {
    let recent = transport
        .call(EngramRequest {
            method: "GET",
            url: engram_url(
                &settings.address,
                &format!(
                    "observations/recent?project={}&limit={RECENT_LOOKUP_LIMIT}",
                    urlencode(&settings.project)
                ),
            ),
            json_body: None,
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    if recent.status != 200 {
        return Err(format!(
            "Engram refused the memory lookup (HTTP {}).",
            recent.status
        ));
    }
    let Some(id) = remote_topic_id(&recent.body, topic_key) else {
        return Ok(false);
    };
    let response = transport
        .call(EngramRequest {
            method: "DELETE",
            url: engram_url(
                &settings.address,
                &format!(
                    "observations/{id}?expected_project={}",
                    urlencode(&settings.project)
                ),
            ),
            json_body: None,
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    match response.status {
        200 | 404 => Ok(true),
        _ => Err(format!(
            "Engram refused the memory delete (HTTP {}).",
            response.status
        )),
    }
}

/// Percent-encodes a query-string value (`project`) without pulling in a
/// URL-encoding crate: project names are short identifiers; everything
/// outside the unreserved characters is escaped byte by byte.
fn urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// "Sync now": pushes every local memory and removes every mirrored topic
/// the local store no longer has, so after it returns the remote project
/// holds exactly the local store. Idempotent: running it again with no local
/// changes performs the same upserts (same topic keys → same rows, no
/// duplicates) and finds nothing stale to delete.
pub fn sync_all(
    transport: &impl EngramTransport,
    settings: &EngramSettings,
    memories: &[Memory],
) -> Result<SyncReport, String> {
    ensure_session(transport, settings)?;
    let recent = transport
        .call(EngramRequest {
            method: "GET",
            url: engram_url(
                &settings.address,
                &format!(
                    "observations/recent?project={}&limit={RECENT_LOOKUP_LIMIT}",
                    urlencode(&settings.project)
                ),
            ),
            json_body: None,
        })
        .map_err(|error| format!("Engram unreachable: {error}"))?;
    if recent.status != 200 {
        return Err(format!(
            "Engram refused the memory lookup (HTTP {}).",
            recent.status
        ));
    }
    let mut report = SyncReport::default();
    let mut local_topics: Vec<&str> = Vec::with_capacity(memories.len());
    for memory in memories {
        post_observation(transport, settings, memory)?;
        local_topics.push(memory.topic_key.as_str());
        report.upserted += 1;
    }
    let remote = serde_json::from_str::<serde_json::Value>(&recent.body)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    for observation in remote {
        let Some(topic) = observation.get("topic_key").and_then(|key| key.as_str()) else {
            continue;
        };
        if local_topics.contains(&topic) {
            continue;
        }
        let Some(id) = observation.get("id").and_then(|id| id.as_i64()) else {
            continue;
        };
        let response = transport
            .call(EngramRequest {
                method: "DELETE",
                url: engram_url(
                    &settings.address,
                    &format!("observations/{id}?expected_project={}", urlencode(&settings.project)),
                ),
                json_body: None,
            })
            .map_err(|error| format!("Engram unreachable: {error}"))?;
        match response.status {
            200 | 404 => report.deleted += 1,
            _ => {
                return Err(format!(
                    "Engram refused a stale-memory delete (HTTP {}).",
                    response.status
                ))
            }
        }
    }
    Ok(report)
}

/// The persisted mirror status (spec S2: `engram_status` — last result or
/// error). Stored next to the settings; `engram_status` returns the latest
/// attempt of any mirror write or "Sync now".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngramMirrorStatus {
    /// Unix epoch milliseconds of the last attempt.
    pub last_attempt_at: i64,
    /// Whether the last attempt fully succeeded.
    pub ok: bool,
    /// How many memories the successful attempt touched (upserts + deletes).
    pub synced: usize,
    /// The last failure's message, when [`EngramMirrorStatus::ok`] is false.
    pub error: Option<String>,
}

impl Default for EngramMirrorStatus {
    fn default() -> Self {
        Self {
            last_attempt_at: 0,
            ok: false,
            synced: 0,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(topic: &str) -> Memory {
        Memory {
            id: "m1".into(),
            topic_key: topic.into(),
            title: "Title".into(),
            content: "Content".into(),
            updated_at: 1,
        }
    }

    fn settings() -> EngramSettings {
        EngramSettings {
            enabled: true,
            address: DEFAULT_ENGRAM_ADDRESS.into(),
            project: "proj".into(),
        }
    }

    // --- settings ---

    #[test]
    fn settings_default_is_disabled_with_the_spec_defaults() {
        let settings = EngramSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.address, "http://127.0.0.1:7437");
        assert_eq!(settings.project, "calendar-assistant");
    }

    #[test]
    fn settings_serialize_camel_case() {
        let value = serde_json::to_value(settings()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"enabled": true, "address": "http://127.0.0.1:7437", "project": "proj"})
        );
        let round: EngramSettings = serde_json::from_value(value).unwrap();
        assert_eq!(round, settings());
    }

    #[test]
    fn settings_normalize_trims_and_keeps_a_blank_project_from_breaking() {
        let normalized = EngramSettings {
            enabled: true,
            address: " http://127.0.0.1:7437 ".into(),
            project: "  ".into(),
        }
        .normalized();
        assert_eq!(normalized.address, "http://127.0.0.1:7437");
        assert_eq!(normalized.project, DEFAULT_ENGRAM_PROJECT);
    }

    #[test]
    fn engram_addresses_follow_the_provider_rules() {
        assert_eq!(validate_engram_address("http://127.0.0.1:7437"), Ok(()));
        assert_eq!(validate_engram_address("http://localhost:7437"), Ok(()));
        assert_eq!(validate_engram_address("https://engram.example.com"), Ok(()));
        assert_eq!(validate_engram_address("  http://127.0.0.1:7437  "), Ok(()));
        assert_eq!(
            validate_engram_address(""),
            Err(EngramProblem::AddressEmpty)
        );
        assert_eq!(
            validate_engram_address("http://evil.com"),
            Err(EngramProblem::AddressDisallowed)
        );
        assert_eq!(
            validate_engram_address("http://localhost.evil.com"),
            Err(EngramProblem::AddressDisallowed)
        );
        assert_eq!(
            validate_engram_address("https://user:pass@127.0.0.1:7437"),
            Err(EngramProblem::AddressDisallowed)
        );
        assert_eq!(
            validate_engram_address("not a url"),
            Err(EngramProblem::AddressDisallowed)
        );
    }

    #[test]
    fn engram_projects_are_validated() {
        assert_eq!(validate_engram_project("calendar-assistant"), Ok(()));
        assert_eq!(validate_engram_project("  padded  "), Ok(()));
        assert_eq!(validate_engram_project(""), Err(EngramProblem::ProjectEmpty));
        assert_eq!(
            validate_engram_project("   "),
            Err(EngramProblem::ProjectEmpty)
        );
        assert_eq!(
            validate_engram_project(&"p".repeat(MAX_ENGRAM_PROJECT_CHARS + 1)),
            Err(EngramProblem::ProjectTooLong)
        );
        assert_eq!(
            validate_engram_project("proj\nX"),
            Err(EngramProblem::ProjectControlChars)
        );
    }

    #[test]
    fn validate_settings_normalizes_then_validates() {
        let mut settings = settings();
        settings.project = " ".repeat(MAX_ENGRAM_PROJECT_CHARS + 5);
        // A blank project normalizes to the default, which is valid.
        assert_eq!(
            validate_engram_settings(&settings).unwrap().project,
            DEFAULT_ENGRAM_PROJECT
        );
        settings.project = "bad\nname".to_string();
        assert!(validate_engram_settings(&settings).is_err());
    }

    // --- mapping ---

    #[test]
    fn session_body_names_the_mirror_session_and_project() {
        let body: serde_json::Value = serde_json::from_str(&session_body(&settings())).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"id": ENGRAM_SESSION_ID, "project": "proj"})
        );
    }

    #[test]
    fn upsert_body_maps_the_memory_with_topic_key_and_no_prompt_capture() {
        let body: serde_json::Value =
            serde_json::from_str(&upsert_body(&settings(), &memory("style/short"))).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "session_id": ENGRAM_SESSION_ID,
                "project": "proj",
                "scope": "project",
                "type": "note",
                "title": "Title",
                "content": "Content",
                "topic_key": "style/short",
                "capture_prompt": false,
            })
        );
    }

    #[test]
    fn engram_url_joins_the_base_and_path() {
        assert_eq!(
            engram_url("http://127.0.0.1:7437", "health"),
            "http://127.0.0.1:7437/health"
        );
        assert_eq!(
            engram_url("http://127.0.0.1:7437/", "health"),
            "http://127.0.0.1:7437/health"
        );
    }

    #[test]
    fn urlencode_escapes_unreserved_only() {
        assert_eq!(urlencode("calendar-assistant"), "calendar-assistant");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("cañón"), "ca%C3%B1%C3%B3n");
    }

    // --- remote lookup ---

    #[test]
    fn remote_topic_id_finds_the_matching_observation() {
        let recent = r#"[
            {"id": 7, "topic_key": "other/topic", "title": "x"},
            {"id": 4157, "topic_key": "style/short", "title": "y"}
        ]"#;
        assert_eq!(remote_topic_id(recent, "style/short"), Some(4157));
        assert_eq!(remote_topic_id(recent, "nope"), None);
    }

    #[test]
    fn remote_topic_id_treats_malformed_bodies_as_not_found() {
        assert_eq!(remote_topic_id("not json", "t"), None);
        assert_eq!(remote_topic_id("{}", "t"), None);
        assert_eq!(remote_topic_id("[]", "t"), None);
    }

    // --- client over a fake transport ---

    /// A scripted transport: replays prepared replies and records requests.
    struct Fake {
        replies: std::sync::Mutex<Vec<Result<EngramResponse, String>>>,
        requests: std::sync::Mutex<Vec<EngramRequest>>,
    }

    impl Fake {
        fn new(replies: Vec<Result<EngramResponse, String>>) -> Self {
            Self {
                replies: std::sync::Mutex::new(replies),
                requests: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn ok(status: u16, body: &str) -> Result<EngramResponse, String> {
            Ok(EngramResponse {
                status,
                body: body.into(),
            })
        }

        fn requests(&self) -> Vec<EngramRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl EngramTransport for Fake {
        fn call(&self, request: EngramRequest) -> Result<EngramResponse, String> {
            self.requests.lock().unwrap().push(request);
            self.replies
                .lock()
                .unwrap()
                .remove(0)
        }
    }

    #[test]
    fn health_checks_get_health_and_expect_200() {
        let fake = Fake::new(vec![Fake::ok(200, r#"{"status":"ok"}"#)]);
        assert_eq!(check_health(&fake, "http://127.0.0.1:7437"), Ok(()));
        let requests = fake.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url, "http://127.0.0.1:7437/health");
        assert_eq!(requests[0].method, "GET");

        let fake = Fake::new(vec![Fake::ok(503, "down")]);
        assert!(check_health(&fake, "http://127.0.0.1:7437").is_err());

        let fake = Fake::new(vec![Err("connection refused".into())]);
        assert_eq!(
            check_health(&fake, "http://127.0.0.1:7437"),
            Err("Engram unreachable: connection refused".to_string())
        );
    }

    #[test]
    fn mirror_upsert_ensures_the_session_then_posts_the_observation() {
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s","status":"created"}"#),
            Fake::ok(201, r#"{"id":99,"status":"saved"}"#),
        ]);
        assert_eq!(mirror_upsert(&fake, &settings(), &memory("t")), Ok(99));
        let requests = fake.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].url, "http://127.0.0.1:7437/sessions");
        assert_eq!(requests[1].url, "http://127.0.0.1:7437/observations");
        let body: serde_json::Value =
            serde_json::from_str(requests[1].json_body.as_deref().unwrap()).unwrap();
        assert_eq!(body["topic_key"], "t");
        assert_eq!(body["capture_prompt"], false);
    }

    #[test]
    fn mirror_upsert_reports_a_server_refusal_without_panicking() {
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{}"#),
            Fake::ok(400, r#"{"error":"no title"}"#),
        ]);
        assert!(mirror_upsert(&fake, &settings(), &memory("t")).is_err());
        // A transport failure (Engram down) is an error too.
        let fake = Fake::new(vec![Err("connection refused".into())]);
        assert!(mirror_upsert(&fake, &settings(), &memory("t")).is_err());
    }

    #[test]
    fn mirror_delete_looks_the_topic_up_then_deletes_by_id() {
        let fake = Fake::new(vec![
            Fake::ok(200, r#"[{"id":4157,"topic_key":"t"}]"#),
            Fake::ok(200, r#"{"status":"deleted"}"#),
        ]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(true));
        let requests = fake.requests();
        assert_eq!(
            requests[0].url,
            "http://127.0.0.1:7437/observations/recent?project=proj&limit=200"
        );
        assert_eq!(
            requests[1].url,
            "http://127.0.0.1:7437/observations/4157?expected_project=proj"
        );
        assert_eq!(requests[1].method, "DELETE");
    }

    #[test]
    fn mirror_delete_is_idempotent_for_an_unknown_topic() {
        let fake = Fake::new(vec![Fake::ok(200, "[]")]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(false));
        assert_eq!(fake.requests().len(), 1, "no delete call without a row");
    }

    #[test]
    fn mirror_delete_treats_a_404_as_success_and_a_409_as_failure() {
        let fake = Fake::new(vec![
            Fake::ok(200, r#"[{"id":1,"topic_key":"t"}]"#),
            Fake::ok(404, r#"{"error":"not found"}"#),
        ]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(true));
        let fake = Fake::new(vec![
            Fake::ok(200, r#"[{"id":1,"topic_key":"t"}]"#),
            Fake::ok(409, r#"{"error":"mismatch"}"#),
        ]);
        assert!(mirror_delete(&fake, &settings(), "t").is_err());
    }

    #[test]
    fn sync_all_upserts_every_local_memory_and_deletes_stale_topics() {
        let memories = vec![memory("keep/1"), memory("keep/2")];
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s"}"#),                       // session
            Fake::ok(200, r#"[{"id":10,"topic_key":"stale"},{"id":11,"topic_key":"keep/1"}]"#), // recent
            Fake::ok(201, r#"{"id":100}"#),                       // upsert keep/1
            Fake::ok(201, r#"{"id":101}"#),                       // upsert keep/2
            Fake::ok(200, r#"{"status":"deleted"}"#),             // delete stale 10
        ]);
        let report = sync_all(&fake, &settings(), &memories).unwrap();
        assert_eq!(report, SyncReport { upserted: 2, deleted: 1 });
        let requests = fake.requests();
        assert_eq!(requests.len(), 5);
        // `keep/1` was upserted, not deleted, despite existing remotely.
        assert!(requests[2].json_body.as_deref().unwrap().contains("keep/1"));
        assert_eq!(requests[4].url, "http://127.0.0.1:7437/observations/10?expected_project=proj");
    }

    #[test]
    fn sync_all_twice_makes_no_changes_the_second_time() {
        // Same remote list as the first sync's result would produce: the
        // plan for an already-converged mirror performs upserts (same
        // topics, same rows) and deletes nothing.
        let memories = vec![memory("keep/1")];
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s"}"#),
            Fake::ok(200, r#"[{"id":11,"topic_key":"keep/1"}]"#),
            Fake::ok(201, r#"{"id":11}"#),
        ]);
        let report = sync_all(&fake, &settings(), &memories).unwrap();
        assert_eq!(report, SyncReport { upserted: 1, deleted: 0 });
        assert_eq!(fake.requests().len(), 3);
    }

    #[test]
    fn sync_all_fails_closed_when_the_lookup_or_a_delete_is_refused() {
        let memories = vec![memory("t")];
        let fake = Fake::new(vec![Fake::ok(201, r#"{}"#), Fake::ok(500, "boom")]);
        assert!(sync_all(&fake, &settings(), &memories).is_err());
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{}"#),
            Fake::ok(200, r#"[{"id":5,"topic_key":"stale"}]"#),
            Fake::ok(201, r#"{"id":6}"#),
            Fake::ok(409, r#"{"error":"mismatch"}"#),
        ]);
        assert!(sync_all(&fake, &settings(), &memories).is_err());
    }

    #[test]
    fn sync_all_with_no_memories_only_deletes_everything_remote() {
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{}"#),
            Fake::ok(200, r#"[{"id":1,"topic_key":"a"},{"id":2,"topic_key":"b"}]"#),
            Fake::ok(200, r#"{}"#),
            Fake::ok(200, r#"{}"#),
        ]);
        let report = sync_all(&fake, &settings(), &[]).unwrap();
        assert_eq!(report, SyncReport { upserted: 0, deleted: 2 });
    }

    #[test]
    fn mirror_status_serializes_camel_case() {
        let status = EngramMirrorStatus {
            last_attempt_at: 5,
            ok: false,
            synced: 0,
            error: Some("down".into()),
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"lastAttemptAt": 5, "ok": false, "synced": 0, "error": "down"})
        );
        let round: EngramMirrorStatus = serde_json::from_value(value).unwrap();
        assert_eq!(round, status);
    }
}

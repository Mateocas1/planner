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
/// names it on every upsert. Deletes and stale-cleanup additionally require
/// a candidate row to carry this session: the project may hold observations
/// from other writers, and the mirror only ever touches its own.
pub const ENGRAM_SESSION_ID: &str = "calendar-app-mirror";

/// Every topic key the mirror writes to Engram is prefixed with this
/// namespace, so the project's rows from other writers (no prefix) and from
/// other sessions (foreign `session_id`) can never be matched by the
/// mirror's deletes or stale cleanup. The prefix is stripped before
/// comparing with the local store's unprefixed topic keys.
pub const MIRROR_TOPIC_PREFIX: &str = "calendar-app/";

/// The Engram topic key for one local memory topic key.
pub fn mirror_topic_key(topic_key: &str) -> String {
    format!("{MIRROR_TOPIC_PREFIX}{topic_key}")
}

/// The local topic key behind an Engram topic key, when it carries the
/// mirror's namespace prefix.
pub fn strip_mirror_prefix(topic_key: &str) -> Option<&str> {
    topic_key.strip_prefix(MIRROR_TOPIC_PREFIX)
}

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
    /// The address is not a loopback host (`127.0.0.1`, `localhost` or
    /// `[::1]`), on either scheme.
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
                "The Engram address must be a loopback address (localhost, 127.0.0.1 or [::1])."
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

/// Validates an Engram address: loopback only, on either scheme — the
/// mirror is a local service, and a webview-reachable setter must never be
/// able to point it at a remote host (memories would be exfiltrated).
/// `127.0.0.1`, `localhost` and `[::1]` are accepted; userinfo is never —
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
    match url.host_str() {
        // The url crate keeps IPv6 hosts bracketed in `host_str`.
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") => Ok(()),
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
/// `topicKey` rides as a namespace-prefixed `topic_key` (same topic →
/// update, never a duplicate, and no foreign row can ever match);
/// `capture_prompt: false` keeps Engram from recording anything besides
/// the memory itself.
pub fn upsert_body(settings: &EngramSettings, memory: &Memory) -> String {
    serde_json::json!({
        "session_id": ENGRAM_SESSION_ID,
        "project": settings.project,
        "scope": ENGRAM_MEMORY_SCOPE,
        "type": ENGRAM_MEMORY_TYPE,
        "title": memory.title,
        "content": memory.content,
        "topic_key": mirror_topic_key(&memory.topic_key),
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

/// One parsed remote observation row (only the fields the mirror uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteObservation {
    pub id: i64,
    pub topic_key: Option<String>,
    pub session_id: Option<String>,
}

/// Parses a `GET /observations/recent` reply body. Malformed bodies and
/// rows yield nothing (the caller must treat "cannot see it" as "leave it
/// alone", never as permission to delete).
pub fn parse_observations(recent_json: &str) -> Vec<RemoteObservation> {
    serde_json::from_str::<serde_json::Value>(recent_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|observation| {
            Some(RemoteObservation {
                id: observation.get("id")?.as_i64()?,
                topic_key: observation
                    .get("topic_key")
                    .and_then(|key| key.as_str())
                    .map(str::to_string),
                session_id: observation
                    .get("session_id")
                    .and_then(|session| session.as_str())
                    .map(str::to_string),
            })
        })
        .collect()
}

/// Whether a remote row was written by this mirror: it must carry the
/// mirror's own session id. Engram's recent list exposes `session_id`
/// (verified live against v3.4.1); a row without one, or with a foreign
/// one, is never touched.
fn own_session(row: &RemoteObservation) -> bool {
    row.session_id.as_deref() == Some(ENGRAM_SESSION_ID)
}

/// Mirrors one memory delete by topic key: finds the remote row through
/// the recent-observations list, then deletes it. Only a row with the
/// mirror's namespace prefix **and** the mirror's own session id matches —
/// foreign observations in the same project are never touched. A `404`
/// (already gone) is success — idempotent. `Ok(false)` means nothing was
/// found to delete (the mirror never wrote it, or it was already removed);
/// the local delete still stands either way.
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
    let mirror_key = mirror_topic_key(topic_key);
    let Some(id) = parse_observations(&recent.body)
        .into_iter()
        .find(|row| own_session(row) && row.topic_key.as_deref() == Some(mirror_key.as_str()))
        .map(|row| row.id)
    else {
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
    // Only mirrored rows (namespace prefix + the mirror's own session) are
    // stale-delete candidates: observations another writer put into this
    // project never match, whatever their topic key says.
    for row in parse_observations(&recent.body) {
        if !own_session(&row) {
            continue;
        }
        let Some(local_topic) = row.topic_key.as_deref().and_then(strip_mirror_prefix) else {
            continue;
        };
        if local_topics.contains(&local_topic) {
            continue;
        }
        let id = row.id;
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
    fn engram_addresses_are_loopback_only_on_both_schemes() {
        assert_eq!(validate_engram_address("http://127.0.0.1:7437"), Ok(()));
        assert_eq!(validate_engram_address("http://localhost:7437"), Ok(()));
        assert_eq!(validate_engram_address("http://[::1]:7437"), Ok(()));
        assert_eq!(validate_engram_address("https://127.0.0.1:7437"), Ok(()));
        assert_eq!(validate_engram_address("https://[::1]"), Ok(()));
        assert_eq!(validate_engram_address("  http://127.0.0.1:7437  "), Ok(()));
        assert_eq!(
            validate_engram_address(""),
            Err(EngramProblem::AddressEmpty)
        );
        // A remote host is refused on both schemes: any webview that can
        // call the setter must never point the mirror (and its memories)
        // at a server outside this computer.
        assert_eq!(
            validate_engram_address("https://engram.example.com"),
            Err(EngramProblem::AddressDisallowed)
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
                "topic_key": "calendar-app/style/short",
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
    fn parse_observations_reads_the_fields_the_mirror_uses() {
        let recent = r#"[
            {"id": 7, "topic_key": "other/topic", "session_id": "someone-else"},
            {"id": 4157, "topic_key": "calendar-app/style/short", "session_id": "calendar-app-mirror"},
            {"id": 9},
            "garbage"
        ]"#;
        let rows = parse_observations(recent);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, 7);
        assert_eq!(rows[0].topic_key.as_deref(), Some("other/topic"));
        assert_eq!(rows[1].id, 4157);
        // A row with an id but no topic_key/session fields still parses
        // (with `None`s); a non-object row is dropped.
        assert_eq!(rows[2].id, 9);
        assert_eq!(rows[2].topic_key, None);
        assert_eq!(rows[2].session_id, None);
        // Malformed bodies yield nothing ("cannot see it" → leave it alone).
        assert!(parse_observations("not json").is_empty());
        assert!(parse_observations("{}").is_empty());
        assert!(parse_observations("[]").is_empty());
    }

    #[test]
    fn mirror_topic_keys_are_namespaced() {
        assert_eq!(mirror_topic_key("style/short"), "calendar-app/style/short");
        assert_eq!(strip_mirror_prefix("calendar-app/style/short"), Some("style/short"));
        // Foreign keys (no prefix, or a prefix-like name) never strip.
        assert_eq!(strip_mirror_prefix("style/short"), None);
        assert_eq!(strip_mirror_prefix("calendar-appish/foo"), None);
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
        assert_eq!(body["topic_key"], "calendar-app/t");
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
            Fake::ok(
                200,
                r#"[{"id":4157,"topic_key":"calendar-app/t","session_id":"calendar-app-mirror"}]"#,
            ),
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
    fn mirror_delete_never_touches_a_foreign_row() {
        // Same project, but neither the namespace prefix nor the mirror's
        // session: both must survive a delete for a colliding local topic.
        let fake = Fake::new(vec![Fake::ok(
            200,
            r#"[
                {"id":1,"topic_key":"t","session_id":"calendar-app-mirror"},
                {"id":2,"topic_key":"calendar-app/t","session_id":"someone-else"},
                {"id":3,"topic_key":"calendar-app/t"}
            ]"#,
        )]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(false));
        assert_eq!(fake.requests().len(), 1, "no delete call without an own row");
    }

    #[test]
    fn mirror_delete_is_idempotent_for_an_unknown_topic() {
        let fake = Fake::new(vec![Fake::ok(200, "[]")]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(false));
        assert_eq!(fake.requests().len(), 1, "no delete call without a row");
    }

    #[test]
    fn mirror_delete_treats_a_404_as_success_and_a_409_as_failure() {
        let own_row = r#"[{"id":1,"topic_key":"calendar-app/t","session_id":"calendar-app-mirror"}]"#;
        let fake = Fake::new(vec![
            Fake::ok(200, own_row),
            Fake::ok(404, r#"{"error":"not found"}"#),
        ]);
        assert_eq!(mirror_delete(&fake, &settings(), "t"), Ok(true));
        let fake = Fake::new(vec![
            Fake::ok(200, own_row),
            Fake::ok(409, r#"{"error":"mismatch"}"#),
        ]);
        assert!(mirror_delete(&fake, &settings(), "t").is_err());
    }

    #[test]
    fn sync_all_upserts_every_local_memory_and_deletes_stale_topics() {
        let memories = vec![memory("keep/1"), memory("keep/2")];
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s"}"#),                       // session
            Fake::ok(
                200,
                r#"[
                    {"id":10,"topic_key":"calendar-app/stale","session_id":"calendar-app-mirror"},
                    {"id":11,"topic_key":"calendar-app/keep/1","session_id":"calendar-app-mirror"}
                ]"#,
            ),                                                    // recent
            Fake::ok(201, r#"{"id":100}"#),                       // upsert keep/1
            Fake::ok(201, r#"{"id":101}"#),                       // upsert keep/2
            Fake::ok(200, r#"{"status":"deleted"}"#),             // delete stale 10
        ]);
        let report = sync_all(&fake, &settings(), &memories).unwrap();
        assert_eq!(report, SyncReport { upserted: 2, deleted: 1 });
        let requests = fake.requests();
        assert_eq!(requests.len(), 5);
        // `keep/1` was upserted, not deleted, despite existing remotely.
        assert!(requests[2].json_body.as_deref().unwrap().contains("calendar-app/keep/1"));
        assert_eq!(requests[4].url, "http://127.0.0.1:7437/observations/10?expected_project=proj");
    }

    #[test]
    fn sync_all_never_touches_foreign_observations() {
        // Rows in the same project without the mirror's namespace prefix, or
        // with a foreign session id (or no session id at all) survive sync,
        // even when their topic key would collide with a stale mirror topic.
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s"}"#),
            Fake::ok(
                200,
                r#"[
                    {"id":1,"topic_key":"stale","session_id":"calendar-app-mirror"},
                    {"id":2,"topic_key":"calendar-app/stale","session_id":"someone-else"},
                    {"id":3,"topic_key":"calendar-app/stale"},
                    {"id":4,"topic_key":"unrelated/foreign","session_id":"someone-else"}
                ]"#,
            ),
        ]);
        let report = sync_all(&fake, &settings(), &[]).unwrap();
        assert_eq!(report, SyncReport { upserted: 0, deleted: 0 });
        assert_eq!(fake.requests().len(), 2, "only session + lookup, no deletes");
    }

    #[test]
    fn sync_all_twice_makes_no_changes_the_second_time() {
        // Same remote list as the first sync's result would produce: the
        // plan for an already-converged mirror performs upserts (same
        // topics, same rows) and deletes nothing.
        let memories = vec![memory("keep/1")];
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{"id":"s"}"#),
            Fake::ok(200, r#"[{"id":11,"topic_key":"calendar-app/keep/1","session_id":"calendar-app-mirror"}]"#),
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
            Fake::ok(200, r#"[{"id":5,"topic_key":"calendar-app/stale","session_id":"calendar-app-mirror"}]"#),
            Fake::ok(201, r#"{"id":6}"#),
            Fake::ok(409, r#"{"error":"mismatch"}"#),
        ]);
        assert!(sync_all(&fake, &settings(), &memories).is_err());
    }

    #[test]
    fn sync_all_with_no_memories_only_deletes_everything_remote() {
        let fake = Fake::new(vec![
            Fake::ok(201, r#"{}"#),
            Fake::ok(
                200,
                r#"[
                    {"id":1,"topic_key":"calendar-app/a","session_id":"calendar-app-mirror"},
                    {"id":2,"topic_key":"calendar-app/b","session_id":"calendar-app-mirror"}
                ]"#,
            ),
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

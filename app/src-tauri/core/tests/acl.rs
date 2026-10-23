//! Per-window command ACL consistency (ronda3 S3).
//!
//! The app's `build.rs` declares every custom command in a Tauri `AppManifest`
//! (`tauri_build::Attributes::app_manifest`), which makes Tauri's ACL gate each
//! command per window: a window can only invoke commands granted through an
//! `allow-<command>` permission in one of its capabilities
//! (`src-tauri/capabilities/*.json`). These tests keep the three sources in
//! sync by parsing them as plain text/JSON (no Tauri deps needed on Linux):
//!
//! 1. every command in `generate_handler!` (src/lib.rs) is in the manifest;
//! 2. every manifest command is granted to at least one window;
//! 3. no sensitive command is granted to the auxiliary windows
//!    (`pill` / `quickadd`): secret/key, chat, memory, Engram, OAuth, deep
//!    link, tray, idle, notifications and main-window control stay `main`-only;
//! 4. every non-`core:` permission a capability references is a real manifest
//!    command permission (catches typos like `allow-quickadd_get-config`).

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn src_tauri_dir() -> PathBuf {
    // This test lives in `src-tauri/core/tests/`, so the app crate is one
    // directory up from the manifest dir of `planner-core`.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Command names registered in `tauri::generate_handler![...]` (last `::`
/// segment of each entry).
fn handler_commands(lib_rs: &str) -> Vec<String> {
    let start = lib_rs
        .find("generate_handler![")
        .expect("lib.rs must register commands with `generate_handler![`");
    let body = &lib_rs[start + "generate_handler![".len()..];
    let end = body
        .find(']')
        .expect("unterminated `generate_handler![` in lib.rs");
    body[..end]
        .split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .rsplit("::")
                .next()
                .expect("non-empty split")
                .trim()
                .to_string()
        })
        .collect()
}

/// Command names listed in `const COMMANDS: &[&str] = &[...]` in build.rs.
fn manifest_commands(build_rs: &str) -> Vec<String> {
    let start = build_rs
        .find("const COMMANDS: &[&str] = &[")
        .expect("build.rs must declare the AppManifest command list as `const COMMANDS`");
    let body = &build_rs[start + "const COMMANDS: &[&str] = &[".len()..];
    let end = body
        .find("];")
        .expect("unterminated `const COMMANDS` list in build.rs");
    body[..end]
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

/// Permission identifier tauri-build generates for a command: `allow-` plus the
/// command name with underscores replaced by dashes.
fn allow_identifier(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

fn sensitive_prefixes() -> &'static [&'static str] {
    // Anything matching one of these (on the allow- identifier) must never be
    // granted to `pill` or `quickadd`. `desktop_backdrop` is deliberately not
    // sensitive: the quick-add window invokes it to re-theme itself.
    &[
        "allow-chat-",
        "allow-engram-",
        "allow-google-oauth-",
        "allow-deeplink-",
        "allow-tray-",
        "allow-idle-",
        "allow-notify-",
        "allow-desktop-launched-at-sign-in",
        "allow-desktop-show-main",
    ]
}

/// (capability identifier, windows, permissions) for every capabilities/*.json.
fn read_capabilities() -> Vec<(String, Vec<String>, BTreeSet<String>)> {
    let dir = src_tauri_dir().join("capabilities");
    let mut out = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .expect("capabilities directory must exist")
        .map(|entry| entry.expect("readable capabilities entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();
    for path in entries {
        let raw = fs::read_to_string(&path).expect("readable capability file");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid capability JSON");
        let identifier = value["identifier"]
            .as_str()
            .expect("capability identifier")
            .to_string();
        let windows = value["windows"]
            .as_array()
            .expect("capability windows")
            .iter()
            .map(|w| w.as_str().expect("window label").to_string())
            .collect();
        let permissions = value["permissions"]
            .as_array()
            .expect("capability permissions")
            .iter()
            .map(|p| p.as_str().expect("permission identifier").to_string())
            .collect::<BTreeSet<_>>();
        out.push((identifier, windows, permissions));
    }
    out
}

#[test]
fn manifest_covers_every_registered_command() {
    let lib_rs =
        fs::read_to_string(src_tauri_dir().join("src/lib.rs")).expect("readable src/lib.rs");
    let build_rs = fs::read_to_string(src_tauri_dir().join("build.rs")).expect("readable build.rs");

    let handlers: BTreeSet<_> = handler_commands(&lib_rs).into_iter().collect();
    let manifest: BTreeSet<_> = manifest_commands(&build_rs).into_iter().collect();

    let missing: Vec<_> = handlers.difference(&manifest).collect();
    assert!(
        missing.is_empty(),
        "commands registered in generate_handler! but missing from the AppManifest in build.rs: {missing:?}"
    );
    let stale: Vec<_> = manifest.difference(&handlers).collect();
    assert!(
        stale.is_empty(),
        "AppManifest commands in build.rs that are not registered in generate_handler!: {stale:?}"
    );
}

#[test]
fn every_manifest_command_is_granted_to_a_window() {
    let build_rs = fs::read_to_string(src_tauri_dir().join("build.rs")).expect("readable build.rs");
    let capabilities = read_capabilities();
    let granted: BTreeSet<_> = capabilities
        .iter()
        .flat_map(|(_, _, permissions)| permissions.iter().cloned())
        .collect();

    let orphans: Vec<String> = manifest_commands(&build_rs)
        .iter()
        .map(|command| allow_identifier(command))
        .filter(|identifier| !granted.contains(identifier))
        .collect();
    assert!(
        orphans.is_empty(),
        "manifest commands granted to no window (they would fail in every window): {orphans:?}"
    );
}

#[test]
fn sensitive_commands_stay_on_the_main_window() {
    let capabilities = read_capabilities();
    for (identifier, windows, permissions) in &capabilities {
        if windows.iter().any(|window| window == "main") {
            continue;
        }
        let leaks: Vec<_> = sensitive_prefixes()
            .iter()
            .flat_map(|prefix| {
                let prefix = *prefix;
                permissions
                    .iter()
                    .filter(move |permission| permission.starts_with(prefix))
            })
            .collect();
        assert!(
            leaks.is_empty(),
            "capability {identifier} must not grant sensitive commands: {leaks:?}"
        );
    }
}

#[test]
fn capabilities_reference_known_app_permissions() {
    let build_rs = fs::read_to_string(src_tauri_dir().join("build.rs")).expect("readable build.rs");
    let known: BTreeSet<_> = manifest_commands(&build_rs)
        .iter()
        .map(|command| allow_identifier(command))
        .collect();

    for (identifier, _, permissions) in read_capabilities() {
        let unknown: Vec<_> = permissions
            .iter()
            // `plugin:identifier` entries (e.g. `core:default`) belong to
            // plugins; app command permissions have no prefix.
            .filter(|permission| !permission.contains(':'))
            .filter(|permission| !known.contains(*permission))
            .collect();
        assert!(
            unknown.is_empty(),
            "capability {identifier} references app permissions that no manifest command generates: {unknown:?}"
        );
    }
}

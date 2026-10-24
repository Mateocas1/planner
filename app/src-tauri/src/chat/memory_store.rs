//! Local memory file store (task C1 of `odd/tasks/llm-chat.md`, spec S5, the
//! storage half): an Engram-shaped memory list persisted as
//! `chat-memories.json` in the app data dir (`app_local_data_dir`, not the
//! roaming config dir). Rust owns the file; the webview reaches it only
//! through these commands. The decision logic (load classification,
//! topic-key upserts, caps, backup naming) is the pure
//! [`planner_core::chat`] half.
//!
//! Data safety (security review chat-c1-sec, blocker #1): only a missing
//! file or a corrupt-JSON file yields an empty store; every other read
//! error (permissions, sharing violation, invalid UTF-8) is an error and
//! `apply`/`delete`/`clear` refuse to write, so a transient read failure
//! can never wipe the memories.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use planner_core::chat::apply_memory_ops;
use planner_core::fsutil::atomic_write;
use planner_core::chat::backup_file_name;
use planner_core::chat::classify_load;
use planner_core::chat::new_memory_id;
use planner_core::chat::prune_backups;
use planner_core::chat::LoadDecision;
use planner_core::chat::Memory;
use planner_core::chat::MemoryOp;
use planner_core::chat::BACKUP_PREFIX;
use tauri::AppHandle;
use tauri::Manager;

const FILE_NAME: &str = "chat-memories.json";

/// The app data directory shared by the chat's Rust-owned files (the memory
/// store and, from `chat/mod.rs`, the non-secret provider settings). Spec
/// S5 places them in the local app data dir, not the roaming config dir.
pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("the app data directory is unavailable: {error}"))
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_dir(app).map(|dir| dir.join(FILE_NAME))
}

/// Loads the memories. A missing file is an empty store; a corrupt file is
/// moved aside (a timestamped backup, at most [`planner_core::chat::MAX_BACKUPS`]
/// kept) and the store starts empty. Any other read error refuses to load,
/// so callers must not write over a file they could not read.
fn load(path: &Path) -> Result<Vec<Memory>, String> {
    match classify_load(fs::read_to_string(path)) {
        LoadDecision::Loaded(memories) => Ok(memories),
        LoadDecision::Empty => Ok(Vec::new()),
        LoadDecision::Corrupt => {
            backup_corrupt(path);
            Ok(Vec::new())
        }
        LoadDecision::Unreadable(error) => Err(format!(
            "the memory file could not be read ({error}); nothing was changed to avoid data loss"
        )),
    }
}

/// Moves a corrupt memory file aside under a unique timestamped name, then
/// prunes older backups so at most three remain. A failed backup is not
/// fatal: the store still starts empty and the next save replaces the
/// corrupt file.
fn backup_corrupt(path: &Path) {
    let Some(dir) = path.parent() else {
        return;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    for seq in 0..1000u32 {
        if fs::rename(path, dir.join(backup_file_name(now_ms, seq))).is_ok() {
            break;
        }
    }
    let names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(BACKUP_PREFIX))
        .collect();
    for name in prune_backups(names) {
        let _ = fs::remove_file(dir.join(name));
    }
}

fn save(path: &Path, memories: &[Memory]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(memories)
        .map_err(|error| format!("the memories could not be serialized: {error}"))?;
    atomic_write(path, &json)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Loads the whole store for the Engram mirror's "Sync now" (task R2). The
/// same data-safety rules as the commands: a missing file is empty, an
/// unreadable file is an error and refuses to write.
pub(crate) fn load_all(app: &AppHandle) -> Result<Vec<Memory>, String> {
    load(&file_path(app)?)
}

/// Lists all memories, newest topic first is the caller's concern; the order
/// is the store's insertion order. An unreadable file is an error.
#[tauri::command]
pub fn chat_memories_list(app: AppHandle) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    load(&path)
}

/// Applies extraction operations (upserts/deletes keyed by `topicKey`) and
/// returns the resulting store. More than 64 ops or an over-long topic key
/// rejects the whole call; an unreadable memory file refuses the write.
#[tauri::command]
pub fn chat_memories_apply(app: AppHandle, ops: Vec<MemoryOp>) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    let memories = apply_memory_ops(load(&path)?, &ops, new_memory_id, now_ms())?;
    save(&path, &memories)?;
    super::engram::mirror_after_write(&app, &ops);
    Ok(memories)
}

/// Deletes one memory by id and returns the resulting store. An unreadable
/// memory file refuses the write.
#[tauri::command]
pub fn chat_memories_delete(app: AppHandle, id: String) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    let mut memories = load(&path)?;
    // The deleted memory's topic key drives the Engram mirror delete (R2).
    let topic = memories
        .iter()
        .find(|memory| memory.id == id)
        .map(|memory| MemoryOp::Delete {
            topic_key: memory.topic_key.clone(),
        });
    memories.retain(|memory| memory.id != id);
    save(&path, &memories)?;
    if let Some(op) = topic {
        super::engram::mirror_after_write(&app, std::slice::from_ref(&op));
    }
    Ok(memories)
}

/// Removes every memory. An unreadable memory file refuses the write.
#[tauri::command]
pub fn chat_memories_clear(app: AppHandle) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    let memories = load(&path)?;
    // "Clear all" removes the mirrored observations too (spec S2).
    let mirror_ops: Vec<MemoryOp> = memories
        .iter()
        .map(|memory| MemoryOp::Delete {
            topic_key: memory.topic_key.clone(),
        })
        .collect();
    save(&path, &[])?;
    super::engram::mirror_after_write(&app, &mirror_ops);
    Ok(Vec::new())
}

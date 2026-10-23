//! Local memory file store (task C1 of `odd/tasks/llm-chat.md`, spec S5, the
//! storage half): an Engram-shaped memory list persisted as
//! `chat-memories.json` in the app config dir. Rust owns the file; the
//! webview reaches it only through these commands. The operation logic
//! (topic-key upserts, caps) is the pure [`planner_core::chat`] half.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use planner_core::chat::apply_memory_ops;
use planner_core::chat::new_memory_id;
use planner_core::chat::Memory;
use planner_core::chat::MemoryOp;
use tauri::AppHandle;
use tauri::Manager;

const FILE_NAME: &str = "chat-memories.json";

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app
        .path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|error| format!("the app data directory is unavailable: {error}"))
}

/// Loads the memories; a missing file is an empty store, and a corrupt file
/// is moved aside (`.json.bak`) and treated as empty — it must never crash
/// the app or take the user's other data with it.
fn load(path: &Path) -> Vec<Memory> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str(&text) {
        Ok(memories) => memories,
        Err(_) => {
            let _ = fs::rename(path, path.with_extension("json.bak"));
            Vec::new()
        }
    }
}

/// Saves the memories atomically: write a temp file, then rename over the
/// target, so an interrupted write can never leave a half-written store.
fn save(path: &Path, memories: &[Memory]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "the memory file has no directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| format!("the app data directory could not be created: {error}"))?;
    let temp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(memories)
        .map_err(|error| format!("the memories could not be serialized: {error}"))?;
    fs::write(&temp, json).map_err(|error| format!("the memory file could not be written: {error}"))?;
    fs::rename(&temp, path).map_err(|error| format!("the memory file could not be replaced: {error}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Lists all memories, newest topic first is the caller's concern; the order
/// is the store's insertion order.
#[tauri::command]
pub fn chat_memories_list(app: AppHandle) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    Ok(load(&path))
}

/// Applies extraction operations (upserts/deletes keyed by `topicKey`) and
/// returns the resulting store.
#[tauri::command]
pub fn chat_memories_apply(app: AppHandle, ops: Vec<MemoryOp>) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    let memories = apply_memory_ops(load(&path), &ops, new_memory_id, now_ms());
    save(&path, &memories)?;
    Ok(memories)
}

/// Deletes one memory by id and returns the resulting store.
#[tauri::command]
pub fn chat_memories_delete(app: AppHandle, id: String) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    let mut memories = load(&path);
    memories.retain(|memory| memory.id != id);
    save(&path, &memories)?;
    Ok(memories)
}

/// Removes every memory.
#[tauri::command]
pub fn chat_memories_clear(app: AppHandle) -> Result<Vec<Memory>, String> {
    let path = file_path(&app)?;
    save(&path, &[])?;
    Ok(Vec::new())
}

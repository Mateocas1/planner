//! Platform-independent file helpers shared by the Rust-owned stores.

use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;

/// Writes a text file atomically: create a unique temp file in the same
/// directory, `write_all`, `sync_all`, then rename over the target, so an
/// interrupted write can never leave a half-written file. The temp name is
/// unique per call (pid + nanos): two concurrent writers of the same target
/// (e.g. two settings saves racing) never share one temp file, so neither
/// write can clobber the other's contents mid-rename.
pub fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "the target file has no directory".to_string())?;
    fs::create_dir_all(dir).map_err(|error| {
        format!(
            "the directory could not be created: {error} ({} {})",
            dir.display(),
            path.display()
        )
    })?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "target".to_string());
    let temp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        nanos
    ));
    let mut file = File::create(&temp)
        .map_err(|error| format!("{} could not be created: {error}", temp.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("{} could not be written: {error}", temp.display()))?;
    file.sync_all()
        .map_err(|error| format!("{} could not be flushed: {error}", temp.display()))?;
    drop(file);
    fs::rename(&temp, path)
        .map_err(|error| format!("{} could not be replaced: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fsutil-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|e| e.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Concurrent writers of the same target never collide on the temp file
    /// (the review found `chat-engram.tmp` shared without a lock) and the
    /// final content is one of the writers' complete payloads, never a mix.
    #[test]
    fn concurrent_atomic_writes_leave_one_complete_payload_and_no_temp() {
        let dir = scratch_dir("concurrent");
        let target = dir.join("settings.json");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let target = target.clone();
                std::thread::spawn(move || atomic_write(&target, &format!("payload-{i}")))
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        let final_text = fs::read_to_string(&target).unwrap();
        assert!(
            (0..8).any(|i| final_text == format!("payload-{i}")),
            "the target must hold exactly one writer's full payload, got {final_text}"
        );
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_atomic_write_replaces_the_target_and_cleans_up() {
        let dir = scratch_dir("single");
        let target = dir.join("chat-engram.json");
        atomic_write(&target, "first").unwrap();
        atomic_write(&target, "second").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["chat-engram.json".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
}

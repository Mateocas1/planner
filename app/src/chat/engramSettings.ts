/**
 * Typed wrappers for the Engram mirror settings and status (task R2 of
 * `odd/tasks/ronda3.md`, spec S2). The settings and the last-attempt record
 * are Rust-owned files in the app data dir
 * (`src-tauri/src/chat/engram.rs`); the webview reaches them only through
 * these commands. The mirror itself also lives in Rust: every applied
 * memory op is mirrored after the local write succeeds, best effort — this
 * module never triggers the per-op mirror, only "Sync now" does bulk work.
 */

import { invoke } from "@tauri-apps/api/core";

/** The persisted Engram mirror settings (spec S2 defaults live in Rust). */
export type EngramSettings = {
  enabled: boolean;
  address: string;
  project: string;
};

/** The last mirror attempt: any per-op write or a "Sync now". */
export type EngramMirrorStatus = {
  /** Unix epoch milliseconds of the attempt. */
  lastAttemptAt: number;
  ok: boolean;
  /** Memories touched by the successful attempt (upserts + deletes). */
  synced: number;
  error: string | null;
};

export function engramSettingsGet(): Promise<EngramSettings> {
  return invoke<EngramSettings>("engram_settings_get");
}

export function engramSettingsSet(settings: EngramSettings): Promise<void> {
  return invoke("engram_settings_set", { settings });
}

export function engramSyncNow(): Promise<EngramMirrorStatus> {
  return invoke<EngramMirrorStatus>("engram_sync_now");
}

export function engramStatus(): Promise<EngramMirrorStatus | null> {
  return invoke<EngramMirrorStatus | null>("engram_status");
}

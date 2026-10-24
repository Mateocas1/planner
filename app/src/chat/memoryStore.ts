/**
 * Typed wrappers for the local memory store (spec S5). The durable memories
 * live in a Rust-owned JSON file in the app data dir; the webview reaches
 * them only through these commands (`src-tauri/src/chat/memory_store.rs`).
 */

import { invoke } from "@tauri-apps/api/core";

/** One durable memory, Engram-shaped (spec S5, parent decision L3). */
export type Memory = {
  id: string;
  topicKey: string;
  title: string;
  content: string;
  /** Unix epoch milliseconds. */
  updatedAt: number;
};

/**
 * One memory-extraction operation. An upsert keyed by an existing `topicKey`
 * updates in place (never duplicates); `delete` removes the topic.
 */
export type MemoryOp =
  | { op: "upsert"; topicKey: string; title: string; content: string }
  | { op: "delete"; topicKey: string };

/** The window event the chat dispatches whenever the durable notes change
 * under the UI (a confirmed remember/forget tool call or an end-of-
 * conversation extraction); the AI settings memory list listens for it and
 * refreshes when shown. */
export const MEMORIES_CHANGED_EVENT = "planner:chat-memories-changed";

export function chatMemoriesList(): Promise<Memory[]> {
  return invoke<Memory[]>("chat_memories_list");
}

export function chatMemoriesApply(ops: MemoryOp[]): Promise<Memory[]> {
  return invoke<Memory[]>("chat_memories_apply", { ops });
}

export function chatMemoriesDelete(id: string): Promise<Memory[]> {
  return invoke<Memory[]>("chat_memories_delete", { id });
}

export function chatMemoriesClear(): Promise<Memory[]> {
  return invoke<Memory[]>("chat_memories_clear");
}

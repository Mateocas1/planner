/**
 * The memory backend the chat panel reads and applies note ops through
 * (spec S5, task C3a). On desktop the durable notes live in the Rust-owned
 * JSON file behind `memoryStore.ts`; the dev mock runs on an in-memory
 * backend so the browser tests can exercise extraction → injection without
 * Tauri. Both implement the same tiny interface, so nothing above it knows
 * which one is live.
 */

import { chatMemoriesApply, chatMemoriesList, type Memory, type MemoryOp } from "./memoryStore.ts";

export type ChatMemoryBackend = {
  list(): Promise<Memory[]>;
  apply(ops: MemoryOp[]): Promise<Memory[]>;
};

/** The desktop backend: Rust commands, app-data-dir file (spec S5). */
export const tauriMemoryBackend: ChatMemoryBackend = {
  list: () => chatMemoriesList(),
  apply: ops => chatMemoriesApply(ops),
};

let inMemoryIdCounter = 0;

/** An in-memory backend with the same upsert-by-topicKey semantics as Rust. */
export function createInMemoryMemoryBackend(seed: Memory[] = []): ChatMemoryBackend {
  let memories = [...seed];
  return {
    list() {
      return Promise.resolve([...memories]);
    },
    apply(ops) {
      for (const op of ops) {
        if (op.op === "delete") {
          memories = memories.filter(memory => memory.topicKey !== op.topicKey);
          continue;
        }
        const existing = memories.find(memory => memory.topicKey === op.topicKey);
        if (existing !== undefined) {
          memories = memories.map(memory =>
            memory.topicKey === op.topicKey ? { ...memory, title: op.title, content: op.content, updatedAt: Date.now() } : memory,
          );
        } else {
          inMemoryIdCounter += 1;
          memories = [
            ...memories,
            { id: `m${inMemoryIdCounter}`, topicKey: op.topicKey, title: op.title, content: op.content, updatedAt: Date.now() },
          ];
        }
      }
      return Promise.resolve([...memories]);
    },
  };
}

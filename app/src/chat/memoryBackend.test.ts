import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryMemoryBackend } from "./memoryBackend.ts";
import type { Memory } from "./memoryStore.ts";

const seed: Memory[] = [{ id: "m1", topicKey: "style", title: "Style", content: "Short answers", updatedAt: 1 }];

test("upsert keyed by an existing topicKey updates in place, never duplicates", async () => {
  const backend = createInMemoryMemoryBackend(seed);
  const list = await backend.apply([{ op: "upsert", topicKey: "style", title: "Style", content: "Even shorter answers" }]);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "m1", "the id survives an update");
  assert.equal(list[0]?.content, "Even shorter answers");
  assert.ok((list[0]?.updatedAt ?? 0) >= 1);
});

test("upsert with a new topicKey appends; delete removes the whole topic", async () => {
  const backend = createInMemoryMemoryBackend(seed);
  let list = await backend.apply([{ op: "upsert", topicKey: "tz", title: "Zone", content: "Buenos Aires" }]);
  assert.equal(list.length, 2);
  list = await backend.apply([{ op: "delete", topicKey: "style" }]);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.topicKey, "tz");
});

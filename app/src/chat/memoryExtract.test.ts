import assert from "node:assert/strict";
import test from "node:test";
import type { ChatTurn } from "./conversation.ts";
import { buildExtractionRequest, parseMemoryOps } from "./memoryExtract.ts";
import type { Memory } from "./memoryStore.ts";

const memory = (id: string, topicKey: string, title: string, updatedAt: number): Memory => ({
  id,
  topicKey,
  title,
  content: `content of ${title}`,
  updatedAt,
});

const turns: ChatTurn[] = [
  { id: "u1", role: "user", text: "I plan my week on Sunday evenings." },
  { id: "a1", role: "assistant", text: "Noted, that is a good habit.", segments: ["Noted, that is a good habit."] },
];

test("a good JSON object with ops parses to typed memory ops", () => {
  const raw = `{"ops":[{"op":"upsert","topicKey":"weekly-review","title":"Plans weekly","content":"Plans the week on Sunday evenings."},{"op":"delete","topicKey":"old-note"}]}`;
  assert.deepEqual(parseMemoryOps(raw), [
    { op: "upsert", topicKey: "weekly-review", title: "Plans weekly", content: "Plans the week on Sunday evenings." },
    { op: "delete", topicKey: "old-note" },
  ]);
});

test("a bare JSON array also parses", () => {
  const raw = `[{"op":"delete","topicKey":"k"}]`;
  assert.deepEqual(parseMemoryOps(raw), [{ op: "delete", topicKey: "k" }]);
});

test("fenced JSON (with or without the language tag) is tolerated", () => {
  const fenced = '```json\n{"ops":[{"op":"upsert","topicKey":"k","title":"T","content":"C"}]}\n```';
  assert.equal(parseMemoryOps(fenced).length, 1);
  const plain = '```\n{"ops":[]}\n```';
  assert.deepEqual(parseMemoryOps(plain), []);
});

test("malformed JSON yields no ops at all", () => {
  assert.deepEqual(parseMemoryOps("not json at all"), []);
  assert.deepEqual(parseMemoryOps(`{"ops":[{"op":"upsert"`), []);
  assert.deepEqual(parseMemoryOps(""), []);
  assert.deepEqual(parseMemoryOps('{"ops": "upsert everything"}'), []);
});

test("unknown op kinds and ops missing required fields are dropped, valid ones kept", () => {
  const raw = JSON.stringify({
    ops: [
      { op: "upsert", topicKey: "keep", title: "T", content: "C" },
      { op: "note", topicKey: "x", title: "T", content: "C" },
      { op: "upsert", title: "no topic key", content: "C" },
      { op: "upsert", topicKey: "", title: "empty key", content: "C" },
      { op: "delete" },
      { op: "delete", topicKey: "also-keep" },
      { op: "upsert", topicKey: "no-content", title: "T" },
    ],
  });
  assert.deepEqual(parseMemoryOps(raw), [
    { op: "upsert", topicKey: "keep", title: "T", content: "C" },
    { op: "delete", topicKey: "also-keep" },
  ]);
});

test("more than the op cap truncates to the first ten", () => {
  const ops = Array.from({ length: 25 }, (_, i) => ({ op: "delete", topicKey: `k${i}` }));
  const parsed = parseMemoryOps(JSON.stringify({ ops }));
  assert.equal(parsed.length, 10);
});

test("over-long strings are truncated to the store's limits, not rejected wholesale", () => {
  const raw = JSON.stringify({
    ops: [{ op: "upsert", topicKey: "k".repeat(300), title: "t".repeat(400), content: "c".repeat(2000) }],
  });
  const [op] = parseMemoryOps(raw) as Array<{ op: "upsert"; topicKey: string; title: string; content: string }>;
  assert.ok(op.topicKey.length <= 120);
  assert.ok(op.title.length <= 200);
  assert.ok(op.content.length <= 800);
});

test("a non-array ops field is rejected", () => {
  assert.deepEqual(parseMemoryOps('{"ops":42}'), []);
  assert.deepEqual(parseMemoryOps("42"), []);
});

test("buildExtractionRequest puts the rules in a system message and the transcript as data", () => {
  const request = buildExtractionRequest(turns, [memory("m1", "habits", "Weekly habit", 2), memory("m2", "tools", "Tooling", 1)]);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0]?.role, "system");
  assert.equal(request.messages[1]?.role, "user");
  const system = request.messages[0]?.content ?? "";
  const user = request.messages[1]?.content ?? "";
  assert.ok(system.includes("JSON"), system);
  assert.ok(system.includes("10"), `the op cap is named: ${system}`);
  assert.ok(user.includes("User: I plan my week on Sunday evenings."), user);
  assert.ok(user.includes("Assistant: Noted, that is a good habit."), user);
  assert.ok(user.includes("Weekly habit") && user.includes("Tooling"), user);
  assert.ok(user.includes("data"), `the transcript is framed as data, not instructions: ${user}`);
});

test("buildExtractionRequest works with no memories yet", () => {
  const request = buildExtractionRequest(turns, []);
  assert.ok((request.messages[1]?.content ?? "").includes("none yet"));
});

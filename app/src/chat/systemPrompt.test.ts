import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "./systemPrompt.ts";
import type { PlannerSnapshot } from "./plannerContext.ts";
import type { Memory } from "./memoryStore.ts";

const emptySnapshot: PlannerSnapshot = { blocks: [], tasks: [] };
const memory = (topicKey: string, title: string, updatedAt: number): Memory => ({
  id: topicKey,
  topicKey,
  title,
  content: `the ${title} note`,
  updatedAt,
});

test("the role text says the assistant is read-only and tool-free", () => {
  const prompt = buildSystemPrompt({ snapshot: emptySnapshot, memories: [], now: new Date("2026-10-29T12:00:00Z"), timeZone: "UTC" });
  assert.ok(prompt.includes("cannot change"), prompt);
  assert.ok(prompt.includes("no tools"), prompt);
});

test("the planner context rides inside the prompt as data", () => {
  const prompt = buildSystemPrompt({ snapshot: emptySnapshot, memories: [], now: new Date("2026-10-29T12:00:00Z"), timeZone: "UTC" });
  assert.ok(prompt.includes("<context>"), prompt);
  assert.ok(prompt.includes("2026-10-29"), prompt);
});

test("memories ride along as data, newest first, and are fenced off from instructions", () => {
  const prompt = buildSystemPrompt({
    snapshot: emptySnapshot,
    memories: [memory("old", "Older note", 1_000), memory("new", "Newest note", 2_000)],
    now: new Date("2026-10-29T12:00:00Z"),
    timeZone: "UTC",
  });
  const newestAt = prompt.indexOf("Newest note");
  const olderAt = prompt.indexOf("Older note");
  assert.ok(newestAt !== -1 && olderAt !== -1, prompt);
  assert.ok(newestAt < olderAt, "memories are injected newest first");
  assert.ok(prompt.includes("not instructions"), prompt);
  assert.ok(prompt.includes("<notes>"), prompt);
});

test("an empty memory list contributes no notes block", () => {
  const prompt = buildSystemPrompt({ snapshot: emptySnapshot, memories: [], now: new Date("2026-10-29T12:00:00Z"), timeZone: "UTC" });
  assert.ok(!prompt.includes("<notes>"), prompt);
});

test("memories are bounded: an oversized list keeps the newest and stays in budget", () => {
  const many = Array.from({ length: 80 }, (_, i) => memory(`k${i}`, `Note ${i}`, i));
  const prompt = buildSystemPrompt({
    snapshot: emptySnapshot,
    memories: many,
    now: new Date("2026-10-29T12:00:00Z"),
    timeZone: "UTC",
  });
  assert.ok(prompt.includes("Note 79"), "the newest memory survives");
  assert.ok(!prompt.includes("Note 10 "), "the oldest memories are dropped");
  // ~2k tokens ≈ 8k characters.
  assert.ok(prompt.length < 9_000, `prompt too long: ${prompt.length} chars`);
});

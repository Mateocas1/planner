import assert from "node:assert/strict";
import test from "node:test";
import { deleteField } from "firebase/firestore";
import { chatMoveWrites, type ChatMove } from "./chatMove.ts";

/** The payload test (Ronda 3 fix): the batch's writes are pure data, so the
 * executor's atomic commit stores exactly what is asserted here without a
 * Firestore — the real commit is exercised by the browser suite under the
 * emulators. */
test("a move with a start time is one deadline update plus one block document", () => {
  const move: ChatMove = {
    taskId: "t1",
    title: "Pay the invoice",
    deadline: "2026-10-30",
    block: { start: "2026-10-30T14:30:00Z", end: "2026-10-30T15:30:00Z" },
  };
  const writes = chatMoveWrites("u1", move, "b1");
  assert.deepEqual(writes, [
    { kind: "update", path: "users/u1/tasks/t1", fields: { deadline: "2026-10-30" } },
    {
      kind: "set",
      path: "users/u1/blocks/b1",
      fields: { start: "2026-10-30T14:30:00Z", end: "2026-10-30T15:30:00Z", taskId: "t1" },
    },
  ]);
});

test("clearing the deadline removes the field and writes no block", () => {
  const writes = chatMoveWrites("u1", { taskId: "t1", title: "Pay the invoice" }, "b1");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.kind, "update");
  assert.equal(writes[0]?.path, "users/u1/tasks/t1");
  // The deadline is removed the way setTaskDeadline removes it: the delete
  // sentinel, so the field leaves the document instead of becoming null.
  assert.deepEqual(writes[0]?.fields.deadline, deleteField());
});

test("an invalid move throws before any write exists", () => {
  for (const move of [
    { taskId: "t1", title: "Pay the invoice", deadline: "30/10/2026" },
    { taskId: "t1", title: "   " },
    { taskId: "", title: "X" },
    { taskId: "a/b", title: "X" },
    { taskId: "t1", title: "X", block: { start: "nope", end: "2026-10-30T15:30:00Z" } },
  ] as ChatMove[]) {
    assert.throws(() => chatMoveWrites("u1", move, "b1"), JSON.stringify(move));
  }
});

/* ---------- createChatTask (ronda4 T4, S4): one batch, task plus block ---------- */

import { createChatTaskWrites, type ChatCreate } from "./chatMove.ts";

test("a create with a start time is one task document plus one linked block, ids minted upfront", () => {
  const create: ChatCreate = {
    title: "Water the plants",
    deadline: "2026-10-30",
    estimateMinutes: 30,
    block: { start: "2026-10-30T14:00:00Z", end: "2026-10-30T14:30:00Z" },
  };
  const { taskId, blockId, writes } = createChatTaskWrites("u1", create, "t-mint", "b-mint");
  assert.equal(taskId, "t-mint");
  assert.equal(blockId, "b-mint");
  assert.deepEqual(writes, [
    {
      kind: "set",
      path: "users/u1/tasks/t-mint",
      fields: { title: "Water the plants", completed: false, deadline: "2026-10-30", estimate: 30 },
    },
    {
      kind: "set",
      path: "users/u1/blocks/b-mint",
      fields: { start: "2026-10-30T14:00:00Z", end: "2026-10-30T14:30:00Z", taskId: "t-mint" },
    },
  ]);
});

test("a create without a start time is exactly one task document", () => {
  const { blockId, writes } = createChatTaskWrites("u1", { title: "Solo" }, "t-mint", "b-mint");
  assert.equal(blockId, undefined);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.kind === "set" ? writes[0].fields : {}, { title: "Solo", completed: false });
});

test("an invalid create throws before any write exists", () => {
  for (const create of [
    { title: "   " },
    { title: "X", deadline: "30/10/2026" },
    { title: "X", estimateMinutes: 0 },
    { title: "X", block: { start: "2026-10-30T14:00:00Z", end: "2026-10-30T14:00:00Z" } },
  ] as ChatCreate[]) {
    assert.throws(() => createChatTaskWrites("u1", create, "t-mint", "b-mint"), JSON.stringify(create));
  }
});

/* ---------- applyChatTaskUpdate (ronda4 T4): any task edit + block changes in one batch ---------- */

import { chatTaskUpdateWrites, type ChatTaskUpdate } from "./chatMove.ts";

test("an update writes exactly the fields that changed, plus its block changes", () => {
  const update: ChatTaskUpdate = {
    taskId: "t1",
    title: "Pay the invoice",
    deadline: "2026-10-31",
    estimate: 30,
    block: { start: "2026-10-31T16:00:00Z", end: "2026-10-31T16:30:00Z" },
    removeBlockIds: ["b-old"],
  };
  const writes = chatTaskUpdateWrites("u1", update, "b-new");
  assert.deepEqual(writes, [
    { kind: "update", path: "users/u1/tasks/t1", fields: { deadline: "2026-10-31", estimate: 30 } },
    { kind: "set", path: "users/u1/blocks/b-new", fields: { start: "2026-10-31T16:00:00Z", end: "2026-10-31T16:30:00Z", taskId: "t1" } },
    { kind: "delete", path: "users/u1/blocks/b-old" },
  ]);
});

test("an update can clear the deadline and the estimate with the delete sentinel", () => {
  const writes = chatTaskUpdateWrites("u1", { taskId: "t1", title: "X", clearDeadline: true, clearEstimate: true }, "b-new");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.kind, "update");
  const fields = writes[0]?.kind === "update" ? writes[0].fields : {};
  assert.deepEqual(fields.deadline, deleteField());
  assert.deepEqual(fields.estimate, deleteField());
});

test("an update with a new title validates and writes it", () => {
  const writes = chatTaskUpdateWrites("u1", { taskId: "t1", title: "Old name", newTitle: "New name" }, "b-new");
  assert.deepEqual(writes, [{ kind: "update", path: "users/u1/tasks/t1", fields: { title: "New name" } }]);
});

test("an invalid update throws before any write exists", () => {
  for (const update of [
    { taskId: "", title: "X" },
    { taskId: "a/b", title: "X" },
    { taskId: "t1", title: "   " },
    { taskId: "t1", title: "X", deadline: "31/10/2026" },
    { taskId: "t1", title: "X", estimate: 0 },
    { taskId: "t1", title: "X", block: { start: "nope", end: "2026-10-31T16:00:00Z" } },
    { taskId: "t1", title: "X", removeBlockIds: ["ok", "a/b"] },
  ] as ChatTaskUpdate[]) {
    assert.throws(() => chatTaskUpdateWrites("u1", update, "b-new"), JSON.stringify(update));
  }
});

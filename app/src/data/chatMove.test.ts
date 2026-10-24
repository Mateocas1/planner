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
  assert.deepEqual(writes[0]?.fields, { title: "Solo", completed: false });
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

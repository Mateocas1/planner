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

import assert from "node:assert/strict";
import test from "node:test";
import { pendingRemovalCount, trackRemoval } from "./pending.ts";

test("a delete counts as pending until its write is acknowledged", async () => {
  let acknowledge!: () => void;
  const write = new Promise<void>(resolve => {
    acknowledge = resolve;
  });
  const tracked = trackRemoval(write);
  assert.equal(pendingRemovalCount(), 1);
  acknowledge();
  await tracked;
  assert.equal(pendingRemovalCount(), 0);
});

test("a rejected delete is no longer pending, and its error still reaches the caller", async () => {
  const tracked = trackRemoval(Promise.reject(new Error("denied")));
  assert.equal(pendingRemovalCount(), 1);
  await assert.rejects(tracked, /denied/);
  assert.equal(pendingRemovalCount(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { forgetRemoval, pendingRemovalCount, trackRemoval } from "./pending.ts";

const path = "users/u/tasks/t1";

/** A write whose acknowledgement the test releases by hand. */
function held() {
  let acknowledge!: () => void;
  const write = new Promise<void>(resolve => {
    acknowledge = resolve;
  });
  return { write, acknowledge: () => acknowledge() };
}

test("a delete counts as pending until its write is acknowledged", async () => {
  const write = held();
  const tracked = trackRemoval(path, write.write);
  assert.equal(pendingRemovalCount(), 1);
  write.acknowledge();
  await tracked;
  assert.equal(pendingRemovalCount(), 0);
});

test("a rejected delete is no longer pending, and its error still reaches the caller", async () => {
  const tracked = trackRemoval(path, Promise.reject(new Error("denied")));
  assert.equal(pendingRemovalCount(), 1);
  await assert.rejects(tracked, /denied/);
  assert.equal(pendingRemovalCount(), 0);
});

test("an undo forgets the delete it restores, and that delete's late acknowledgement cannot cancel a newer one", async () => {
  const firstWrite = held();
  const first = trackRemoval(path, firstWrite.write);
  assert.equal(pendingRemovalCount(), 1);

  // The restore of the same document takes over the pending slot: one document
  // back where it started is one pending change, not two.
  forgetRemoval(path);
  assert.equal(pendingRemovalCount(), 0);

  // Deleting it again queues a second write. The first delete's acknowledgement
  // arrives afterwards and must not clear the second one.
  const secondWrite = held();
  const second = trackRemoval(path, secondWrite.write);
  assert.equal(pendingRemovalCount(), 1);

  firstWrite.acknowledge();
  await first;
  assert.equal(pendingRemovalCount(), 1);

  secondWrite.acknowledge();
  await second;
  assert.equal(pendingRemovalCount(), 0);
});

test("forgetting a removal that was already acknowledged changes nothing", () => {
  forgetRemoval(path);
  assert.equal(pendingRemovalCount(), 0);
});

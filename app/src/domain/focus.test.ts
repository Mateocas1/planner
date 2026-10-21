import assert from "node:assert/strict";
import test from "node:test";
import {
  focusStatus,
  focusedMs,
  formatRemaining,
  parseSession,
  pauseFocus,
  remainingMs,
  resumeFocus,
  serializeSession,
  startFocus,
  stopFocus,
} from "./focus.ts";

/**
 * The focus timer's state, proved without a DOM, a clock or storage: every
 * assertion passes an instant in, so "ten minutes later" is a number here and
 * never a wait.
 */
const START = Date.parse("2026-03-02T14:00:00Z");
const END = START + 30 * 60_000;
const minute = 60_000;
const source = { blockId: "b1", taskId: "t1", endAt: END };

test("a new session runs to the block's end and counts the focus time", () => {
  const session = startFocus(source, START);
  assert.deepEqual(session, { blockId: "b1", taskId: "t1", endAt: END, startedAt: START, pausedMs: 0 });
  assert.equal(focusStatus(session, START), "running");
  assert.equal(remainingMs(session, START), 30 * minute);
  assert.equal(focusedMs(session, START), 0);
  assert.equal(remainingMs(session, START + 10 * minute), 20 * minute);
  assert.equal(focusedMs(session, START + 10 * minute), 10 * minute);
});

test("a block without a linked task has no task id at all", () => {
  const session = startFocus({ blockId: "b2", endAt: END }, START);
  assert.equal(session.taskId, undefined);
  assert.equal("taskId" in session, false);
});

test("a pause freezes both clocks until the resume, which excludes the gap", () => {
  const running = startFocus(source, START);
  const paused = pauseFocus(running, START + 10 * minute);
  assert.equal(focusStatus(paused, START + 10 * minute), "paused");
  /* Ten minutes later the freeze still reads ten minutes in and twenty left. */
  assert.equal(focusedMs(paused, START + 20 * minute), 10 * minute);
  assert.equal(remainingMs(paused, START + 20 * minute), 20 * minute);

  const resumed = resumeFocus(paused, START + 20 * minute);
  assert.equal(resumed.pausedAt, undefined);
  assert.equal(resumed.pausedMs, 10 * minute);
  assert.equal(focusStatus(resumed, START + 20 * minute), "running");
  /* The clock did not stop: the countdown continues to the block's end. */
  assert.equal(remainingMs(resumed, START + 20 * minute), 10 * minute);
  assert.equal(focusedMs(resumed, START + 20 * minute), 10 * minute);
  assert.equal(focusedMs(resumed, START + 25 * minute), 15 * minute);

  /* Pausing twice without a resume, or resuming while running, changes nothing. */
  assert.equal(pauseFocus(paused, START + 30 * minute), paused);
  assert.equal(resumeFocus(running, START + 30 * minute), running);
});

test("several pauses accumulate and are all excluded from the focused time", () => {
  let session = startFocus(source, START);
  session = pauseFocus(session, START + 5 * minute);
  session = resumeFocus(session, START + 8 * minute);
  session = pauseFocus(session, START + 12 * minute);
  session = resumeFocus(session, START + 15 * minute);
  session = pauseFocus(session, START + 20 * minute);
  assert.equal(session.pausedMs, 6 * minute);
  /* Five minutes of focus, then four, then five, and the last pause froze it. */
  assert.equal(focusedMs(session, START + 29 * minute), 14 * minute);
  assert.equal(focusedMs(resumeFocus(session, START + 21 * minute), START + 21 * minute), 14 * minute);
});

test("stopping reports the focused time and the session is the caller's to drop", () => {
  const session = resumeFocus(pauseFocus(startFocus(source, START), START + 10 * minute), START + 25 * minute);
  assert.deepEqual(stopFocus(session, START + 27 * minute), { blockId: "b1", taskId: "t1", focusedMs: 12 * minute });
  /* A stop takes the bit-for-bit report of a session that never paused. */
  assert.deepEqual(stopFocus(startFocus({ blockId: "b2", endAt: END }, START), START + 4 * minute), {
    blockId: "b2",
    focusedMs: 4 * minute,
  });
});

test("the block's end makes the session done and freezes its numbers", () => {
  const session = startFocus(source, START);
  assert.equal(remainingMs(session, END), 0);
  assert.equal(focusStatus(session, END), "done");
  assert.equal(focusedMs(session, END), 30 * minute);
  /* Ten minutes past the end nothing grows any more, and a stale pause does not
     turn the block back into a running one. */
  assert.equal(focusedMs(session, END + 10 * minute), 30 * minute);
  assert.equal(focusStatus(pauseFocus(session, END + 10 * minute), END + 10 * minute), "done");
});

test("a clock that steps backwards never yields negative or inflated time", () => {
  const session = startFocus(source, START);
  /* An hour before the session started: nothing focused, and the countdown never
     reads longer than the block itself. */
  assert.equal(focusedMs(session, START - 60 * minute), 0);
  assert.equal(remainingMs(session, START - 60 * minute), 30 * minute);
  const paused = pauseFocus(session, START - 60 * minute);
  assert.equal(paused.pausedAt, START, "a pause cannot start before the session did");
  const resumed = resumeFocus(paused, START - 30 * minute);
  assert.equal(resumed.pausedMs, 0);
  assert.equal(focusedMs(resumed, START + 5 * minute), 5 * minute);
  /* A stored pause whose accumulation exceeds the elapsed time is clamped. */
  const skewed = { ...session, pausedMs: 90 * minute };
  assert.equal(focusedMs(skewed, START + 5 * minute), 0);
});

test("a session survives a reload through its stored form", () => {
  const paused = pauseFocus(startFocus(source, START), START + 10 * minute);
  assert.deepEqual(parseSession(serializeSession(paused)), paused);
  assert.deepEqual(parseSession(serializeSession(startFocus(source, START))), startFocus(source, START));
  /* Restored ten minutes later, the pause still holds both numbers. */
  const restored = parseSession(serializeSession(paused))!;
  assert.equal(focusedMs(restored, START + 40 * minute), 10 * minute);
  assert.equal(remainingMs(restored, START + 40 * minute), 20 * minute);
});

test("the stored form is rejected when it cannot be trusted", () => {
  const session = startFocus(source, START);
  for (const raw of [
    null,
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...session, blockId: "" }),
    JSON.stringify({ ...session, endAt: "1772452800000" }),
    JSON.stringify({ ...session, startedAt: Number.NaN }),
    JSON.stringify({ ...session, pausedMs: -1 }),
    JSON.stringify({ ...session, pausedMs: 1.5 }),
    JSON.stringify({ ...session, pausedAt: "now" }),
    JSON.stringify({ ...session, taskId: 7 }),
    JSON.stringify({ endAt: END, startedAt: START }),
  ]) {
    assert.equal(parseSession(raw), null, `rejected: ${String(raw)}`);
  }
});

test("remaining time is hours and minutes, then minutes and seconds", () => {
  assert.equal(formatRemaining(30 * minute), "0:30");
  assert.equal(formatRemaining(90 * minute), "1:30");
  assert.equal(formatRemaining(5 * minute + 1000), "0:05");
  /* The five-minute boundary belongs to the coarse form: 5:00 left reads
     "0:05", and a second later the seconds appear. */
  assert.equal(formatRemaining(5 * minute), "0:05");
  assert.equal(formatRemaining(4 * minute + 59_000), "04:59");
  assert.equal(formatRemaining(9_000), "00:09");
  assert.equal(formatRemaining(0), "00:00");
  /* A clock past the block's end is a zero, never a negative. */
  assert.equal(formatRemaining(-5_000), "00:00");
});

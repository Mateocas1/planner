import assert from "node:assert/strict";
import test from "node:test";
import { startFocus, type FocusSession } from "./focus.ts";
import {
  MAX_IDLE_THRESHOLD_MINUTES,
  MIN_IDLE_THRESHOLD_MINUTES,
  appliedKeyOf,
  awayMinutesOf,
  awayEnd,
  awayStart,
  clipAwaySpan,
  clampSubtraction,
  consumePendingSubtraction,
  isApplied,
  isIdle,
  markApplied,
  readIdleThreshold,
  savePendingSubtraction,
  sessionKeyOf,
  writeIdleThreshold,
  type KeyValueStorage,
} from "./idle.ts";

/**
 * The away accounting's rules, proved without a DOM, a clock or a poller:
 * every assertion passes its instants in, so "eleven minutes away" is a
 * number here and never a wait. These are the data-safety boundaries of T9:
 * nothing outside the session's focus can be counted, no counter can be
 * driven negative, and one confirmation applies exactly once.
 */
const minute = 60_000;
const START = Date.parse("2026-03-02T14:00:00Z");
const END = START + 30 * minute;

function sessionAt(start: number, end: number = END): FocusSession {
  return startFocus({ blockId: "b1", taskId: "t1", endAt: end }, start);
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: key => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
  };
}

/* ---------------------------- threshold ---------------------------- */

test("the away threshold fires at exactly ten minutes and not before", () => {
  assert.equal(isIdle(600, 10), true); // exactly 10 min
  assert.equal(isIdle(599, 10), false); // 9:59
  assert.equal(isIdle(3600, 60), true); // upper setting bound
});

test("the threshold setting is clamped into 5–60 and falls back on nonsense", () => {
  const storage = memoryStorage();
  assert.equal(readIdleThreshold(undefined), 10);
  assert.equal(readIdleThreshold(storage), 10); // unset
  writeIdleThreshold(3, storage);
  assert.equal(readIdleThreshold(storage), MIN_IDLE_THRESHOLD_MINUTES);
  writeIdleThreshold(90, storage);
  assert.equal(readIdleThreshold(storage), MAX_IDLE_THRESHOLD_MINUTES);
  writeIdleThreshold(25, storage);
  assert.equal(readIdleThreshold(storage), 25);
  storage.setItem("planner-idle-threshold", "soon");
  assert.equal(readIdleThreshold(storage), 10); // garbage -> default
  storage.setItem("planner-idle-threshold", "12.5");
  assert.equal(readIdleThreshold(storage), 10); // not a whole minute -> default
});

/* --------------------------- span clipping -------------------------- */

test("a span opens at now minus the reported idle", () => {
  assert.equal(awayStart(END, 660), END - 11 * minute);
});

test("an away span ends at the last input, not at the poll that noticed the return", () => {
  // The poll at 14:30 sees 20 s of idle: the user came back at 14:29:40.
  assert.equal(awayEnd(START + 30 * minute, 20), START + 30 * minute - 20_000);
  // Input during the poll itself: the span ends at the poll instant.
  assert.equal(awayEnd(START + 30 * minute, 0), START + 30 * minute);
});

test("a span crossing the session start is clipped to it", () => {
  const session = sessionAt(START, END);
  // Away from 13:50 (10 min before the session began) to 14:05.
  const span = clipAwaySpan({ from: START - 10 * minute, to: START + 5 * minute }, session, START + 5 * minute);
  assert.deepEqual(span, { from: START, to: START + 5 * minute });
});

test("idle reported larger than the whole session counts only the session's focus", () => {
  const session = sessionAt(START, END);
  // Away from 13:40 to 14:40 while the session ran 14:00–14:30: only 30 min.
  const span = clipAwaySpan({ from: START - 20 * minute, to: END + 10 * minute }, session, END + 10 * minute);
  assert.deepEqual(span, { from: START, to: END });
});

test("away time after the block's end is never counted", () => {
  const session = sessionAt(START, END);
  // The user returned at 14:40, well after the block ended at 14:30.
  const span = clipAwaySpan({ from: END - 12 * minute, to: END + 10 * minute }, session, END + 10 * minute);
  assert.deepEqual(span, { from: END - 12 * minute, to: END });
});

test("a paused session's clock is frozen at the pause, so a later span clips to nothing", () => {
  const session = { ...sessionAt(START, END), pausedAt: START + 3 * minute };
  // The poller does not run while paused; a stale span must not count either.
  const span = clipAwaySpan({ from: START + 5 * minute, to: START + 15 * minute }, session, START + 20 * minute);
  assert.equal(span, null);
});

test("a span entirely outside the session counts nothing", () => {
  const session = sessionAt(START, END);
  assert.equal(clipAwaySpan({ from: START - 20 * minute, to: START - 5 * minute }, session, START), null);
  assert.equal(clipAwaySpan({ from: END + 5 * minute, to: END + 20 * minute }, session, END + 20 * minute), null);
});

/* ---------------------------- summing ------------------------------ */

test("several away spans in one session are summed into whole minutes", () => {
  // Two spans: 9.5 min + 10.5 min -> 20 (floored once on the sum, not twice).
  const minutes = awayMinutesOf([
    { from: START, to: START + 9.5 * minute },
    { from: START + 20 * minute, to: START + 30.5 * minute },
  ]);
  assert.equal(minutes, 20);
});

test("a total under a whole minute stays silent", () => {
  assert.equal(awayMinutesOf([{ from: START, to: START + 59_000 }]), 0);
});

test("nine minutes and fifty-nine seconds away is nine minutes", () => {
  assert.equal(awayMinutesOf([{ from: START, to: START + 9 * minute + 59_000 }]), 9);
});

/* ---------------------------- clamping ------------------------------ */

test("the subtraction can never exceed what the session recorded", () => {
  assert.equal(clampSubtraction(12, 9, 40), 9);
  assert.equal(clampSubtraction(12, 0, 40), 0); // nothing recorded
});

test("the subtraction can never drive the task's counter negative", () => {
  assert.equal(clampSubtraction(12, 30, 5), 5); // counter wins over the session
  assert.equal(clampSubtraction(12, 30, 0), 0); // clamp at zero
  // Session still running: its minutes are not in the counter yet, so the
  // span's own bound (clipped to the session's focus) is the limit; the stop
  // write floors the result at zero.
  assert.equal(clampSubtraction(12, null, 0), 12);
  assert.equal(clampSubtraction(12, null, 4), 12);
  assert.equal(clampSubtraction(4.9, null, 0), 4); // whole minutes, floored
  assert.equal(clampSubtraction(40, 50, 3), 3); // larger than the counter: clamps
  assert.equal(clampSubtraction(-3, 30, 50), 0); // never negative itself
});

/* --------------------- idempotency and pending ---------------------- */

test("a session is identified by its block and its start instant", () => {
  const key = sessionKeyOf({ blockId: "b1", startedAt: START });
  assert.equal(key, `b1@${START}`);
  assert.notEqual(key, sessionKeyOf({ blockId: "b1", startedAt: START + 1 }));
  assert.notEqual(key, sessionKeyOf({ blockId: "b2", startedAt: START }));
});

test("an applied subtraction is recorded once and survives a reload", () => {
  const storage = memoryStorage();
  const spans = [{ from: START, to: START + 11 * minute }];
  const key = appliedKeyOf("b1@1", spans);
  assert.equal(isApplied(key, storage), false);
  markApplied(key, storage);
  assert.equal(isApplied(key, storage), true);
  // A fresh storage object fed the same persisted value: the reload case.
  const reloaded = memoryStorage();
  reloaded.setItem("planner-idle-applied", storage.getItem("planner-idle-applied") as string);
  assert.equal(isApplied(key, reloaded), true);
});

test("the same spans always produce the same applied key", () => {
  const spans = [
    { from: 5, to: 10 },
    { from: 20, to: 30 },
  ];
  assert.equal(appliedKeyOf("b1@1", spans), appliedKeyOf("b1@1", [...spans]));
  assert.notEqual(appliedKeyOf("b1@1", spans), appliedKeyOf("b1@2", spans));
  assert.notEqual(appliedKeyOf("b1@1", spans), appliedKeyOf("b1@1", [{ from: 5, to: 11 }]));
});

test("a pending subtraction is consumed exactly once", () => {
  const storage = memoryStorage();
  savePendingSubtraction("b1@1", 12, storage);
  savePendingSubtraction("b1@1", 5, storage); // a later, disjoint confirmation adds up
  assert.equal(consumePendingSubtraction("b1@1", storage), 17);
  assert.equal(consumePendingSubtraction("b1@1", storage), 0); // gone
  savePendingSubtraction("b1@2", 7, storage); // other sessions are untouched
  assert.equal(consumePendingSubtraction("b1@2", storage), 7);
});

test("a stale pending subtraction from a lost session is dropped", () => {
  const storage = memoryStorage();
  // Two days and a minute ago: the session ended without reporting.
  const stale = JSON.stringify({ "b1@0": { minutes: 12, at: Date.now() - 48 * minute * 60 - 60_000 } });
  storage.setItem("planner-idle-pending", stale);
  savePendingSubtraction("b1@1", 5, storage);
  assert.equal(consumePendingSubtraction("b1@0", storage), 0);
  assert.equal(consumePendingSubtraction("b1@1", storage), 5);
});

test("corrupted storage reads as empty, never as a throw", () => {
  const storage = memoryStorage();
  storage.setItem("planner-idle-pending", "{not json");
  storage.setItem("planner-idle-applied", "42");
  assert.equal(consumePendingSubtraction("b1@1", storage), 0);
  assert.equal(isApplied("b1@1", storage), false);
  markApplied("b1@1", storage); // overwrites the corrupted ledger
  assert.equal(isApplied("b1@1", storage), true);
});

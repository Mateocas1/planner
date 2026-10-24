import assert from "node:assert/strict";
import test from "node:test";
import { startFocus, pauseFocus, type FocusSession } from "./focus.ts";
import { appliedKeyOf, consumePendingSubtraction, isApplied, sessionKeyOf, type KeyValueStorage } from "./idle.ts";
import {
  closeAway,
  confirmAway,
  emptyBooks,
  keepAway,
  minutesToRecord,
  openAway,
  type AwayPromptSnapshot,
} from "./idleFlow.ts";

/**
 * The confirm / keep flow and the span books of `useIdleAway`, without React:
 * every effect (storage, the Firestore write) is a spy, so "writes nothing"
 * and "exactly once" are assertions on what was called.
 */
const minute = 60_000;
const START = Date.parse("2026-03-02T14:00:00Z");
const END = START + 60 * minute;

function sessionAt(start: number = START): FocusSession {
  return startFocus({ blockId: "b1", taskId: "t1", endAt: END }, start);
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: key => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
  };
}

function promptFor(session: FocusSession, minutes: number, recorded: number | null): AwayPromptSnapshot {
  const sessionKey = sessionKeyOf(session);
  const spans = [{ from: session.startedAt + 5 * minute, to: session.startedAt + (5 + minutes) * minute }];
  return { key: appliedKeyOf(sessionKey, spans), sessionKey, taskId: "t1", minutes, recorded };
}

function spyWrite() {
  const calls: Array<{ taskId: string; minutes: number }> = [];
  return {
    calls,
    write: (taskId: string, minutes: number) => {
      calls.push({ taskId, minutes });
      return Promise.resolve();
    },
  };
}

/* ------------------- the minutes a stop records -------------------- */

test("a confirmed away reduces the recorded minutes exactly by the away minutes", () => {
  assert.equal(minutesToRecord(30, 12), 18);
  assert.equal(minutesToRecord(30, 0), 30); // nothing confirmed: unchanged
});

test("the recorded minutes never go below zero", () => {
  assert.equal(minutesToRecord(10, 25), 0);
});

test("a pending subtraction is folded into the stop write once and then gone", () => {
  const storage = memoryStorage();
  const session = sessionAt();
  const sink = spyWrite();
  const books = openAway(emptyBooks(), session.startedAt + 5 * minute);
  const closed = closeAway(books, session, session.startedAt + 17 * minute);
  const prompt = promptFor(session, 12, null);
  confirmAway(closed, prompt, 99, { storage, write: sink.write });

  assert.equal(sink.calls.length, 0); // the session has not reported: no second write
  const away = consumePendingSubtraction(sessionKeyOf(session), storage);
  assert.equal(minutesToRecord(30, away), 18);
  // Consumed: a second stop of the same session subtracts nothing.
  assert.equal(minutesToRecord(30, consumePendingSubtraction(sessionKeyOf(session), storage)), 30);
});

/* --------------------------- confirm / keep ------------------------ */

test("Keep writes nothing and spends the session's spans", () => {
  const storage = memoryStorage();
  const sink = spyWrite();
  const session = sessionAt();
  const books = closeAway(openAway(emptyBooks(), session.startedAt + 5 * minute), session, session.startedAt + 17 * minute);
  assert.equal(books.spans.length, 1);
  const after = keepAway(books);
  assert.deepEqual(after, emptyBooks());
  assert.equal(sink.calls.length, 0);
  assert.equal(isApplied(promptFor(session, 12, 30).key, storage), false);
  assert.equal(consumePendingSubtraction(sessionKeyOf(session), storage), 0);
});

test("Subtract after the session reported writes one subtraction and marks the ledger", () => {
  const storage = memoryStorage();
  const sink = spyWrite();
  const session = sessionAt();
  const prompt = promptFor(session, 12, 30);
  const first = confirmAway(emptyBooks(), prompt, 40, { storage, write: sink.write });
  assert.deepEqual(sink.calls, [{ taskId: "t1", minutes: 12 }]);
  assert.equal(first.outcome, "written");
  assert.equal(isApplied(prompt.key, storage), true);
  // A second press of the same prompt writes nothing more.
  confirmAway(emptyBooks(), prompt, 40, { storage, write: sink.write });
  assert.equal(sink.calls.length, 1);
});

test("the ledger is not marked when nothing is subtractable", () => {
  const storage = memoryStorage();
  const sink = spyWrite();
  const session = sessionAt();
  const prompt = promptFor(session, 12, 0); // the session recorded nothing
  const result = confirmAway(emptyBooks(), prompt, 40, { storage, write: sink.write });
  assert.equal(result.outcome, "none");
  assert.equal(sink.calls.length, 0);
  assert.equal(isApplied(prompt.key, storage), false);
});

test("a subtraction larger than the task's counter clamps at zero", () => {
  const storage = memoryStorage();
  const sink = spyWrite();
  const session = sessionAt();
  confirmAway(emptyBooks(), promptFor(session, 20, 30), 7, { storage, write: sink.write });
  assert.deepEqual(sink.calls, [{ taskId: "t1", minutes: 7 }]);
  // A counter of zero leaves nothing to subtract.
  const zeroSink = spyWrite();
  const zeroResult = confirmAway(emptyBooks(), promptFor(session, 20, 30), 0, { storage: memoryStorage(), write: zeroSink.write });
  assert.equal(zeroResult.outcome, "none");
  assert.equal(zeroSink.calls.length, 0);
});

test("without a user or task there is no write, and the ledger stays clean", () => {
  const storage = memoryStorage();
  const session = sessionAt();
  const prompt = promptFor(session, 12, 30);
  const result = confirmAway(emptyBooks(), prompt, 40, { storage, write: undefined });
  assert.equal(result.outcome, "none");
  assert.equal(isApplied(prompt.key, storage), false);
});

test("a confirmed prompt drops its spans so a stop-while-idle cannot re-offer them", () => {
  const storage = memoryStorage();
  const sink = spyWrite();
  const session = sessionAt();
  // First absence closed and confirmed.
  let books = closeAway(openAway(emptyBooks(), session.startedAt + 5 * minute), session, session.startedAt + 17 * minute);
  const prompt = promptFor(session, 12, null);
  books = confirmAway(books, prompt, 40, { storage, write: sink.write }).books;
  assert.deepEqual(books.spans, []);
  // A second absence still open when the session stops: the prompt covers
  // only the new span, never the confirmed 12 minutes again.
  books = openAway(books, session.startedAt + 30 * minute);
  books = closeAway(books, session, session.startedAt + 35 * minute);
  assert.equal(books.spans.length, 1);
  assert.equal(books.spans[0]?.to - (books.spans[0]?.from ?? 0), 5 * minute);
});

test("two confirmations in one running session add up instead of overwriting", () => {
  const storage = memoryStorage();
  const session = sessionAt();
  const first = promptFor(session, 12, null);
  confirmAway(emptyBooks(), first, 99, { storage, write: undefined });
  const secondSpans = [{ from: session.startedAt + 30 * minute, to: session.startedAt + 35 * minute }];
  const second: AwayPromptSnapshot = {
    ...first,
    key: appliedKeyOf(first.sessionKey, secondSpans),
    minutes: 5,
  };
  confirmAway(emptyBooks(), second, 99, { storage, write: undefined });
  assert.equal(consumePendingSubtraction(sessionKeyOf(session), storage), 17);
});

/* --------------------------- pause handling ------------------------ */

test("an open absence is closed at the pause instant; paused time is never away", () => {
  const session = sessionAt();
  const open = openAway(emptyBooks(), session.startedAt + 5 * minute);
  const paused = pauseFocus(session, session.startedAt + 10 * minute);
  // The pause is observed 15 minutes later; the span must still end at the pause.
  const closed = closeAway(open, paused, session.startedAt + 25 * minute);
  assert.deepEqual(closed.spans, [{ from: session.startedAt + 5 * minute, to: session.startedAt + 10 * minute }]);
  assert.equal(closed.openFrom, null);
});

test("an open absence that begins and ends inside a pause leaves nothing", () => {
  const session = sessionAt();
  const paused = pauseFocus(session, session.startedAt + 10 * minute);
  const open = openAway(emptyBooks(), session.startedAt + 12 * minute);
  assert.deepEqual(closeAway(open, paused, session.startedAt + 20 * minute).spans, []);
});

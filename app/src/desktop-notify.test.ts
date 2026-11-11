import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyNotified,
  applyShutdownNotified,
  applySnooze,
  applyWeeklyNotified,
  dueReminders,
  emptyNotifyState,
  parseNotifySettings,
  parseNotifyState,
  pruneNotifyState,
  reminderKey,
  reminderLeadMs,
  serializeNotifyState,
  shutdownNudgeDue,
  snoozeMs,
  weeklyNudgeDue,
  weeklyNudgeKey,
  type NotifyState,
} from "./desktop-notify.ts";

const t0 = Date.parse("2026-10-23T09:00:00Z");
const at = (offsetMinutes: number) => t0 + offsetMinutes * 60_000;
const iso = (offsetMinutes: number) => new Date(at(offsetMinutes)).toISOString();
const block = (id: string, from: number, to: number) => ({ id, start: iso(from), end: iso(to) });

test("the first reminder is due from two minutes before the start until the block starts", () => {
  const blocks = [block("b1", 60, 120)];
  assert.deepEqual(dueReminders(blocks, at(57), emptyNotifyState()), []);
  assert.deepEqual(dueReminders(blocks, at(58), emptyNotifyState()).map(reminder => reminder.kind), ["start"]);
  assert.deepEqual(dueReminders(blocks, at(59.9), emptyNotifyState()).map(reminder => reminder.key), [reminderKey(blocks[0])]);
  // The block started: a missed reminder is not sent late.
  assert.deepEqual(dueReminders(blocks, at(60), emptyNotifyState()), []);
  assert.deepEqual(dueReminders(blocks, at(90), emptyNotifyState()), []);
});

test("a block start is never notified twice, whatever the tick timing", () => {
  const blocks = [block("b1", 60, 120)];
  const state = applyNotified(emptyNotifyState(), reminderKey(blocks[0]));
  assert.deepEqual(dueReminders(blocks, at(59), state), []);
});

test("moving a block re-arms its reminder: the dedupe key is id plus start", () => {
  const before = block("b1", 60, 120);
  const after = { id: "b1", start: iso(90), end: iso(150) };
  const state = applyNotified(emptyNotifyState(), reminderKey(before));
  // The old start is long past; the new start's reminder is due in its window.
  assert.deepEqual(dueReminders([after], at(88), state).map(reminder => reminder.key), [reminderKey(after)]);
  // An edit that does not move the start changes nothing.
  const sameStart = { ...before, end: iso(130) };
  assert.deepEqual(dueReminders([sameStart], at(59), state), []);
});

test("a snoozed reminder fires when asked, even past the block start", () => {
  // The checklist's exact case: block starts 3 min out, toast at 2 min to
  // go, +5 min pressed, the re-toast lands 4 min after the start.
  const blocks = [block("b1", 3, 63)];
  const state = applySnooze(emptyNotifyState(), reminderKey(blocks[0]), t0);
  assert.deepEqual(dueReminders(blocks, at(1), state), []);
  const due = dueReminders(blocks, at(5), state);
  assert.deepEqual(due.map(reminder => reminder.kind), ["snoozed"]);
  assert.deepEqual(due.map(reminder => reminder.key), [reminderKey(blocks[0])]);
});

test("a fired reminder leaves the snooze behind and cannot fire twice", () => {
  const blocks = [block("b1", 3, 63)];
  const snoozed = applySnooze(emptyNotifyState(), reminderKey(blocks[0]), t0);
  const fired = applyNotified(snoozed, reminderKey(blocks[0]));
  assert.deepEqual(dueReminders(blocks, at(10), fired), []);
  assert.deepEqual(fired.snoozed, {});
  assert.deepEqual(fired.notified, [reminderKey(blocks[0])]);
});

test("a deleted or finished block never fires its snoozed reminder", () => {
  const kept = block("b1", 3, 63);
  const deleted = block("b2", 3, 63);
  let state = applySnooze(emptyNotifyState(), reminderKey(deleted), t0);
  assert.deepEqual(dueReminders([kept], at(5), state), []);
  // The block still exists but is already over: no toast either.
  state = applySnooze(state, reminderKey(kept), t0);
  assert.deepEqual(dueReminders([kept], at(64), state), []);
});

test("prune drops past dedupe keys and snoozes for deleted blocks", () => {
  const past = block("b1", -30, 30);
  const future = block("b2", 60, 120);
  const deleted = block("b3", 60, 120);
  let state: NotifyState = {
    notified: [reminderKey(past), reminderKey(future)],
    snoozed: { [reminderKey(deleted)]: at(5), [reminderKey(future)]: at(5) },
    weeklyKeys: [],
  };
  state = pruneNotifyState(state, [future], at(0));
  assert.deepEqual(state.notified, [reminderKey(future)]);
  assert.deepEqual(state.snoozed, { [reminderKey(future)]: at(5) });
});

test("parse tolerates garbage and round-trips through serialize", () => {
  assert.deepEqual(parseNotifyState(null), emptyNotifyState());
  assert.deepEqual(parseNotifyState("not json"), emptyNotifyState());
  assert.deepEqual(parseNotifyState("42"), emptyNotifyState());
  const state = parseNotifyState(JSON.stringify({
    notified: ["a@x", 7, null],
    snoozed: { "b@y": 123, "c@z": "no" },
    shutdownDay: "2026-10-23",
  }));
  assert.deepEqual(state, { notified: ["a@x"], snoozed: { "b@y": 123 }, shutdownDay: "2026-10-23", weeklyKeys: [] });
  assert.deepEqual(parseNotifyState(serializeNotifyState(state)), state);
});

test("settings parse to both-on by default and keep explicit toggles", () => {
  assert.deepEqual(parseNotifySettings(null), { blockReminders: true, shutdownNudge: true });
  assert.deepEqual(parseNotifySettings("{bad"), { blockReminders: true, shutdownNudge: true });
  assert.deepEqual(parseNotifySettings("{}"), { blockReminders: true, shutdownNudge: true });
  assert.deepEqual(parseNotifySettings('{"blockReminders":false,"shutdownNudge":false}'), {
    blockReminders: false,
    shutdownNudge: false,
  });
});

test("the shutdown nudge reuses the banner's rule, at most once per day", () => {
  const base = { today: "2026-10-23", wallMinutes: 21 * 60, shutdownTime: 21 * 60 };
  const state = emptyNotifyState();
  // At the shutdown minute the banner is up, so the nudge is due...
  assert.equal(shutdownNudgeDue({ ...base, state }), true);
  // ...and once it fired, never again that day.
  const closed = applyShutdownNotified(state, base.today);
  assert.equal(shutdownNudgeDue({ ...base, state: closed }), false);
  // A new day re-arms it.
  assert.equal(shutdownNudgeDue({ ...base, today: "2026-10-24", state: closed }), true);
  // Before the shutdown minute there is nothing to nudge about.
  assert.equal(shutdownNudgeDue({ ...base, wallMinutes: 20 * 60 + 59, state }), false);
  // The day was already closed: the banner is down and so is the nudge.
  assert.equal(shutdownNudgeDue({ ...base, lastShutdown: "2026-10-23", state }), false);
});

test("the lead and snooze constants are the spec's two and five minutes", () => {
  assert.equal(reminderLeadMs, 2 * 60_000);
  assert.equal(snoozeMs, 5 * 60_000);
});

/* ---------- the weekly review's nudge ---------- */

const moment = { week: "2026-W43", day: 5, time: 17 * 60 };

function weeklyState(): NotifyState {
  return { ...emptyNotifyState(), weeklyKeys: [] };
}

test("the weekly toast fires once per week and moment, and reads stored keys", () => {
  const base = { due: moment, today: "2026-10-23", state: weeklyState() };
  // Due: the key comes back, the same one the draw records.
  const key = weeklyNudgeDue(base);
  assert.equal(key, weeklyNudgeKey(moment));
  const after = applyWeeklyNotified(weeklyState(), key!);
  // The same moment never fires twice...
  assert.equal(weeklyNudgeDue({ ...base, state: after }), null);
  // ...but another moment of the week is its own toast.
  assert.equal(weeklyNudgeDue({ ...base, due: { week: "2026-W43", day: 0, time: 19 * 60 }, state: after }), weeklyNudgeKey({ week: "2026-W43", day: 0, time: 19 * 60 }));
  // A new week re-arms every moment.
  assert.equal(weeklyNudgeDue({ ...base, due: { ...moment, week: "2026-W44" }, state: after }), weeklyNudgeKey({ ...moment, week: "2026-W44" }));
});

test("the weekly toast stays quiet when nothing is due or the day was closed", () => {
  const state = weeklyState();
  // No due moment, no toast.
  assert.equal(weeklyNudgeDue({ due: null, today: "2026-10-23", state }), null);
  // The shutdown ritual closed the day: it ended with "Close the week too?",
  // so a toast would be the second nudge the week no longer needs. The banner
  // stays the quiet path.
  assert.equal(weeklyNudgeDue({ due: moment, today: "2026-10-23", lastShutdown: "2026-10-23", state }), null);
  assert.equal(weeklyNudgeDue({ due: moment, today: "2026-10-23", lastShutdown: "2026-10-25", state }), null);
  // A yesterday's close says nothing about today.
  assert.equal(weeklyNudgeDue({ due: moment, today: "2026-10-23", lastShutdown: "2026-10-22", state }), weeklyNudgeKey(moment));
  // A mangled stamp is not a close.
  assert.equal(weeklyNudgeDue({ due: moment, today: "2026-10-23", lastShutdown: "garbage", state }), weeklyNudgeKey(moment));
});

test("the weekly key list stays bounded and parses from storage", () => {
  let state = weeklyState();
  for (let index = 0; index < 20; index += 1) {
    state = applyWeeklyNotified(state, `k${index}`);
  }
  assert.equal(state.weeklyKeys.length, 8);
  assert.equal(state.weeklyKeys[0], "k12");
  const parsed = parseNotifyState(JSON.stringify({ weeklyKeys: ["a", 5, "b"] }));
  assert.deepEqual(parsed.weeklyKeys, ["a", "b"]);
  assert.deepEqual(parseNotifyState(null).weeklyKeys, []);
});

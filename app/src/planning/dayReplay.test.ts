import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDayReplay,
  MAX_REPLAY_ROWS,
  replayTimeline,
  type DayReplay,
  type ReplayBlock,
  type ReplayTask,
} from "./dayReplay.ts";

/**
 * The day replay's pure half (Ronda 8 U1): the plan-versus-actual diff of one
 * profile-zone day and the timeline the stage plays.
 *
 * Fixtures are zoned instants in an explicit zone, because positions are
 * elapsed minutes since the zone's own midnight: a DST day is still one
 * calendar day, 23 or 25 hours wide.
 */

const madrid = "Europe/Madrid";
const day = "2026-11-06";

/** A Madrid CET (+01:00) instant on the test day. */
function at(time: string, date = day): string {
  return `${date}T${time}:00+01:00`;
}

function task(id: string, overrides: Partial<ReplayTask> = {}): ReplayTask {
  return { id, title: id, completed: false, ...overrides };
}

function tracked(id: string, minutes: number, overrides: Partial<ReplayTask> = {}): ReplayTask {
  return task(id, { actualByDay: { [day]: minutes }, ...overrides });
}

function block(id: string, start: string, end: string, overrides: Partial<ReplayBlock> = {}): ReplayBlock {
  return { id, start: at(start), end: at(end), ...overrides };
}

function replay(input: {
  tasks?: ReplayTask[];
  blocks?: ReplayBlock[];
  plan?: ReplayBlock[];
  day?: string;
  timeZone?: string;
}): DayReplay | null {
  return buildDayReplay({ day, timeZone: madrid, tasks: [], blocks: [], ...input });
}

function only(result: DayReplay | null) {
  assert.ok(result, "expected a replay");
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

/* ---------- the diff ---------- */

test("without a snapshot the plan is today's blocks: a longer session stretches", () => {
  const row = only(replay({
    tasks: [tracked("report", 90)],
    blocks: [block("b1", "09:00", "10:00", { taskId: "report" })],
  }));
  assert.equal(row.key, "task:report");
  assert.equal(row.outcome, "stretched");
  assert.deepEqual(row.plan, { start: 540, end: 600 });
  assert.deepEqual(row.actual, { start: 540, end: 630 });
  assert.equal(row.plannedMinutes, 60);
  assert.equal(row.actualMinutes, 90);
  assert.equal(row.placed, true);
});

test("without a snapshot a block cannot have moved and an untracked block is struck, not added", () => {
  const result = replay({
    tasks: [task("report")],
    blocks: [block("b1", "09:00", "10:00", { taskId: "report" }), block("b2", "11:00", "12:00", { title: "Gym" })],
  });
  assert.ok(result);
  assert.deepEqual(result.rows.map(row => [row.key, row.outcome]), [
    ["task:report", "struck"],
    ["block:b2", "unchanged"],
  ]);
});

test("a block now at another time of day is moved, with the ghost at the planned start", () => {
  const row = only(replay({
    tasks: [tracked("review", 60)],
    plan: [block("b1", "09:00", "10:00", { taskId: "review" })],
    blocks: [block("b1", "14:00", "15:00", { taskId: "review" })],
  }));
  assert.equal(row.outcome, "moved");
  assert.deepEqual(row.plan, { start: 540, end: 600 });
  assert.deepEqual(row.actual, { start: 840, end: 900 });
});

test("a move under five minutes is not a move", () => {
  const result = replay({
    tasks: [tracked("review", 60)],
    plan: [block("b1", "09:00", "10:00", { taskId: "review" })],
    blocks: [block("b1", "09:04", "10:04", { taskId: "review" })],
  });
  assert.equal(only(result).outcome, "unchanged");
  assert.equal(result?.changedCount, 0);
});

test("tracked time over the plan stretches and under it shrinks, by five minutes or more", () => {
  const result = replay({
    tasks: [tracked("long", 75), tracked("short", 40), tracked("close", 63)],
    blocks: [
      block("b1", "09:00", "10:00", { taskId: "long" }),
      block("b2", "10:00", "11:00", { taskId: "short" }),
      block("b3", "11:00", "12:00", { taskId: "close" }),
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.rows.map(row => [row.key, row.outcome]), [
    ["task:long", "stretched"],
    ["task:short", "shrunk"],
    ["task:close", "unchanged"],
  ]);
  assert.deepEqual(result.rows[1].actual, { start: 600, end: 640 });
});

test("a task completed today with no time tracked is done, not struck", () => {
  const row = only(replay({
    tasks: [task("mail", { completed: true, completedAt: at("12:00") })],
    blocks: [block("b1", "11:00", "11:30", { taskId: "mail" })],
  }));
  assert.equal(row.outcome, "unchanged");
  assert.equal(row.done, true);
  assert.deepEqual(row.actual, { start: 660, end: 690 });
});

test("a completion stamped on another day is not done today", () => {
  const row = only(replay({
    tasks: [tracked("mail", 30, { completed: true, completedAt: at("12:00", "2026-11-07") })],
    blocks: [block("b1", "11:00", "11:30", { taskId: "mail" })],
  }));
  assert.equal(row.done, false);
});

test("a planned task whose block was removed and that has no time is struck", () => {
  const row = only(replay({
    tasks: [task("report")],
    plan: [block("b1", "09:00", "10:00", { taskId: "report" })],
    blocks: [],
  }));
  assert.equal(row.outcome, "struck");
  assert.equal(row.actual, null);
  assert.deepEqual(row.plan, { start: 540, end: 600 });
});

test("a removed manual block is struck; an open task with a block left standing and no time is struck", () => {
  const result = replay({
    tasks: [task("report")],
    plan: [block("b1", "09:00", "10:00", { taskId: "report" }), block("b2", "13:00", "14:00", { title: "Lunch" })],
    blocks: [block("b1", "09:00", "10:00", { taskId: "report" })],
  });
  assert.ok(result);
  assert.deepEqual(result.rows.map(row => [row.key, row.outcome, row.label]), [
    ["task:report", "struck", "report"],
    ["block:b2", "struck", "Lunch"],
  ]);
});

test("a planned task that lost its block but was worked keeps its planned start and compares lengths", () => {
  const row = only(replay({
    tasks: [tracked("report", 90)],
    plan: [block("b1", "09:00", "10:00", { taskId: "report" })],
    blocks: [],
  }));
  assert.equal(row.outcome, "stretched");
  assert.deepEqual(row.actual, { start: 540, end: 630 });
});

test("tracked time with no block is added, from the axis origin, claiming no time of day", () => {
  const row = only(replay({ tasks: [tracked("call", 40)] }));
  assert.equal(row.outcome, "added");
  assert.equal(row.placed, false);
  assert.equal(row.plan, null);
  assert.deepEqual(row.actual, { start: 0, end: 40 });
});

test("a block created after the morning snapshot is added and sits on its block", () => {
  const result = replay({
    tasks: [tracked("call", 30)],
    plan: [],
    blocks: [block("b1", "16:00", "16:30", { taskId: "call" }), block("b2", "17:00", "18:00", { title: "Walk" })],
  });
  assert.ok(result);
  assert.deepEqual(result.rows.map(row => [row.key, row.outcome, row.placed]), [
    ["task:call", "added", true],
    ["block:b2", "added", true],
  ]);
  assert.deepEqual(result.rows[0].actual, { start: 960, end: 990 });
});

test("a resized manual block stretches and shrinks", () => {
  const result = replay({
    plan: [block("a", "09:00", "10:00", { title: "A" }), block("b", "11:00", "12:00", { title: "B" })],
    blocks: [block("a", "09:00", "10:30", { title: "A" }), block("b", "11:00", "11:30", { title: "B" })],
  });
  assert.ok(result);
  assert.deepEqual(result.rows.map(row => [row.label, row.outcome, row.plannedMinutes, row.actualMinutes]), [
    ["A", "stretched", 60, 90],
    ["B", "shrunk", 60, 30],
  ]);
  assert.equal(result.trackedMinutes, 0);
});

test("the label comes from the snapshot when the task was deleted", () => {
  const row = only(replay({
    tasks: [],
    plan: [block("b1", "09:00", "10:00", { taskId: "gone", title: "Old report" })],
    blocks: [],
  }));
  assert.equal(row.label, "Old report");
  assert.equal(row.outcome, "struck");
});

test("every block of a task folds into one bar at the first start with the summed length", () => {
  const row = only(replay({
    tasks: [tracked("report", 100)],
    blocks: [block("b1", "09:00", "09:30", { taskId: "report" }), block("b2", "14:00", "14:30", { taskId: "report" })],
  }));
  assert.equal(row.plannedMinutes, 60);
  assert.deepEqual(row.plan, { start: 540, end: 600 });
  assert.equal(row.outcome, "stretched");
});

test("Google Calendar blocks are left out, even from the snapshot", () => {
  const source = { provider: "gcal" as const, calendarId: "c", eventId: "e", updated: "x" };
  const result = replay({
    plan: [block("g1", "09:00", "10:00", { title: "Standup", source })],
    blocks: [block("g1", "10:00", "11:00", { title: "Standup", source })],
  });
  assert.equal(result, null);
});

test("a block crossing midnight counts only the minutes inside the day", () => {
  const row = only(replay({
    tasks: [tracked("deploy", 60)],
    blocks: [{ id: "b1", taskId: "deploy", start: at("23:00"), end: at("01:00", "2026-11-07") }],
  }));
  assert.equal(row.plannedMinutes, 60);
  assert.deepEqual(row.plan, { start: 1380, end: 1440 });
  assert.equal(row.outcome, "unchanged");
});

test("a block that only touches the next day's midnight is outside the day", () => {
  const result = replay({
    blocks: [{ id: "b1", start: at("00:00", "2026-11-07"), end: at("01:00", "2026-11-07") }],
  });
  assert.equal(result, null);
});

test("a fall-back day is 25 hours wide and positions are elapsed minutes from midnight", () => {
  // Madrid 2026-10-25: midnight is CEST (+02:00), 03:00 CEST becomes 02:00 CET.
  const result = buildDayReplay({
    day: "2026-10-25",
    timeZone: madrid,
    tasks: [{ id: "t", title: "t", completed: false, actualByDay: { "2026-10-25": 60 } }],
    blocks: [{ id: "b1", taskId: "t", start: "2026-10-25T08:00:00+01:00", end: "2026-10-25T09:00:00+01:00" }],
  });
  assert.ok(result);
  assert.equal(result.axisMinutes, 1500);
  assert.deepEqual(result.rows[0].plan, { start: 540, end: 600 });
});

test("a spring-forward day is 23 hours wide", () => {
  // Madrid 2026-03-29: midnight is CET (+01:00), 02:00 CET becomes 03:00 CEST.
  const result = buildDayReplay({
    day: "2026-03-29",
    timeZone: madrid,
    tasks: [],
    blocks: [{ id: "b1", start: "2026-03-29T08:00:00+02:00", end: "2026-03-29T09:00:00+02:00", title: "x" }],
  });
  assert.ok(result);
  assert.equal(result.axisMinutes, 1380);
  assert.deepEqual(result.rows[0].plan, { start: 420, end: 480 });
});

test("a malformed block instant is skipped instead of crashing", () => {
  const result = replay({ blocks: [{ id: "b1", start: "nope", end: "nope", title: "x" }] });
  assert.equal(result, null);
});

test("an invalid day key throws", () => {
  assert.throws(() => replay({ day: "2026-02-30" }), /calendar day key/);
});

/* ---------- empty, unchanged, range ---------- */

test("a day with nothing planned and nothing tracked has no replay", () => {
  assert.equal(replay({}), null);
  assert.equal(replay({ tasks: [task("idle")], blocks: [] }), null);
});

test("a day where nothing changed still returns its totals, and plays no timeline", () => {
  const result = replay({
    tasks: [tracked("report", 60)],
    blocks: [block("b1", "09:00", "10:00", { taskId: "report" })],
  });
  assert.ok(result);
  assert.equal(result.changedCount, 0);
  assert.equal(result.plannedMinutes, 60);
  assert.equal(result.trackedMinutes, 60);
  assert.equal(replayTimeline(result), null);
});

test("the visible range covers every placed span in whole hours, at least two wide", () => {
  const wide = replay({
    tasks: [tracked("a", 60), tracked("b", 60)],
    blocks: [block("b1", "09:20", "10:20", { taskId: "a" }), block("b2", "15:10", "16:10", { taskId: "b" })],
  });
  assert.deepEqual(wide?.range, { start: 540, end: 1020 });
  const narrow = replay({
    tasks: [tracked("a", 30)],
    blocks: [block("b1", "09:00", "09:30", { taskId: "a" })],
  });
  assert.deepEqual(narrow?.range, { start: 540, end: 660 });
});

/* ---------- the cap ---------- */

function crowded() {
  const tasks: ReplayTask[] = [];
  const blocks: ReplayBlock[] = [];
  // Ten tasks planned an hour each from 08:00; the even ones overrun by 30,
  // the odd ones are on plan.
  for (let index = 0; index < 10; index += 1) {
    const id = `t${index}`;
    const hour = String(8 + index).padStart(2, "0");
    const next = String(9 + index).padStart(2, "0");
    tasks.push(tracked(id, index % 2 === 0 ? 90 : 60));
    blocks.push(block(`b${index}`, `${hour}:00`, `${next}:00`, { taskId: id }));
  }
  return { tasks, blocks };
}

test("the cap shows six rows, changed first, in start order, and aggregates the rest", () => {
  const result = replay(crowded());
  assert.ok(result);
  assert.equal(MAX_REPLAY_ROWS, 6);
  assert.equal(result.changedCount, 5);
  // The five stretched rows plus the earliest unchanged one fill the cap.
  assert.deepEqual(result.rows.map(row => row.key), ["task:t0", "task:t1", "task:t2", "task:t4", "task:t6", "task:t8"]);
  assert.deepEqual(result.more, { count: 4, plannedMinutes: 240, actualMinutes: 240 });
  assert.equal(result.plannedMinutes, 600);
  assert.equal(result.trackedMinutes, 750);
});

test("when more rows changed than fit, the biggest changes win the cap", () => {
  const tasks: ReplayTask[] = [];
  const blocks: ReplayBlock[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `t${index}`;
    const hour = String(8 + index).padStart(2, "0");
    tasks.push(tracked(id, 60 + 10 * (index + 1)));
    blocks.push(block(`b${index}`, `${hour}:00`, `${String(9 + index).padStart(2, "0")}:00`, { taskId: id }));
  }
  const result = replay({ tasks, blocks });
  assert.ok(result);
  assert.equal(result.changedCount, 8);
  assert.deepEqual(result.rows.map(row => row.key), ["task:t2", "task:t3", "task:t4", "task:t5", "task:t6", "task:t7"]);
  assert.equal(result.more?.count, 2);
});

/* ---------- the timeline ---------- */

function changedReplay(count: number): DayReplay {
  const tasks: ReplayTask[] = [];
  const blocks: ReplayBlock[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `t${index}`;
    tasks.push(tracked(id, 90));
    blocks.push(block(`b${index}`, `${String(8 + index).padStart(2, "0")}:00`, `${String(9 + index).padStart(2, "0")}:00`, { taskId: id }));
  }
  const result = replay({ tasks, blocks });
  assert.ok(result);
  return result;
}

test("the timeline totals 6000 + 1100 per changed row, within 6000 and 12600", () => {
  assert.equal(replayTimeline(changedReplay(1))?.totalMs, 7100);
  assert.equal(replayTimeline(changedReplay(2))?.totalMs, 8200);
  assert.equal(replayTimeline(changedReplay(4))?.totalMs, 10_400);
  assert.equal(replayTimeline(changedReplay(6))?.totalMs, 12_600);
  assert.equal(replayTimeline(changedReplay(9))?.totalMs, 12_600);
});

test("four or more changes land in the 10 to 15 second window", () => {
  for (const count of [4, 5, 6, 9]) {
    const total = replayTimeline(changedReplay(count))?.totalMs ?? 0;
    assert.ok(total >= 10_000 && total <= 15_000, `${count} changes -> ${total} ms`);
  }
  for (const count of [1, 2, 3]) {
    assert.ok((replayTimeline(changedReplay(count))?.totalMs ?? 0) >= 6000);
  }
});

test("rows enter on a 60 ms stagger and changed rows act 650 ms apart from 3000 ms", () => {
  const timeline = replayTimeline(changedReplay(4));
  assert.ok(timeline);
  assert.deepEqual(timeline.steps.map(step => step.enterMs), [0, 60, 120, 180]);
  assert.deepEqual(timeline.steps.map(step => step.action?.atMs), [3000, 3650, 4300, 4950]);
  assert.deepEqual(timeline.steps.map(step => step.action?.kind), ["stretched", "stretched", "stretched", "stretched"]);
  assert.equal(timeline.firstActMs, 3000);
  assert.equal(timeline.stageInMs, 150);
});

test("an unchanged row has no action and does not take an act slot", () => {
  const result = replay({
    tasks: [tracked("a", 60), tracked("b", 90)],
    blocks: [block("b1", "09:00", "10:00", { taskId: "a" }), block("b2", "10:00", "11:00", { taskId: "b" })],
  });
  assert.ok(result);
  const timeline = replayTimeline(result);
  assert.ok(timeline);
  assert.deepEqual(timeline.steps.map(step => step.action?.atMs), [undefined, 3000]);
});

test("the totals follow the last change and the sentence ends before the replay does", () => {
  for (const count of [1, 3, 4, 6]) {
    const timeline = replayTimeline(changedReplay(count));
    assert.ok(timeline);
    const actsEnd = Math.max(...timeline.steps.map(step => (step.action?.atMs ?? 0) + (step.action?.durationMs ?? 0)));
    assert.ok(timeline.totalsAtMs >= actsEnd, `${count}: totals at ${timeline.totalsAtMs} before acts end ${actsEnd}`);
    assert.ok(timeline.totalsAtMs + 200 <= timeline.sentenceAtMs);
    assert.equal(timeline.sentenceAtMs + 600 + 1200, timeline.totalMs);
  }
});

test("each beat keeps to its duration: moves 800, stretches 700, strikes 750, added 400", () => {
  const result = replay({
    tasks: [tracked("m", 60), tracked("s", 90), task("k"), tracked("n", 30)],
    plan: [
      block("b1", "09:00", "10:00", { taskId: "m" }),
      block("b2", "10:00", "11:00", { taskId: "s" }),
      block("b3", "11:00", "12:00", { taskId: "k" }),
    ],
    blocks: [
      block("b1", "13:00", "14:00", { taskId: "m" }),
      block("b2", "10:00", "11:00", { taskId: "s" }),
      block("b3", "11:00", "12:00", { taskId: "k" }),
      block("b4", "15:00", "15:30", { taskId: "n" }),
    ],
  });
  assert.ok(result);
  const timeline = replayTimeline(result);
  assert.ok(timeline);
  assert.deepEqual(
    timeline.steps.map(step => [step.action?.kind, step.action?.durationMs]),
    [["stretched", 700], ["struck", 750], ["moved", 800], ["added", 400]],
  );
});

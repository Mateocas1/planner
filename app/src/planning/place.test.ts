import assert from "node:assert/strict";
import test from "node:test";
import { toZonedInstant } from "../domain/instant.ts";
import { MAX_CHUNKS, MIN_CHUNK_MINUTES, planDay, samePlan, taskMinutes, unplacedNotice, type Plan, type PlanBlock, type PlanTask } from "./place.ts";
import { defaultWorkWindow } from "./window.ts";

/** Every fixture runs in the profile zone, never the runtime's own. */
const zone = "Europe/Madrid";
const monday = "2026-02-02";
const tuesday = "2026-02-03";
const wednesday = "2026-02-04";
/** Monday 07:00 in the profile zone, before its window opens. */
const mondayMorning = new Date("2026-02-02T06:00:00Z");

const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** A zoned instant for a wall clock on a day of the profile zone. */
const instant = (day: string, minutes: number) => toZonedInstant(`${day}T${time(minutes)}`, zone);
/** A stored block occupying a wall-clock range of one day. */
const block = (start: string, end: string, taskId?: string): PlanBlock => ({ ...(taskId === undefined ? {} : { taskId }), start, end });
const range = (day: string, from: number, to: number, taskId?: string) => block(instant(day, from), instant(day, to), taskId);

const plan = (input: {
  day?: string;
  now?: Date;
  window?: { startMinutes: number; endMinutes: number };
  tasks: PlanTask[];
  blocks?: PlanBlock[];
}) =>
  planDay({
    day: input.day ?? monday,
    now: input.now ?? mondayMorning,
    timeZone: zone,
    window: input.window ?? defaultWorkWindow,
    tasks: input.tasks,
    blocks: input.blocks ?? [],
  });

test("criterion 1: deadline first, then the longest task, back to back from the window start", () => {
  // A due Wednesday 60 min, B due Monday 30 min, C undated 90 min, free 09:00-21:00.
  const result = plan({
    window: { startMinutes: 540, endMinutes: 1260 },
    tasks: [
      { id: "a", title: "A", deadline: wednesday, estimate: 60 },
      { id: "b", title: "B", deadline: monday, estimate: 30 },
      { id: "c", title: "C", estimate: 90 },
    ],
  });
  assert.deepEqual(result.placements, [
    { taskId: "b", title: "B", startMinutes: 540, endMinutes: 570 },
    { taskId: "a", title: "A", startMinutes: 570, endMinutes: 630 },
    { taskId: "c", title: "C", startMinutes: 630, endMinutes: 720 },
  ]);
  assert.deepEqual(result.unplaced, []);
});

test("criterion 1: an undated task is ordered after every dated one, longest first", () => {
  const result = plan({
    window: { startMinutes: 540, endMinutes: 1260 },
    tasks: [
      { id: "none", title: "None", estimate: 1440 },
      { id: "late", title: "Late", deadline: wednesday, estimate: 60 },
      { id: "soon", title: "Soon", deadline: monday, estimate: 30 },
      { id: "big", title: "Big", deadline: monday, estimate: 90 },
    ],
  });
  // The window holds 12 h; the undated 1440-minute task sorts last, so it is
  // the one left over once the three dated tasks have taken their time.
  assert.deepEqual(
    result.placements.map(item => item.taskId),
    ["big", "soon", "late"],
  );
  assert.deepEqual(result.unplaced.map(item => item.task.title), ["None"]);
});

test("criterion 2: an existing block is never overlapped", () => {
  // 10:00-11:00 is taken, so the 120-minute task goes after it and the
  // 60-minute task takes the gap before it.
  const existing = [range(monday, 600, 660)];
  const result = plan({
    window: { startMinutes: 540, endMinutes: 1260 },
    tasks: [
      { id: "short", title: "Short", estimate: 60 },
      { id: "long", title: "Long", estimate: 120 },
    ],
    blocks: existing,
  });
  assert.deepEqual(result.placements, [
    { taskId: "short", title: "Short", startMinutes: 540, endMinutes: 600 },
    { taskId: "long", title: "Long", startMinutes: 660, endMinutes: 780 },
  ]);
  for (const placement of result.placements) {
    assert.ok(placement.endMinutes <= 600 || placement.startMinutes >= 660, `${placement.taskId} must not overlap the block`);
  }
});

test("criterion 2: overlapping blocks contribute their union only", () => {
  const result = plan({
    tasks: [{ id: "long", title: "Long", estimate: 120 }],
    blocks: [range(monday, 540, 720), range(monday, 660, 840)],
  });
  // 09:00-12:00 and 11:00-14:00 collapse into 09:00-14:00; the first fit is 14:00.
  assert.deepEqual(result.placements, [{ taskId: "long", title: "Long", startMinutes: 840, endMinutes: 960 }]);
});

test("criterion 7: placement starts at the quarter hour after now", () => {
  // At 14:07 the day is free from 14:15; two 30-minute tasks run back to back.
  const result = plan({
    now: new Date("2026-02-02T13:07:00Z"),
    tasks: [
      { id: "one", title: "One", estimate: 30 },
      { id: "two", title: "Two", estimate: 30 },
    ],
  });
  assert.deepEqual(result.placements, [
    { taskId: "one", title: "One", startMinutes: 855, endMinutes: 885 },
    { taskId: "two", title: "Two", startMinutes: 885, endMinutes: 915 },
  ]);
});

test("criterion 7: nothing is placed in the past, even when the window is still open", () => {
  // One free hour at 08:00 is behind us at 14:07; only 14:15-15:00 remains.
  const result = plan({
    now: new Date("2026-02-02T13:07:00Z"),
    window: { startMinutes: 480, endMinutes: 900 },
    tasks: [{ id: "late", title: "Late", estimate: 60 }],
  });
  assert.deepEqual(result.placements, []);
  assert.deepEqual(result.unplaced, [{ task: { id: "late", title: "Late", estimate: 60 }, reason: "no-room" }]);
});

test("a task without an estimate is planned for the 60-minute assumption", () => {
  assert.deepEqual(taskMinutes({ id: "a", title: "A" }), 60);
  assert.deepEqual(taskMinutes({ id: "a", title: "A", estimate: 45 }), 45);
  // A hand-edited estimate outside the domain rule reads as absent, not as a plan.
  assert.deepEqual(taskMinutes({ id: "a", title: "A", estimate: 4 }), 60);
  const result = plan({ tasks: [{ id: "a", title: "A" }] });
  assert.deepEqual(result.placements, [{ taskId: "a", title: "A", startMinutes: 480, endMinutes: 540 }]);
});

test("criterion 3 and 4: unfitted tasks are listed due-today first and the notice names them", () => {
  // Only 09:00-10:00 is free; neither 120-minute task can be split into 45+ chunks.
  const result = plan({
    window: { startMinutes: 540, endMinutes: 600 },
    tasks: [
      { id: "taxes", title: "Taxes", estimate: 120 },
      { id: "report", title: "Report", deadline: monday, estimate: 120 },
    ],
  });
  assert.deepEqual(result.placements, []);
  assert.deepEqual(
    result.unplaced.map(item => item.task.id),
    ["report", "taxes"],
  );
  assert.equal(unplacedNotice(result.unplaced), "2 tasks didn't fit today: Report, Taxes. Plan tomorrow?");
});

test("criterion 3: the notice speaks for one task, another day and no task at all", () => {
  const one = plan({
    window: { startMinutes: 540, endMinutes: 570 },
    tasks: [{ id: "report", title: "Report", estimate: 120 }],
  }).unplaced;
  assert.equal(unplacedNotice(one), "1 task didn't fit today: Report. Plan tomorrow?");
  assert.equal(unplacedNotice(one, "Wednesday"), "1 task didn't fit Wednesday: Report. Plan tomorrow?");
  assert.equal(unplacedNotice([]), "");
});

test("criterion 5: a second run over the planned blocks has nothing to plan", () => {
  const tasks = [
    { id: "a", title: "A", deadline: monday, estimate: 60 },
    { id: "b", title: "B", estimate: 30 },
  ];
  const first = plan({ tasks });
  assert.equal(first.placements.length, 2);
  const planned = first.placements.map(item => range(monday, item.startMinutes, item.endMinutes, item.taskId));
  const second = plan({ tasks, blocks: planned });
  assert.deepEqual(second.placements, []);
  assert.deepEqual(second.unplaced, []);
});

test("candidates: completed tasks and tasks with a future block are not planned", () => {
  const result = plan({
    now: new Date("2026-02-02T13:07:00Z"),
    tasks: [
      { id: "done", title: "Done", completed: true, estimate: 60 },
      { id: "ahead", title: "Ahead", estimate: 60 },
      { id: "behind", title: "Behind", estimate: 60 },
      { id: "open", title: "Open", estimate: 120 },
    ],
    blocks: [range(monday, 900, 960, "ahead"), range(monday, 780, 840, "behind")],
  });
  // The block that already ended leaves its task in the tray; the future one
  // keeps its task out of it, and a completed task is never planned.
  assert.deepEqual(
    result.placements.map(item => item.taskId),
    ["open", "behind"],
  );
  assert.deepEqual(result.unplaced, []);
});

test("an empty tray plans nothing", () => {
  assert.deepEqual(plan({ tasks: [] }), { day: monday, placements: [], unplaced: [] });
});

test("a day whose window has passed reports every candidate as day-over", () => {
  // 22:00 is past today's 21:00 window end, so there is no free minute left.
  const result = plan({
    now: new Date("2026-02-02T21:00:00Z"),
    tasks: [{ id: "a", title: "A", estimate: 60 }],
  });
  assert.deepEqual(result.placements, []);
  assert.deepEqual(result.unplaced, [{ task: { id: "a", title: "A", estimate: 60 }, reason: "day-over" }]);
});

test("the split rule: chunks of at least 45 minutes, at most four", () => {
  assert.equal(MIN_CHUNK_MINUTES, 45);
  assert.equal(MAX_CHUNKS, 4);
  const cases: {
    name: string;
    estimate: number;
    window: { startMinutes: number; endMinutes: number };
    busy: [number, number][];
    expected: [number, number][];
    unplaced: boolean;
  }[] = [
    {
      // Two 45-minute gaps and no single 90-minute one: the task splits in two.
      name: "splits a 90-minute task across two 45-minute gaps",
      estimate: 90,
      window: { startMinutes: 540, endMinutes: 660 },
      busy: [[585, 600]],
      expected: [[540, 585], [600, 645]],
      unplaced: false,
    },
    {
      // Taking the whole 120-minute gap would leave a 10-minute tail; the first
      // chunk shrinks to 85 so the second is a legal 45.
      name: "shrinks the first chunk so the last one is legal",
      estimate: 130,
      window: { startMinutes: 540, endMinutes: 760 },
      busy: [[660, 700]],
      expected: [[540, 625], [700, 745]],
      unplaced: false,
    },
    {
      // 50 + 10 is illegal: a 60-minute task splits into 45 + 15 or not at all.
      name: "refuses chunks below 45 minutes",
      estimate: 60,
      window: { startMinutes: 540, endMinutes: 650 },
      busy: [[590, 600]],
      expected: [],
      unplaced: true,
    },
    {
      // Five 100-minute gaps could host 500 minutes, but never in four chunks.
      name: "stops at four chunks",
      estimate: 500,
      window: { startMinutes: 540, endMinutes: 1150 },
      busy: [[640, 660], [760, 780], [880, 900], [1000, 1020]],
      expected: [],
      unplaced: true,
    },
    {
      // One gap is long enough: no split at all.
      name: "does not split a task that fits one gap",
      estimate: 60,
      window: { startMinutes: 540, endMinutes: 760 },
      busy: [[660, 700]],
      expected: [[540, 600]],
      unplaced: false,
    },
  ];
  for (const fixture of cases) {
    const result = plan({
      window: fixture.window,
      tasks: [{ id: "t", title: "Task", estimate: fixture.estimate }],
      blocks: fixture.busy.map(([from, to]) => range(monday, from, to)),
    });
    assert.deepEqual(
      result.placements.map(item => [item.startMinutes, item.endMinutes]),
      fixture.expected,
      fixture.name,
    );
    assert.equal(result.unplaced.length, fixture.unplaced ? 1 : 0, fixture.name);
  }
});

test("a DST day is still read by its wall clock", () => {
  // Europe/Madrid springs forward at 02:00 on 2026-03-29 (23-hour day). The
  // block reads 01:30-03:30 on the wall clock, its two hours of wall minutes,
  // so the free ranges are 00:00-01:30 and 03:30-24:00.
  const day = "2026-03-29";
  const gap = block("2026-03-29T01:30:00+01:00", "2026-03-29T03:30:00+02:00");
  const result = planDay({
    day,
    now: new Date("2026-03-28T20:00:00Z"),
    timeZone: zone,
    window: { startMinutes: 0, endMinutes: 1440 },
    tasks: [
      { id: "early", title: "Early", estimate: 90 },
      { id: "later", title: "Later", estimate: 30 },
    ],
    blocks: [gap],
  });
  assert.deepEqual(result.placements, [
    { taskId: "early", title: "Early", startMinutes: 0, endMinutes: 90 },
    { taskId: "later", title: "Later", startMinutes: 210, endMinutes: 240 },
  ]);
});

test("a block crossing midnight is clipped at each day's own midnight", () => {
  // 23:30 Monday to 00:30 Tuesday occupies the last 30 minutes of Monday and
  // the first 30 minutes of Tuesday; no placement crosses midnight.
  const overnight = block("2026-02-02T23:30:00+01:00", "2026-02-03T00:30:00+01:00");
  const mondayResult = plan({
    window: { startMinutes: 1380, endMinutes: 1440 },
    tasks: [{ id: "short", title: "Short", estimate: 30 }],
    blocks: [overnight],
  });
  assert.deepEqual(mondayResult.placements, [{ taskId: "short", title: "Short", startMinutes: 1380, endMinutes: 1410 }]);
  const tooLong = plan({
    window: { startMinutes: 1380, endMinutes: 1440 },
    tasks: [{ id: "long", title: "Long", estimate: 60 }],
    blocks: [overnight],
  });
  assert.deepEqual(tooLong.placements, []);
  assert.equal(tooLong.unplaced[0]?.reason, "no-room");

  const tuesdayResult = plan({
    day: tuesday,
    window: { startMinutes: 0, endMinutes: 1440 },
    tasks: [{ id: "short", title: "Short", estimate: 30 }],
    blocks: [overnight],
  });
  assert.deepEqual(tuesdayResult.placements, [{ taskId: "short", title: "Short", startMinutes: 30, endMinutes: 60 }]);
});

test("invalid inputs fail before any placement is produced", () => {
  assert.throws(() => plan({ day: "2026-02-01", tasks: [] }), { message: "cannot plan a day in the past" });
  assert.throws(() => plan({ day: "02/02/2026", tasks: [] }), { message: "expected a day key" });
  assert.throws(() => plan({ day: "2026-13-01", tasks: [] }), { message: "expected a day key" });
  assert.throws(() => plan({ window: { startMinutes: 600, endMinutes: 300 }, tasks: [] }), {
    message: "work window end must be after start",
  });
});

test("samePlan: equal plans match; a different time, task, order, count or day does not", () => {
  const tasks: PlanTask[] = [
    { id: "a", title: "A", estimate: 60 },
    { id: "b", title: "B", estimate: 30 },
  ];
  const shown = plan({ tasks });
  assert.equal(shown.placements.length, 2);

  // Re-planning the same inputs gives the same blocks.
  assert.equal(samePlan(shown, plan({ tasks })), true);
  // Titles are not compared: only what would be written.
  assert.equal(samePlan(shown, plan({ tasks: [{ ...tasks[0], title: "Renamed" }, tasks[1]] })), true);

  // A block added over the first slot moves every placement after it.
  assert.equal(samePlan(shown, plan({ tasks, blocks: [range(monday, 480, 510)] })), false);
  // Another task in the first slot.
  assert.equal(samePlan(shown, plan({ tasks: [{ id: "c", title: "C", estimate: 60 }, tasks[1]] })), false);
  // The same two placements in the other order.
  assert.equal(samePlan(shown, { ...shown, placements: [...shown.placements].reverse() }), false);
  // One placement fewer.
  assert.equal(samePlan(shown, { ...shown, placements: shown.placements.slice(0, 1) }), false);
  // The same placements on another day.
  assert.equal(samePlan(shown, plan({ day: tuesday, tasks })), false);
});

test("samePlan: plans with no placements on the same day are equal", () => {
  const empty: Plan = { day: monday, placements: [], unplaced: [] };
  assert.equal(samePlan(empty, { ...empty, unplaced: [{ task: { id: "x", title: "X" }, reason: "day-over" }] }), true);
  assert.equal(samePlan(empty, { ...empty, day: tuesday }), false);
});

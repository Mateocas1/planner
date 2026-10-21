import assert from "node:assert/strict";
import test from "node:test";
import {
  dayLeftovers,
  nextDayKey,
  planCloseDay,
  planUndo,
  type ShutdownBlock,
  type ShutdownTask,
} from "./shutdown.ts";

/**
 * The shutdown ritual's pure half (F3a): what is left over today, the roll
 * plan that moves due/overdue deadlines to tomorrow, and the exact undo of
 * that plan.
 *
 * Every fixture names its zone explicitly and uses zoned instants, because the
 * day a task or block belongs to is the profile zone's calendar day: a DST day
 * is still one calendar day, and a comment claims nothing the arithmetic in
 * shutdown.ts does not do.
 */

const madrid = "Europe/Madrid";
const buenosAires = "America/Argentina/Buenos_Aires";

function task(overrides: Partial<ShutdownTask> & { id: string }): ShutdownTask {
  return { title: overrides.id, completed: false, ...overrides };
}

function block(taskId: string | undefined, start: string): ShutdownBlock {
  return { ...(taskId === undefined ? {} : { taskId }), start };
}

function ids(tasks: readonly ShutdownTask[]): string[] {
  return tasks.map(item => item.id);
}

/* ---------- dayLeftovers ---------- */

type LeftoverCase = {
  name: string;
  tasks: ShutdownTask[];
  blocks: ShutdownBlock[];
  today: string;
  timeZone: string;
  done: string[];
  leftOver: string[];
};

const leftoverCases: LeftoverCase[] = [
  {
    name: "three done today, two left over: one due today and one planned today",
    today: "2026-05-04",
    timeZone: buenosAires,
    tasks: [
      task({ id: "done-1", completed: true, completedAt: "2026-05-04T09:00:00-03:00" }),
      task({ id: "done-2", completed: true, completedAt: "2026-05-04T11:30:00-03:00" }),
      task({ id: "done-3", completed: true, completedAt: "2026-05-04T17:45:00-03:00" }),
      task({ id: "due-today", deadline: "2026-05-04" }),
      task({ id: "planned-today" }),
      task({ id: "due-tomorrow", deadline: "2026-05-05" }),
      task({ id: "done-yesterday", completed: true, completedAt: "2026-05-03T23:00:00-03:00" }),
      task({ id: "done-without-instant", completed: true }),
    ],
    blocks: [block("planned-today", "2026-05-04T10:00:00-03:00"), block("due-tomorrow", "2026-05-05T10:00:00-03:00")],
    done: ["done-1", "done-2", "done-3"],
    leftOver: ["due-today", "planned-today"],
  },
  {
    name: "an overdue deadline is left over",
    today: "2026-05-04",
    timeZone: buenosAires,
    tasks: [task({ id: "overdue", deadline: "2026-05-01" })],
    blocks: [],
    done: [],
    leftOver: ["overdue"],
  },
  {
    name: "a block that starts late on the previous local day is not today's",
    today: "2026-10-25",
    timeZone: madrid,
    tasks: [task({ id: "last-night" }), task({ id: "after-midnight" })],
    // 2026-10-25 23:30 CET is the local night of the 25th; 2026-10-26 00:30 CET
    // is already the 26th. The grid buckets a block by its start instants.
    blocks: [block("last-night", "2026-10-25T23:30:00+01:00"), block("after-midnight", "2026-10-26T00:30:00+01:00")],
    done: [],
    leftOver: ["last-night"],
  },
  {
    name: "the DST fall-back day still has one day key",
    today: "2026-10-25",
    timeZone: madrid,
    tasks: [
      task({ id: "done-before-change", completed: true, completedAt: "2026-10-25T01:30:00+02:00" }),
      task({ id: "done-after-change", completed: true, completedAt: "2026-10-25T23:30:00+01:00" }),
    ],
    blocks: [],
    done: ["done-before-change", "done-after-change"],
    leftOver: [],
  },
  {
    name: "the DST spring-forward day starts after midnight in the new offset",
    today: "2026-03-30",
    timeZone: madrid,
    tasks: [task({ id: "done-early", completed: true, completedAt: "2026-03-30T00:15:00+02:00" })],
    blocks: [],
    done: ["done-early"],
    leftOver: [],
  },
  {
    name: "a malformed instant belongs to no day instead of crashing the ritual",
    today: "2026-05-04",
    timeZone: buenosAires,
    tasks: [
      task({ id: "bad-done", completed: true, completedAt: "not an instant" }),
      task({ id: "bad-block" }),
    ],
    blocks: [block("bad-block", "also not an instant")],
    done: [],
    leftOver: [],
  },
];

for (const fixture of leftoverCases) {
  test(`dayLeftovers: ${fixture.name}`, () => {
    const groups = dayLeftovers({
      tasks: fixture.tasks,
      blocks: fixture.blocks,
      today: fixture.today,
      timeZone: fixture.timeZone,
    });
    assert.deepEqual(ids(groups.done), fixture.done, "done lists exactly the tasks completed today");
    assert.deepEqual(ids(groups.leftOver), fixture.leftOver, "left over lists open tasks due or planned today");
  });
}

test("dayLeftovers: left over is ordered by deadline (none last), then title", () => {
  const groups = dayLeftovers({
    tasks: [
      task({ id: "no-deadline", title: "Zebra" }),
      task({ id: "later", title: "Aardvark", deadline: "2026-05-04" }),
      task({ id: "sooner", title: "Marmot", deadline: "2026-05-01" }),
      task({ id: "same-day-b", title: "Bison", deadline: "2026-05-04" }),
    ],
    blocks: [block("no-deadline", "2026-05-04T10:00:00-03:00")],
    today: "2026-05-04",
    timeZone: buenosAires,
  });
  assert.deepEqual(ids(groups.leftOver), ["sooner", "later", "same-day-b", "no-deadline"]);
});

/* ---------- nextDayKey ---------- */

const nextDayCases: [string, string][] = [
  ["2026-05-04", "2026-05-05"],
  ["2026-01-31", "2026-02-01"],
  ["2026-12-31", "2027-01-01"],
  ["2028-02-28", "2028-02-29"],
  ["2028-02-29", "2028-03-01"],
  ["2026-03-29", "2026-03-30"],
  ["2026-10-25", "2026-10-26"],
];

for (const [today, tomorrow] of nextDayCases) {
  test(`nextDayKey: ${today} + 1 day is ${tomorrow}`, () => {
    assert.equal(nextDayKey(today), tomorrow);
  });
}

for (const malformed of ["2026-5-4", "2026-05-32", "2026-13-01", "2026-02-30", "today", ""]) {
  test(`nextDayKey rejects ${JSON.stringify(malformed)}`, () => {
    assert.throws(() => nextDayKey(malformed), /day key/);
  });
}

/* ---------- planCloseDay ---------- */

test("planCloseDay moves only the deadlines of due and overdue leftovers", () => {
  const plan = planCloseDay({
    tasks: [
      task({ id: "due-today", deadline: "2026-05-04" }),
      task({ id: "overdue", deadline: "2026-05-02" }),
      task({ id: "future", deadline: "2026-05-09" }),
      task({ id: "no-deadline" }),
      task({ id: "done-today", completed: true, completedAt: "2026-05-04T12:00:00-03:00", deadline: "2026-05-04" }),
    ],
    blocks: [
      block("no-deadline", "2026-05-04T10:00:00-03:00"),
      block("future", "2026-05-04T15:00:00-03:00"),
    ],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-05-03",
  });
  assert.equal(plan.today, "2026-05-04");
  assert.equal(plan.alreadyClosed, false);
  assert.deepEqual(plan.moves, [
    { taskId: "overdue", before: "2026-05-02", after: "2026-05-05" },
    { taskId: "due-today", before: "2026-05-04", after: "2026-05-05" },
  ]);
  assert.deepEqual(plan.lastShutdown, { before: "2026-05-03", after: "2026-05-04" });
});

test("planCloseDay rolls to the next calendar day, not to 24 hours later", () => {
  const plan = planCloseDay({
    tasks: [task({ id: "due", deadline: "2026-10-25" })],
    blocks: [],
    today: "2026-10-25",
    timeZone: madrid,
  });
  assert.deepEqual(plan.moves, [{ taskId: "due", before: "2026-10-25", after: "2026-10-26" }]);
});

test("planCloseDay is idempotent once the day is closed", () => {
  const tasks = [task({ id: "due", deadline: "2026-05-04" })];
  const first = planCloseDay({ tasks, blocks: [], today: "2026-05-04", timeZone: buenosAires });
  const second = planCloseDay({
    tasks: [{ ...tasks[0]!, deadline: first.moves[0]!.after }],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-05-04",
  });
  assert.equal(second.alreadyClosed, true);
  assert.deepEqual(second.moves, [], "a closed day has nothing to roll");
  assert.deepEqual(second.lastShutdown, { before: "2026-05-04", after: "2026-05-04" });
});

test("planCloseDay treats a stale lastShutdown as open", () => {
  const plan = planCloseDay({
    tasks: [],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-05-01",
  });
  assert.equal(plan.alreadyClosed, false);
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.lastShutdown, { before: "2026-05-01", after: "2026-05-04" });
});

test("planCloseDay reads a malformed stored lastShutdown as absent", () => {
  const plan = planCloseDay({
    tasks: [],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-5-4",
  });
  assert.equal(plan.alreadyClosed, false);
  assert.deepEqual(plan.lastShutdown, { before: undefined, after: "2026-05-04" });
});

test("planCloseDay rejects a malformed today instead of guessing it", () => {
  assert.throws(
    () => planCloseDay({ tasks: [], blocks: [], today: "04/05/2026", timeZone: buenosAires }),
    /day key/,
  );
});

/* ---------- planUndo ---------- */

test("planUndo restores every previous deadline exactly", () => {
  const plan = planCloseDay({
    tasks: [
      task({ id: "overdue", deadline: "2026-05-02" }),
      task({ id: "due-today", deadline: "2026-05-04" }),
    ],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-05-03",
  });
  assert.deepEqual(planUndo(plan), {
    deadlines: [
      { taskId: "overdue", deadline: "2026-05-02" },
      { taskId: "due-today", deadline: "2026-05-04" },
    ],
    lastShutdown: "2026-05-03",
  });
});

test("planUndo clears a lastShutdown the first close introduced", () => {
  const plan = planCloseDay({
    tasks: [task({ id: "due", deadline: "2026-05-04" })],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
  });
  assert.deepEqual(planUndo(plan), {
    deadlines: [{ taskId: "due", deadline: "2026-05-04" }],
    lastShutdown: undefined,
  });
});

test("planUndo of a closed day changes nothing", () => {
  const plan = planCloseDay({
    tasks: [task({ id: "due", deadline: "2026-05-05" })],
    blocks: [],
    today: "2026-05-04",
    timeZone: buenosAires,
    lastShutdown: "2026-05-04",
  });
  assert.deepEqual(planUndo(plan), { deadlines: [], lastShutdown: "2026-05-04" });
});

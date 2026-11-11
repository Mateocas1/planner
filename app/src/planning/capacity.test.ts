import assert from "node:assert/strict";
import test from "node:test";
import { ASSUMED_ESTIMATE_MINUTES, occurrenceId } from "../domain/model.ts";
import { toZonedInstant } from "../ui/time.ts";
import { SERIES_HORIZON_DAYS, capacity, dayCapacity, overcommitNote, type CapacityInput, type DayCapacity } from "./capacity.ts";
import { defaultWorkWindow, type WorkWindow } from "./window.ts";

/**
 * The capacity radar's pure cases: how full a day is, what a block that
 * crosses midnight or a DST edge does, and whether the committed work still
 * fits before each deadline.
 *
 * Every fixture names its zone and builds instants through `toZonedInstant`,
 * so the offsets come from Intl and never from the machine running the tests.
 */

const MADRID = "Europe/Madrid";
const NEW_YORK = "America/New_York";

/** A day that contains every wall clock, for fixtures about midnight. */
const fullDay: WorkWindow = { startMinutes: 0, endMinutes: 1440 };

/** A block built from wall clocks in `zone`, so the instant carries the zone's own offset. */
function block(zone: string, start: string, end: string, taskId?: string) {
  return {
    start: toZonedInstant(start, zone),
    end: toZonedInstant(end, zone),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

/** An instant built from a wall clock in `zone`, as the clock the planner has. */
function instant(zone: string, value: string): Date {
  return new Date(toZonedInstant(value, zone));
}

/** The default fixture: Wednesday 2026-03-11 08:00 in Madrid, nothing planned. */
function input(overrides: Partial<CapacityInput> = {}): CapacityInput {
  return {
    now: instant(MADRID, "2026-03-11T08:00"),
    timeZone: MADRID,
    workWindow: defaultWorkWindow,
    tasks: [],
    blocks: [],
    series: [],
    ...overrides,
  };
}

/** The fields a radar day is read for. */
function summary(day: DayCapacity) {
  return {
    windowMinutes: day.windowMinutes,
    bookedMinutes: day.bookedMinutes,
    freeMinutes: day.freeMinutes,
    percentBooked: day.percentBooked,
    packed: day.packed,
  };
}

test("F1.1 overlapping blocks contribute their union, not their sum", () => {
  // 09:00-12:00 and 11:00-14:00 overlap for an hour: 5 h booked of a 13 h window.
  const day = dayCapacity(
    input({
      now: instant(MADRID, "2026-03-10T07:00"),
      blocks: [
        block(MADRID, "2026-03-10T09:00", "2026-03-10T12:00"),
        block(MADRID, "2026-03-10T11:00", "2026-03-10T14:00"),
      ],
    }),
    "2026-03-10",
  );
  assert.deepEqual(summary(day), {
    windowMinutes: 780,
    bookedMinutes: 300,
    freeMinutes: 480,
    percentBooked: 38,
    packed: false,
  });
});

test("F1.1 blocks outside the working window are clipped to it", () => {
  // 06:00-09:00 books 08:00-09:00 only; 20:00-23:00 books 20:00-21:00 only;
  // a block wholly before the window books nothing.
  const early = dayCapacity(
    input({ blocks: [block(MADRID, "2026-03-10T06:00", "2026-03-10T09:00"), block(MADRID, "2026-03-10T04:00", "2026-03-10T06:00")] }),
    "2026-03-10",
  );
  assert.deepEqual(summary(early), { windowMinutes: 780, bookedMinutes: 60, freeMinutes: 720, percentBooked: 8, packed: false });
  const late = dayCapacity(input({ blocks: [block(MADRID, "2026-03-10T20:00", "2026-03-10T23:00")] }), "2026-03-10");
  assert.deepEqual(summary(late), { windowMinutes: 780, bookedMinutes: 60, freeMinutes: 720, percentBooked: 8, packed: false });
});

test("F1.2 a day is packed from 85% booked", () => {
  // A one-hour window isolates the threshold: 51 min is exactly 85%, 50 min is 83%.
  const short: WorkWindow = { startMinutes: 8 * 60, endMinutes: 9 * 60 };
  const packed = dayCapacity(input({ workWindow: short, blocks: [block(MADRID, "2026-03-10T08:00", "2026-03-10T08:51")] }), "2026-03-10");
  assert.equal(packed.percentBooked, 85);
  assert.equal(packed.packed, true);
  const notPacked = dayCapacity(input({ workWindow: short, blocks: [block(MADRID, "2026-03-10T08:00", "2026-03-10T08:50")] }), "2026-03-10");
  assert.equal(notPacked.percentBooked, 83);
  assert.equal(notPacked.packed, false);
});

test("F1.5 a block crossing midnight books half on each day", () => {
  // 23:30-00:30 is 30 minutes on each day of a window that contains every hour.
  const crossing = [block(MADRID, "2026-03-10T23:30", "2026-03-11T00:30")];
  const first = dayCapacity(input({ workWindow: fullDay, blocks: crossing }), "2026-03-10");
  const second = dayCapacity(input({ workWindow: fullDay, blocks: crossing }), "2026-03-11");
  assert.deepEqual(summary(first), { windowMinutes: 1440, bookedMinutes: 30, freeMinutes: 1410, percentBooked: 2, packed: false });
  assert.deepEqual(summary(second), { windowMinutes: 1440, bookedMinutes: 30, freeMinutes: 1410, percentBooked: 2, packed: false });
  // A block ending exactly at midnight books nothing on the day it does not reach.
  const toMidnight = [block(MADRID, "2026-03-10T22:00", "2026-03-11T00:00")];
  assert.equal(dayCapacity(input({ workWindow: fullDay, blocks: toMidnight }), "2026-03-10").bookedMinutes, 120);
  assert.equal(dayCapacity(input({ workWindow: fullDay, blocks: toMidnight }), "2026-03-11").bookedMinutes, 0);
  // With the default 08:00-21:00 window the same night block books nothing.
  assert.equal(dayCapacity(input({ blocks: crossing }), "2026-03-10").bookedMinutes, 0);
  assert.equal(dayCapacity(input({ blocks: crossing }), "2026-03-11").bookedMinutes, 0);
});

test("F1.5 a DST day keeps the wall-clock window", () => {
  // 2026-03-08 is 23 real hours in New York and 2026-11-01 is 25; the window is
  // 08:00-21:00 on both, so it is 13 h of wall clock either way.
  const spring = dayCapacity(input({ timeZone: NEW_YORK, now: instant(NEW_YORK, "2026-03-08T07:00") }), "2026-03-08");
  const autumn = dayCapacity(input({ timeZone: NEW_YORK, now: instant(NEW_YORK, "2026-11-01T07:00") }), "2026-11-01");
  assert.equal(spring.windowMinutes, 780);
  assert.equal(autumn.windowMinutes, 780);
  // A block inside the window books its wall-clock length on the short day too.
  const day = dayCapacity(
    input({ timeZone: NEW_YORK, now: instant(NEW_YORK, "2026-03-08T07:00"), blocks: [block(NEW_YORK, "2026-03-08T09:00", "2026-03-08T12:00")] }),
    "2026-03-08",
  );
  assert.deepEqual(summary(day), { windowMinutes: 780, bookedMinutes: 180, freeMinutes: 600, percentBooked: 23, packed: false });
  // Wall-clock length is the rule even across the skipped hour: 01:30-03:30
  // reads as two hours on the wall clock, which is what the grid draws.
  const gap = dayCapacity(
    input({ timeZone: NEW_YORK, workWindow: fullDay, now: instant(NEW_YORK, "2026-03-08T00:00"), blocks: [block(NEW_YORK, "2026-03-08T01:30", "2026-03-08T03:30")] }),
    "2026-03-08",
  );
  assert.equal(gap.bookedMinutes, 120);
});

test("F1.3 a deadline that cannot be met is reported with its message", () => {
  // Wednesday 08:00. Wednesday and Thursday are fully booked and Friday leaves
  // 19:00-21:00 free, so only 2 h remain before Friday's end. A 3 h task due
  // Friday is 1 h over, and that is the only deadline reported.
  const blocks = [
    block(MADRID, "2026-03-11T08:00", "2026-03-11T21:00"),
    block(MADRID, "2026-03-12T08:00", "2026-03-12T21:00"),
    block(MADRID, "2026-03-13T08:00", "2026-03-13T19:00"),
  ];
  const task = { id: "t1", title: "Write the report", deadline: "2026-03-13", estimate: 180 };
  const over = capacity(input({ blocks, tasks: [task] }));
  assert.deepEqual(over.overcommit, [{ deadline: "2026-03-13", committedMinutes: 180, freeMinutes: 120, overMinutes: 60 }]);
  assert.equal(overcommitNote(over.overcommit[0]!), "1h over for Fri. Move something or push a deadline.");
  // The same task at 2 h fits exactly, so nothing is reported.
  assert.deepEqual(capacity(input({ blocks, tasks: [{ ...task, estimate: 120 }] })).overcommit, []);
  // With nothing booked there is plenty of room.
  assert.deepEqual(capacity(input({ tasks: [task] })).overcommit, []);
});

test("F1.3 the shortfall is cumulative in deadline order", () => {
  // The same booked week, with 2 h due Thursday and 2 h due Friday: Thursday is
  // 2 h over on its own, and Friday carries both tasks against 2 h of free time.
  const blocks = [
    block(MADRID, "2026-03-11T08:00", "2026-03-11T21:00"),
    block(MADRID, "2026-03-12T08:00", "2026-03-12T21:00"),
    block(MADRID, "2026-03-13T08:00", "2026-03-13T19:00"),
  ];
  const rows = capacity(
    input({
      blocks,
      tasks: [
        { id: "thu", title: "Send invoice", deadline: "2026-03-12", estimate: 120 },
        { id: "fri", title: "Write report", deadline: "2026-03-13", estimate: 120 },
      ],
    }),
  ).overcommit;
  assert.deepEqual(rows, [
    { deadline: "2026-03-12", committedMinutes: 120, freeMinutes: 0, overMinutes: 120 },
    { deadline: "2026-03-13", committedMinutes: 240, freeMinutes: 120, overMinutes: 120 },
  ]);
});

test("F1.4 a task without estimate counts as one hour", () => {
  const committed = capacity(input({ tasks: [{ id: "t1", title: "Unestimated", deadline: "2026-03-13" }] }));
  assert.deepEqual(committed.committed, [
    { id: "t1", title: "Unestimated", deadline: "2026-03-13", remainingMinutes: ASSUMED_ESTIMATE_MINUTES, assumed: true },
  ]);
  assert.equal(committed.hints.assumedEstimateCount, 1);
  // An explicit estimate is not an assumption.
  const explicit = capacity(input({ tasks: [{ id: "t1", title: "Estimated", deadline: "2026-03-13", estimate: 45 }] }));
  assert.equal(explicit.committed[0]!.assumed, false);
  assert.equal(explicit.committed[0]!.remainingMinutes, 45);
  assert.equal(explicit.hints.assumedEstimateCount, 0);
});

test("F1.4 work already planned for a task counts against its estimate", () => {
  const task = { id: "t1", title: "Write the report", deadline: "2026-03-13", estimate: 120 };
  // A future block linked to the task takes 90 of its 120 minutes.
  const linked = capacity(input({ tasks: [task], blocks: [block(MADRID, "2026-03-12T10:00", "2026-03-12T11:30", "t1")] }));
  assert.equal(linked.committed[0]!.remainingMinutes, 30);
  // A block that already ended is not future work, so it does not count.
  const past = capacity(input({ tasks: [task], blocks: [block(MADRID, "2026-03-10T10:00", "2026-03-10T11:30", "t1")] }));
  assert.equal(past.committed[0]!.remainingMinutes, 120);
  // A block in the past of another task does not count either.
  const other = capacity(input({ tasks: [task], blocks: [block(MADRID, "2026-03-12T10:00", "2026-03-12T11:30", "other")] }));
  assert.equal(other.committed[0]!.remainingMinutes, 120);
  // More planned than estimated leaves nothing, not a negative remainder.
  const covered = capacity(input({ tasks: [task], blocks: [block(MADRID, "2026-03-12T10:00", "2026-03-12T13:00", "t1")] }));
  assert.equal(covered.committed[0]!.remainingMinutes, 0);
  assert.deepEqual(covered.overcommit, []);
});

test("F1.6 series occurrences count, and a series without estimate only counts", () => {
  // A daily 45 min series contributes one item per day of the horizon.
  const daily = capacity(
    input({ now: instant(MADRID, "2026-03-09T08:00"), series: [{ id: "s1", title: "Daily standup", frequency: "daily", anchorDate: "2026-03-09", estimate: 45 }] }),
  );
  assert.equal(SERIES_HORIZON_DAYS, 14);
  assert.equal(daily.committed.length, 14);
  assert.deepEqual(daily.committed[0], {
    id: occurrenceId("s1", "2026-03-09"),
    title: "Daily standup",
    deadline: "2026-03-09",
    remainingMinutes: 45,
    assumed: false,
    seriesId: "s1",
  });
  assert.equal(daily.committed.at(-1)!.deadline, "2026-03-22");
  // A completed occurrence is not work that is still owed.
  const completed = capacity(
    input({
      now: instant(MADRID, "2026-03-09T08:00"),
      series: [{ id: "s1", title: "Daily standup", frequency: "daily", anchorDate: "2026-03-09", estimate: 45 }],
      completions: { [occurrenceId("s1", "2026-03-09")]: toZonedInstant("2026-03-09T09:00", MADRID) },
    }),
  );
  assert.equal(completed.committed.length, 13);
  assert.equal(completed.committed[0]!.deadline, "2026-03-10");
  // Two series with no estimate add no load and are reported as a hint.
  const unestimated = capacity(
    input({
      series: [
        { id: "s1", title: "Weekly review", frequency: "weekly", anchorDate: "2026-03-09" },
        { id: "s2", title: "Water plants", frequency: "daily", anchorDate: "2026-03-09" },
      ],
    }),
  );
  assert.deepEqual(unestimated.committed, []);
  assert.deepEqual(unestimated.overcommit, []);
  assert.equal(unestimated.hints.unestimatedSeriesCount, 2);
  assert.equal(unestimated.hints.hasEstimates, false);
  assert.equal(unestimated.hints.empty, false);
});

test("the week row runs Monday to Sunday and today counts only from now", () => {
  // Wednesday 12:07: today's free time starts at the next quarter hour (12:15)
  // and nothing is booked, so 8 h 45 min of today's 13 h window remain.
  const week = capacity(
    input({
      now: instant(MADRID, "2026-03-11T12:07"),
      tasks: [
        { id: "due-today", title: "Pay invoice", deadline: "2026-03-11" },
        { id: "done", title: "Already done", deadline: "2026-03-12", estimate: 30, completed: true },
        { id: "late", title: "Overdue", deadline: "2026-03-10", estimate: 30 },
      ],
    }),
  );
  assert.equal(week.today.date, "2026-03-11");
  assert.equal(week.today.freeFromNowMinutes, 525);
  assert.equal(week.today.freeMinutes, 780);
  assert.equal(week.week.start, "2026-03-09");
  assert.deepEqual(week.week.days.map(day => day.date), [
    "2026-03-09",
    "2026-03-10",
    "2026-03-11",
    "2026-03-12",
    "2026-03-13",
    "2026-03-14",
    "2026-03-15",
  ]);
  assert.deepEqual(week.week.days.map(day => day.windowMinutes), [780, 780, 780, 780, 780, 780, 780]);
  // A past day has no free time left in it.
  assert.equal(week.week.days[1]!.freeFromNowMinutes, 0);
  // Only the open task due today is committed work: completed and overdue ones
  // are not (rolling an overdue deadline is F3's job).
  assert.deepEqual(week.committed.map(item => item.id), ["due-today"]);
  assert.equal(week.hints.empty, false);
  assert.equal(week.hints.hasEstimates, false);
  // Nothing entered at all is the radar's empty state.
  assert.equal(capacity(input()).hints.empty, true);
});

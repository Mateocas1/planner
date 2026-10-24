import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupActions,
  cleanupCandidates,
  defaultWeeklyReviewSettings,
  dueMoment,
  emptyWeekState,
  isWeekKey,
  MAX_NOTE_CHARS,
  parseWeeklyReviewNote,
  parseWeeklyReviewSettings,
  parseWeeklyReviewState,
  snoozedUntil,
  validateWeeklyReviewSettings,
  weekOfDay,
  weekOfInstant,
  weeklyNumbers,
  weekDayIndex,
  type ReviewBlock,
  type ReviewTask,
  type WeeklyMoment,
  type WeeklyReviewState,
} from "./weekly.ts";

const MADRID = "Europe/Madrid";
const TOKYO = "Asia/Tokyo";

/** Friday 2026-03-27, week 2026-W13. */
const FRIDAY_16_00Z = Date.parse("2026-03-27T16:00:00Z"); // 17:00 Madrid (CET), 01:00 Saturday Tokyo
const FRIDAY_15_59Z = Date.parse("2026-03-27T15:59:00Z"); // 16:59 Madrid (CET, UTC+1), still before the Friday moment
const SATURDAY_09_00Z = Date.parse("2026-03-28T09:00:00Z"); // 10:00 Madrid
/** Sunday 2026-03-29 is Madrid's spring-forward day (02:00 → 03:00, CET → CEST). */
const SUNDAY_16_59Z = Date.parse("2026-03-29T16:59:00Z"); // 18:59 Madrid (CEST)
const SUNDAY_17_00Z = Date.parse("2026-03-29T17:00:00Z"); // 19:00 Madrid
const MONDAY_22_30Z_PREV = Date.parse("2026-03-29T22:30:00Z"); // Monday 2026-03-30 00:30 Madrid → 2026-W14

const fridayMoment = defaultWeeklyReviewSettings.moments[0];
const sundayMoment = defaultWeeklyReviewSettings.moments[1];

function stateOf(overrides: Partial<WeeklyReviewState> & { week?: string }): WeeklyReviewState {
  return { week: "2026-W13", stepsDone: [], skipped: false, ...overrides };
}

/* ---------------------------------------------------------------- settings */

test("weekly review settings default to Friday 17:00 review+cleanup+reflect and Sunday 19:00 plan", () => {
  assert.deepEqual(defaultWeeklyReviewSettings, {
    nudges: true,
    moments: [
      { day: 5, time: 1020, steps: ["review", "cleanup", "reflect"] },
      { day: 0, time: 1140, steps: ["plan"] },
    ],
  });
});

test("weekly review settings read back what was written and default on bad data", () => {
  assert.deepEqual(parseWeeklyReviewSettings(undefined), defaultWeeklyReviewSettings);
  assert.deepEqual(parseWeeklyReviewSettings({}), defaultWeeklyReviewSettings);
  assert.deepEqual(parseWeeklyReviewSettings({ weeklyReview: "yes" } as never), defaultWeeklyReviewSettings);
  assert.deepEqual(parseWeeklyReviewSettings({ weeklyReview: { moments: "friday" } as never }), defaultWeeklyReviewSettings);
  // A list that leaves no valid moment falls back to the default moments; a
  // nudges value that did parse stays as stored.
  assert.deepEqual(
    parseWeeklyReviewSettings({ weeklyReview: { nudges: false, moments: [{ day: 9, time: 100, steps: ["review"] }] } }),
    { nudges: false, moments: defaultWeeklyReviewSettings.moments },
  );

  const custom = {
    nudges: false,
    moments: [{ day: 1, time: 480, steps: ["plan", "review"] }, { day: 6, time: 0, steps: ["reflect"] }],
  };
  assert.deepEqual(parseWeeklyReviewSettings({ weeklyReview: custom }), custom);
});

test("a malformed moment is dropped whole and valid moments survive", () => {
  const parsed = parseWeeklyReviewSettings({
    weeklyReview: {
      moments: [
        { day: 5, time: 1020, steps: ["review"] },
        { day: 8, time: 1020, steps: ["review"] }, // day out of the week
        { day: 6, time: 10.5, steps: ["plan"] }, // fractional time
        { day: 6, time: 1140, steps: ["nap"] }, // unknown step
        { day: 6, time: 1140, steps: [] }, // no steps
        "friday evening",
      ],
    },
  });
  assert.deepEqual(parsed.moments, [{ day: 5, time: 1020, steps: ["review"] }]);
});

test("weekly review settings validation rejects what the reader would replace", () => {
  validateWeeklyReviewSettings(defaultWeeklyReviewSettings);
  assert.throws(() => validateWeeklyReviewSettings({ nudges: "yes" as never, moments: [] }), /nudges/);
  assert.throws(() => validateWeeklyReviewSettings({ nudges: true, moments: "friday" as never }), /moments/);
  assert.throws(() => validateWeeklyReviewSettings({ nudges: true, moments: [{ day: 7, time: 100, steps: ["review"] }] }), /day/);
  assert.throws(() => validateWeeklyReviewSettings({ nudges: true, moments: [{ day: 5, time: -1, steps: ["review"] }] }), /time/);
  // 1440 is midnight of the next day: a moment there would never open on its day.
  assert.throws(() => validateWeeklyReviewSettings({ nudges: true, moments: [{ day: 5, time: 1440, steps: ["review"] }] }), /time/);
  assert.throws(() => validateWeeklyReviewSettings({ nudges: true, moments: [{ day: 5, time: 100, steps: [] }] }), /step/);
  // Repeated steps collapse instead of failing.
  validateWeeklyReviewSettings({ nudges: true, moments: [{ day: 5, time: 100, steps: ["review", "review"] }] });
});

/* ---------------------------------------------------------- week identity */

test("the week key is the ISO week of the profile zone", () => {
  assert.equal(weekDayIndex(0), 6); // Sunday closes the ISO week
  assert.equal(weekDayIndex(5), 4); // Friday
  assert.deepEqual(weekOfInstant(new Date(FRIDAY_16_00Z), MADRID), { week: "2026-W13", monday: "2026-03-23", sunday: "2026-03-29" });
  assert.deepEqual(weekOfDay("2026-03-23"), { week: "2026-W13", monday: "2026-03-23", sunday: "2026-03-29" });
  // The year boundary follows the ISO week year, not the calendar year.
  assert.deepEqual(weekOfDay("2026-01-01"), { week: "2026-W01", monday: "2025-12-29", sunday: "2026-01-04" });
  assert.deepEqual(weekOfDay("2027-01-01"), { week: "2026-W53", monday: "2026-12-28", sunday: "2027-01-03" });
});

test("the week rolls over at the zone's Monday, not at the instant's UTC day", () => {
  assert.equal(weekOfInstant(new Date(SUNDAY_17_00Z), MADRID).week, "2026-W13");
  assert.equal(weekOfInstant(new Date(MONDAY_22_30Z_PREV), MADRID).week, "2026-W14");
  // The same instant is Sunday evening in Madrid and Monday morning in Tokyo.
  assert.equal(weekOfInstant(new Date(Date.parse("2026-03-29T16:00:00Z")), MADRID).week, "2026-W13");
  assert.equal(weekOfInstant(new Date(Date.parse("2026-03-29T16:00:00Z")), TOKYO).week, "2026-W14");
});

test("week keys are shaped `YYYY-Www`", () => {
  assert.ok(isWeekKey("2026-W13"));
  assert.ok(!isWeekKey("2026-W1"));
  assert.ok(!isWeekKey("2026-13"));
  assert.ok(!isWeekKey(13));
  assert.throws(() => emptyWeekState("2026-13"), /ISO week key/);
});

/* ------------------------------------------------------------- due moment */

test("the Friday moment is due from 17:00 until the Sunday moment opens", () => {
  assert.equal(dueMoment(new Date(FRIDAY_15_59Z), MADRID, defaultWeeklyReviewSettings, undefined), null);
  const friday = dueMoment(new Date(FRIDAY_16_00Z), MADRID, defaultWeeklyReviewSettings, undefined);
  assert.deepEqual(friday, { week: "2026-W13", moment: fridayMoment, steps: ["review", "cleanup", "reflect"] });
  // Still due on Saturday: it lasts until the next moment of the week.
  assert.deepEqual(dueMoment(new Date(SATURDAY_09_00Z), MADRID, defaultWeeklyReviewSettings, undefined)?.moment, fridayMoment);
  assert.equal(dueMoment(new Date(MONDAY_22_30Z_PREV), MADRID, defaultWeeklyReviewSettings, undefined), null);
});

test("the Sunday moment offers the whole unfinished flow (skipped Friday → Sunday offers everything)", () => {
  // 18:59 on Sunday: the Friday moment is still the one due.
  assert.deepEqual(dueMoment(new Date(SUNDAY_16_59Z), MADRID, defaultWeeklyReviewSettings, stateOf({})), {
    week: "2026-W13",
    moment: fridayMoment,
    steps: ["review", "cleanup", "reflect"],
  });
  // 19:00: Sunday's moment takes over and carries Friday's unfinished steps.
  assert.deepEqual(dueMoment(new Date(SUNDAY_17_00Z), MADRID, defaultWeeklyReviewSettings, stateOf({})), {
    week: "2026-W13",
    moment: sundayMoment,
    steps: ["review", "cleanup", "reflect", "plan"],
  });
  // Finished steps are never re-offered.
  assert.deepEqual(
    dueMoment(new Date(SUNDAY_17_00Z), MADRID, defaultWeeklyReviewSettings, stateOf({ stepsDone: ["review", "cleanup", "reflect"] })),
    { week: "2026-W13", moment: sundayMoment, steps: ["plan"] },
  );
  assert.equal(
    dueMoment(new Date(SUNDAY_17_00Z), MADRID, defaultWeeklyReviewSettings, stateOf({ stepsDone: ["review", "cleanup", "reflect", "plan"] })),
    null,
  );
});

test("a skipped week offers nothing and a snoozed nudge stays quiet until it passes", () => {
  const now = new Date(FRIDAY_16_00Z);
  assert.equal(dueMoment(now, MADRID, defaultWeeklyReviewSettings, stateOf({ skipped: true })), null);
  assert.equal(
    dueMoment(now, MADRID, defaultWeeklyReviewSettings, stateOf({ snoozedUntil: "2026-03-27T18:00:00Z" })),
    null,
  );
  // Once the snooze has passed the moment is due again.
  assert.ok(dueMoment(now, MADRID, defaultWeeklyReviewSettings, stateOf({ snoozedUntil: "2026-03-27T15:00:00Z" })));
  // A state from another week is ignored.
  assert.ok(dueMoment(now, MADRID, defaultWeeklyReviewSettings, stateOf({ week: "2026-W12", skipped: true })));
});

test("moments on the same day open one after the other", () => {
  const settings = {
    nudges: true,
    moments: [
      { day: 5, time: 600, steps: ["plan" as const] }, // Friday 10:00
      { day: 5, time: 1020, steps: ["review" as const, "cleanup" as const, "reflect" as const] }, // Friday 17:00
    ],
  };
  const noon = new Date(Date.parse("2026-03-27T11:00:00Z")); // 12:00 Madrid
  assert.deepEqual(dueMoment(noon, MADRID, settings, undefined), { week: "2026-W13", moment: settings.moments[0], steps: ["plan"] });
  const evening = new Date(FRIDAY_16_00Z); // 17:00 Madrid
  assert.deepEqual(dueMoment(evening, MADRID, settings, undefined), {
    week: "2026-W13",
    moment: settings.moments[1],
    steps: ["plan", "review", "cleanup", "reflect"], // plan unfinished from the morning moment
  });
  assert.deepEqual(
    dueMoment(evening, MADRID, settings, stateOf({ stepsDone: ["plan"] }))?.steps,
    ["review", "cleanup", "reflect"],
  );
});

test("moments configured out of order still schedule in week order", () => {
  const settings = {
    nudges: true,
    moments: [
      { day: 0, time: 1140, steps: ["plan" as const] }, // Sunday 19:00, stored before Friday's
      { day: 5, time: 1020, steps: ["review" as const] },
    ],
  };
  const sunday = new Date(SUNDAY_17_00Z);
  const due = dueMoment(sunday, MADRID, settings, stateOf({ stepsDone: ["review"] }));
  assert.deepEqual(due, { week: "2026-W13", moment: settings.moments[0], steps: ["plan"] });
});

test("the due moment follows the profile zone, not the device zone", () => {
  const settings = { nudges: true, moments: [{ day: 5, time: 1020, steps: ["review" as const] }] };
  // 2026-03-27T08:30Z is 17:30 in Tokyo and 09:30 in Madrid.
  const now = new Date(Date.parse("2026-03-27T08:30:00Z"));
  assert.equal(dueMoment(now, TOKYO, settings, undefined)?.moment.time, 1020);
  assert.equal(dueMoment(now, MADRID, settings, undefined), null);
});

test("a DST Sunday keeps its wall-clock moment", () => {
  // 2026-03-29: Madrid springs forward 02:00 → 03:00; 19:00 local is 17:00Z.
  assert.equal(dueMoment(new Date(SUNDAY_16_59Z), MADRID, defaultWeeklyReviewSettings, undefined)?.moment, fridayMoment);
  const sunday = dueMoment(new Date(SUNDAY_17_00Z), MADRID, defaultWeeklyReviewSettings, undefined);
  assert.deepEqual(sunday, { week: "2026-W13", moment: sundayMoment, steps: ["review", "cleanup", "reflect", "plan"] });
});

/* ----------------------------------------------------------------- state */

test("the week state reads tolerantly: bad fields read as absent, another week as fresh", () => {
  assert.deepEqual(parseWeeklyReviewState(undefined, "2026-W13"), emptyWeekState("2026-W13"));
  assert.deepEqual(parseWeeklyReviewState({ week: "2026-W12" }, "2026-W13"), emptyWeekState("2026-W13"));
  assert.deepEqual(
    parseWeeklyReviewState({ week: "2026-W13", stepsDone: ["review", "nap", "review"], skipped: "yes", snoozedUntil: "nope" }, "2026-W13"),
    { week: "2026-W13", stepsDone: ["review"], skipped: false },
  );
  assert.deepEqual(
    parseWeeklyReviewState({ week: "2026-W13", stepsDone: ["plan"], skipped: true, snoozedUntil: "2026-03-27T18:00:00Z" }, "2026-W13"),
    { week: "2026-W13", stepsDone: ["plan"], skipped: true, snoozedUntil: "2026-03-27T18:00:00Z" },
  );
});

/* -------------------------------------------------------- review numbers */

const mondayNoon = new Date(Date.parse("2026-03-23T11:00:00Z")); // 12:00 Madrid, inside 2026-W13

function numbersWith(tasks: ReviewTask[], blocks: ReviewBlock[]) {
  return weeklyNumbers({ now: mondayNoon, timeZone: MADRID, tasks, blocks });
}

test("the review numbers count this week's planned blocks and completed tasks", () => {
  const numbers = numbersWith(
    [
      { id: "t1", title: "Report", completed: true, completedAt: "2026-03-24T10:00:00+02:00", estimate: 60, actualMinutes: 90 },
      { id: "t2", title: "Emails", completed: true, completedAt: "2026-03-28T10:00:00+02:00", actualMinutes: 15 },
      { id: "t3", title: "Last week's carry", completed: true, completedAt: "2026-03-20T10:00:00+01:00", actualMinutes: 500 },
      { id: "t4", title: "Open work", completed: false, actualMinutes: 120 },
    ],
    [
      { start: "2026-03-24T09:00:00+02:00", end: "2026-03-24T10:30:00+02:00", taskId: "t1" },
      { start: "2026-03-24T11:00:00+02:00", end: "2026-03-24T12:00:00+02:00", taskId: "t1" },
      { start: "2026-03-30T09:00:00+02:00", end: "2026-03-30T10:00:00+02:00", taskId: "t4" }, // next week
      { start: "not-an-instant", end: "2026-03-24T10:00:00+02:00", taskId: "t2" }, // malformed
    ],
  );
  assert.equal(numbers.week, "2026-W13");
  assert.equal(numbers.plannedMinutes, 150); // only the two in-week blocks
  assert.equal(numbers.plannedCount, 1); // distinct tasks with a block this week
  assert.equal(numbers.doneCount, 2); // t3 completed before the week
  assert.equal(numbers.actualMinutes, 105); // 90 + 15
  assert.equal(numbers.biasRatio, 1.5); // median of [90/60]; the unestimated t2 is no sample
  assert.deepEqual(numbers.topTasks, [{ title: "Report", minutes: 90 }, { title: "Emails", minutes: 15 }]);
});

test("the bias ratio is the median over tracked, estimated work and the top three titles are capped", () => {
  const numbers = numbersWith(
    [
      { id: "a", title: "Fix bug", completed: true, completedAt: "2026-03-23T10:00:00+02:00", estimate: 30, actualMinutes: 60 },
      { id: "b", title: "Fix bug", completed: true, completedAt: "2026-03-24T10:00:00+02:00", estimate: 30, actualMinutes: 30 },
      { id: "c", title: "Write docs", completed: true, completedAt: "2026-03-25T10:00:00+02:00", estimate: 60, actualMinutes: 4 }, // below the learner's sample floor
      { id: "d", title: "Call bank", completed: true, completedAt: "2026-03-25T11:00:00+02:00", estimate: 15, actualMinutes: 0 },
      { id: "e", title: "Admin", completed: true, completedAt: "2026-03-26T10:00:00+02:00", actualMinutes: 45 },
      { id: "f", title: "Deploy", completed: true, completedAt: "2026-03-26T11:00:00+02:00", actualMinutes: 100 },
    ],
    [],
  );
  assert.equal(numbers.biasRatio, 1.5); // median of [60/30, 30/30]; 4-minute and zero-minute tasks are noise
  // Top three by tracked minutes: the fourth title (Write docs, 4 min) falls off the cap.
  assert.deepEqual(numbers.topTasks, [
    { title: "Deploy", minutes: 100 },
    { title: "Fix bug", minutes: 90 },
    { title: "Admin", minutes: 45 },
  ]);
  // A week with nothing tracked has no bias and no time report.
  const empty = numbersWith([{ id: "x", title: "Open", completed: false }], []);
  assert.equal(empty.biasRatio, null);
  assert.equal(empty.actualMinutes, 0);
  assert.deepEqual(empty.topTasks, []);
  assert.deepEqual(numbersWith([], []).topTasks, []);
});

test("a block crossing the week edge is clipped to the zone's Monday-to-Monday window", () => {
  // Sunday 23:00 → Monday 01:00 Madrid: sixty minutes inside each ISO week.
  const crossing = [{ start: "2026-03-29T23:00:00+02:00", end: "2026-03-30T01:00:00+02:00", taskId: "t1" }];
  // Sunday evening still belongs to 2026-W13 (which ends Sunday 2026-03-29).
  assert.equal(numbersWith([], crossing).plannedMinutes, 60);
  // The same block also feeds the next week, whose Monday it spills into.
  const nextWeek = weeklyNumbers({ now: new Date(Date.parse("2026-03-30T11:00:00Z")), timeZone: MADRID, tasks: [], blocks: crossing });
  assert.equal(nextWeek.plannedMinutes, 60);
  // A block wholly outside the window contributes nothing.
  assert.equal(numbersWith([], [{ start: "2026-03-16T09:00:00+01:00", end: "2026-03-16T10:00:00+01:00", taskId: "t1" }]).plannedMinutes, 0);
});

test("clipping keeps real elapsed minutes across the spring-forward night", () => {
  // Madrid springs forward on Sunday 2026-03-29 (02:00 → 03:00). A block from
  // Sunday 23:00 to Monday 01:00 is still one real hour, counted in each week.
  const crossing = [{ start: "2026-03-29T23:00:00+02:00", end: "2026-03-30T01:00:00+02:00", taskId: "t1" }];
  assert.equal(numbersWith([], crossing).plannedMinutes, 60);
  const nextWeek = weeklyNumbers({ now: new Date(Date.parse("2026-03-30T11:00:00Z")), timeZone: MADRID, tasks: [], blocks: crossing });
  assert.equal(nextWeek.plannedMinutes, 60);
});

/* ----------------------------------------------------- cleanup candidates */

test("clean-up candidates are overdue or scheduled-and-not-done unfinished tasks", () => {
  const today = "2026-03-27"; // Friday of 2026-W13
  const tasks: ReviewTask[] = [
    { id: "over", title: "Overdue", completed: false, deadline: "2026-03-25" },
    { id: "sched", title: "Scheduled", completed: false },
    { id: "both", title: "Both", completed: false, deadline: "2026-03-20" },
    { id: "future", title: "Future", completed: false, deadline: "2026-04-10" },
    { id: "done", title: "Done", completed: true, deadline: "2026-03-20" },
    { id: "plain", title: "Plain", completed: false },
  ];
  const blocks: ReviewBlock[] = [{ start: "2026-03-26T09:00:00+01:00", end: "2026-03-26T10:00:00+01:00", taskId: "sched" }];
  const candidates = cleanupCandidates({ tasks, blocks, today, timeZone: MADRID });
  assert.deepEqual(candidates.map(candidate => [candidate.task.id, candidate.reasons]), [
    ["both", ["overdue"]],
    ["over", ["overdue"]],
    ["sched", ["scheduled-not-done"]],
  ]);
  for (const candidate of candidates) assert.deepEqual(candidate.actions, cleanupActions);
  // Deadline ascending, no deadline last, then title.
  assert.deepEqual(candidates.map(candidate => candidate.task.deadline ?? ""), ["2026-03-20", "2026-03-25", ""]);
  // A block of a past week does not schedule a task into this week's review.
  const lastWeek = cleanupCandidates({ tasks, blocks: [{ start: "2026-03-16T09:00:00+01:00", end: "2026-03-16T10:00:00+01:00", taskId: "sched" }], today, timeZone: MADRID });
  assert.deepEqual(lastWeek.map(candidate => candidate.task.id), ["both", "over"]);
});

test("someday tasks never re-enter the Clean-up step", () => {
  const today = "2026-03-27"; // Friday of 2026-W13
  const tasks: ReviewTask[] = [
    { id: "shelf", title: "On the someday shelf", completed: false, deadline: "2026-03-20", someday: true },
    { id: "stale", title: "Still stale", completed: false, deadline: "2026-03-20" },
  ];
  const candidates = cleanupCandidates({ tasks, blocks: [], today, timeZone: MADRID });
  assert.deepEqual(candidates.map(candidate => candidate.task.id), ["stale"]);
});

/* ---------------------------------------------------------------- snooze */

test("a snooze is an instant two hours out by default", () => {
  assert.equal(snoozedUntil(new Date(FRIDAY_16_00Z)), "2026-03-27T18:00:00.000Z");
  assert.equal(snoozedUntil(new Date(FRIDAY_16_00Z), 30), "2026-03-27T16:30:00.000Z");
  assert.throws(() => snoozedUntil(new Date(FRIDAY_16_00Z), 0), /snooze/);
});

/* ------------------------------------------------------------------ note */

test("the reflection note reads only what a note is, within the length cap", () => {
  const note = { week: "2026-W13", text: "Went well.", createdAt: "2026-03-29T19:30:00Z" };
  assert.deepEqual(parseWeeklyReviewNote({ week: "2026-W13", note }, "2026-W13"), note);
  assert.equal(parseWeeklyReviewNote(undefined, "2026-W13"), undefined);
  assert.equal(parseWeeklyReviewNote({ week: "2026-W12", note }, "2026-W13"), undefined);
  assert.equal(parseWeeklyReviewNote({ week: "2026-W13", note: { text: "", createdAt: "2026-03-29T19:30:00Z" } }, "2026-W13"), undefined);
  assert.equal(parseWeeklyReviewNote({ week: "2026-W13", note: { text: "x".repeat(MAX_NOTE_CHARS + 1), createdAt: "2026-03-29T19:30:00Z" } }, "2026-W13"), undefined);
  assert.equal(parseWeeklyReviewNote({ week: "2026-W13", note: { text: "ok", createdAt: "yesterday" } }, "2026-W13"), undefined);
  // Exactly at the cap is still a note.
  assert.ok(parseWeeklyReviewNote({ week: "2026-W13", note: { text: "x".repeat(MAX_NOTE_CHARS), createdAt: "2026-03-29T19:30:00Z" } }, "2026-W13"));
});

/* ------------------------------------------------------ moment edge cases */

test("a moment at the day's last minute only opens for that minute", () => {
  const settings: { nudges: boolean; moments: WeeklyMoment[] } = {
    nudges: true,
    moments: [{ day: 5, time: 1439, steps: ["review"] }],
  };
  // Friday 22:00 Madrid: the moment's position is still ahead.
  assert.equal(dueMoment(new Date(Date.parse("2026-03-27T21:00:00Z")), MADRID, settings, undefined), null);
  // Friday 23:59 Madrid (22:59Z): the day's last minute opens it.
  assert.ok(dueMoment(new Date(Date.parse("2026-03-27T22:59:00Z")), MADRID, settings, undefined));
  // Saturday 10:00 Madrid: the Friday 23:59 moment is now the last one due.
  assert.deepEqual(dueMoment(new Date(SATURDAY_09_00Z), MADRID, settings, undefined), {
    week: "2026-W13",
    moment: settings.moments[0],
    steps: ["review"],
  });
});

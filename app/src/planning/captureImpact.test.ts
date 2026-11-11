import assert from "node:assert/strict";
import test from "node:test";
import { ASSUMED_ESTIMATE_MINUTES } from "../domain/model.ts";
import { toZonedInstant } from "../ui/time.ts";
import type { BiasSample } from "./bias.ts";
import { captureImpact, findSlot, type CaptureCandidate, type CaptureImpactInput } from "./captureImpact.ts";
import type { WorkWindow } from "./window.ts";

/**
 * The capture card's pure impact cases (capture inbox U3): the due
 * day's booked share before and after the candidate, the earliest free slot
 * around busy blocks, and the bias chip. Every fixture names its zone and
 * builds instants through `toZonedInstant`, so no offset comes from the host.
 */

const MADRID = "Europe/Madrid";
const FRIDAY = "2026-03-13";

function block(start: string, end: string, taskId?: string) {
  return {
    start: toZonedInstant(start, MADRID),
    end: toZonedInstant(end, MADRID),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

/** Wednesday 2026-03-11 08:00 in Madrid, the 08:00-21:00 window, nothing planned. */
function input(overrides: Partial<CaptureImpactInput> = {}): CaptureImpactInput {
  return {
    now: new Date(toZonedInstant("2026-03-11T08:00", MADRID)),
    timeZone: MADRID,
    workWindow: { startMinutes: 8 * 60, endMinutes: 21 * 60 },
    ...overrides,
  };
}

function candidate(overrides: Partial<CaptureCandidate> = {}): CaptureCandidate {
  return { title: "Send Q3 budget", dueDay: FRIDAY, estimateMinutes: 45, ...overrides };
}

test("before and after on a fixture: the estimate joins the due day's booked share", () => {
  const impact = captureImpact(
    input({ blocks: [block("2026-03-13T08:00", "2026-03-13T12:00"), block("2026-03-13T14:00", "2026-03-13T15:00")] }),
    candidate(),
  );
  assert.ok(impact);
  assert.equal(impact.dueDay, FRIDAY);
  assert.equal(impact.estimateMinutes, 45);
  assert.equal(impact.assumed, false);
  assert.equal(impact.before.percentBooked, 38);
  assert.equal(impact.before.bookedMinutes, 300);
  assert.equal(impact.afterBookedMinutes, 345);
  assert.equal(impact.afterPercent, 44);
  assert.equal(impact.overMinutes, 0);
  assert.equal(impact.overbooked, false);
});

test("an unestimated candidate is counted at the assumed hour and says so", () => {
  const impact = captureImpact(input(), candidate({ estimateMinutes: null }));
  assert.ok(impact);
  assert.equal(impact.estimateMinutes, ASSUMED_ESTIMATE_MINUTES);
  assert.equal(impact.assumed, true);
  assert.equal(impact.before.percentBooked, 0);
  assert.equal(impact.afterPercent, 8);
});

test("an overbooked day caps the bar at 100 and reports the overflow", () => {
  const impact = captureImpact(input({ blocks: [block("2026-03-13T08:00", "2026-03-13T20:00")] }), candidate({ estimateMinutes: 120 }));
  assert.ok(impact);
  assert.equal(impact.before.percentBooked, 92);
  assert.equal(impact.afterBookedMinutes, 840);
  assert.equal(impact.afterPercent, 100);
  assert.equal(impact.overbooked, true);
  assert.equal(impact.overMinutes, 60);
  assert.equal(impact.slot, null);
});

test("findSlot skips gaps that are too short and lands after the busy blocks", () => {
  const blocks = [block("2026-03-13T08:00", "2026-03-13T09:00"), block("2026-03-13T09:30", "2026-03-13T12:00")];
  const impact = captureImpact(input({ blocks }), candidate());
  assert.ok(impact);
  assert.deepEqual(impact.slot, { startMinutes: 12 * 60, endMinutes: 12 * 60 + 45 });
  // The 30-minute gap fits a 30-minute task.
  const small = captureImpact(input({ blocks }), candidate({ estimateMinutes: 30 }));
  assert.deepEqual(small?.slot, { startMinutes: 9 * 60, endMinutes: 9 * 60 + 30 });
});

test("findSlot treats overlapping and midnight-crossing blocks as one busy span", () => {
  const blocks = [
    block("2026-03-12T22:00", "2026-03-13T09:30"),
    block("2026-03-13T09:00", "2026-03-13T10:00"),
  ];
  const impact = captureImpact(input({ blocks }), candidate());
  assert.deepEqual(impact?.slot, { startMinutes: 10 * 60, endMinutes: 10 * 60 + 45 });
});

test("a full day has no slot and the whole estimate overflows", () => {
  const impact = captureImpact(input({ blocks: [block("2026-03-13T08:00", "2026-03-13T21:00")] }), candidate());
  assert.ok(impact);
  assert.equal(impact.before.percentBooked, 100);
  assert.equal(impact.slot, null);
  assert.equal(impact.overbooked, true);
  assert.equal(impact.overMinutes, 45);
  assert.equal(impact.afterPercent, 100);
});

test("an estimate longer than the window never gets a slot", () => {
  const impact = captureImpact(input({ workWindow: { startMinutes: 8 * 60, endMinutes: 10 * 60 } }), candidate({ estimateMinutes: 180 }));
  assert.equal(impact?.slot, null);
  assert.equal(impact?.overMinutes, 60);
  assert.equal(impact?.afterPercent, 100);
});

test("today's slot starts at the next quarter hour after now", () => {
  const impact = captureImpact(
    input({ now: new Date(toZonedInstant("2026-03-11T10:07", MADRID)) }),
    candidate({ dueDay: "2026-03-11" }),
  );
  assert.deepEqual(impact?.slot, { startMinutes: 10 * 60 + 15, endMinutes: 10 * 60 + 60 });
});

test("a named start time is honoured when free and ignored when busy", () => {
  const free = captureImpact(input(), candidate({ startMinutes: 15 * 60 }));
  assert.deepEqual(free?.slot, { startMinutes: 15 * 60, endMinutes: 15 * 60 + 45 });
  const busy = captureImpact(
    input({ blocks: [block("2026-03-13T14:30", "2026-03-13T15:30")] }),
    candidate({ startMinutes: 15 * 60 }),
  );
  assert.deepEqual(busy?.slot, { startMinutes: 8 * 60, endMinutes: 8 * 60 + 45 });
});

test("findSlot is exported for the card's own use", () => {
  const window: WorkWindow = { startMinutes: 8 * 60, endMinutes: 10 * 60 };
  assert.deepEqual(findSlot([{ startMinutes: 480, endMinutes: 540 }], window, 60, null), { startMinutes: 540, endMinutes: 600 });
  assert.equal(findSlot([{ startMinutes: 480, endMinutes: 540 }], window, 61, null), null);
});

test("no due day, a past day or an invalid estimate yields no impact", () => {
  assert.equal(captureImpact(input(), candidate({ dueDay: null })), null);
  assert.equal(captureImpact(input(), candidate({ dueDay: "2026-03-10" })), null);
  assert.equal(captureImpact(input(), candidate({ dueDay: "not-a-day" })), null);
  const odd = captureImpact(input(), candidate({ estimateMinutes: Number.NaN }));
  assert.equal(odd?.estimateMinutes, ASSUMED_ESTIMATE_MINUTES);
  assert.equal(odd?.assumed, true);
});

test("the candidate can tip a deadline into overcommit", () => {
  const tight = input({
    workWindow: { startMinutes: 8 * 60, endMinutes: 10 * 60 },
    tasks: [{ id: "a", title: "Existing", deadline: FRIDAY, estimate: 300 }],
  });
  const impact = captureImpact(tight, candidate({ estimateMinutes: 60 }));
  assert.ok(impact);
  assert.equal(impact.overcommit.before, null);
  assert.deepEqual(impact.overcommit.after, { deadline: FRIDAY, committedMinutes: 360, freeMinutes: 345, overMinutes: 15 });
  // A candidate that fits leaves both null.
  assert.deepEqual(captureImpact(tight, candidate({ estimateMinutes: 30 }))?.overcommit, { before: null, after: null });
});

test("the live planner is not mutated", () => {
  const tasks = [{ id: "a", title: "Existing", deadline: FRIDAY, estimate: 30 }];
  const blocks = [block("2026-03-13T08:00", "2026-03-13T09:00")];
  const snapshot = JSON.stringify({ tasks, blocks });
  captureImpact(input({ tasks, blocks }), candidate());
  assert.equal(JSON.stringify({ tasks, blocks }), snapshot);
});

function paced(title: string, ratio: number, count: number): BiasSample[] {
  return Array.from({ length: count }, () => ({ title, estimate: 60, actualMinutes: Math.round(60 * ratio) }));
}

test("the bias chip shows the user's pace and the padded minutes, never applied", () => {
  const impact = captureImpact(
    input({ samples: paced("Budget report", 1.3, 3) }),
    candidate({ title: "Send Q3 budget", estimateMinutes: 45 }),
  );
  assert.ok(impact);
  assert.ok(impact.bias);
  assert.equal(impact.bias.percent, 30);
  assert.equal(impact.bias.minutes, 60);
  assert.equal(impact.bias.source, "keyed");
  // The radar still counts the stated estimate.
  assert.equal(impact.estimateMinutes, 45);
  assert.equal(impact.afterBookedMinutes, 45);
});

test("the bias chip is absent without history, on a neutral pace, and without a due day's impact", () => {
  assert.equal(captureImpact(input(), candidate())?.bias, null);
  assert.equal(captureImpact(input({ samples: paced("Budget report", 1, 6) }), candidate())?.bias, null);
});

test("a faster-than-estimated pace is a negative percent", () => {
  const impact = captureImpact(input({ samples: paced("Budget report", 0.7, 3) }), candidate());
  assert.equal(impact?.bias?.percent, -30);
});

import assert from "node:assert/strict";
import test from "node:test";
import { monthCells, quickDates, shiftDay, shiftMonth, shiftYear, weekdayOf, weekEdges } from "./monthGrid.ts";
import { dateKey } from "./time.ts";

test("a month is always six rows of seven day keys", () => {
  for (const month of ["2026-02", "2026-10", "2027-02", "2024-02"]) {
    for (const weekStart of [0, 1, 6]) {
      const cells = monthCells(month, weekStart);
      assert.equal(cells.length, 42, `${month} start ${weekStart}`);
      assert.ok(cells.every(key => /^\d{4}-\d{2}-\d{2}$/.test(key)));
      assert.ok(cells.includes(`${month}-01`));
      // consecutive days, no gaps or repeats
      for (let index = 1; index < cells.length; index += 1) assert.equal(cells[index], shiftDay(cells[index - 1], 1));
    }
  }
});

test("a Monday-first grid starts on the Monday on or before the 1st", () => {
  // October 2026 begins on a Thursday.
  const cells = monthCells("2026-10", 1);
  assert.equal(cells[0], "2026-09-28");
  assert.equal(weekdayOf(cells[0]), 1);
  assert.equal(cells[3], "2026-10-01");
  assert.equal(cells[41], "2026-11-08");
  // a month whose 1st is a Monday starts exactly on it
  assert.equal(monthCells("2026-06", 1)[0], "2026-06-01");
});

test("a Sunday-first grid starts on the Sunday on or before the 1st", () => {
  const cells = monthCells("2026-10", 0);
  assert.equal(cells[0], "2026-09-27");
  assert.equal(weekdayOf(cells[0]), 0);
  assert.equal(cells[4], "2026-10-01");
  // a month whose 1st is a Sunday starts exactly on it
  assert.equal(monthCells("2026-02", 0)[0], "2026-02-01");
});

test("shifting a day crosses month, year and leap-day edges", () => {
  assert.equal(shiftDay("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftDay("2026-02-28", 1), "2026-03-01");
  assert.equal(shiftDay("2026-10-28", 7), "2026-11-04");
  assert.equal(shiftDay("2026-10-28", -7), "2026-10-21");
  // DST changes do not shift calendar days (wall-UTC arithmetic)
  assert.equal(shiftDay("2026-03-07", 2), "2026-03-09");
  assert.equal(shiftDay("2026-10-31", 2), "2026-11-02");
});

test("shifting a month clamps the day to the target month's length", () => {
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftMonth("2024-01-31", 1), "2024-02-29");
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftMonth("2026-10-30", 1), "2026-11-30");
  assert.equal(shiftMonth("2026-10-31", 1), "2026-11-30");
  assert.equal(shiftMonth("2026-12-15", 1), "2027-01-15");
  assert.equal(shiftMonth("2026-01-15", -1), "2025-12-15");
  assert.equal(shiftMonth("2026-10-15", 14), "2027-12-15");
  assert.equal(shiftMonth("2026-10-15", -10), "2025-12-15");
});

test("shifting a year clamps Feb 29 to Feb 28 and keeps everything else", () => {
  assert.equal(shiftYear("2024-02-29", 1), "2025-02-28");
  assert.equal(shiftYear("2024-02-29", 4), "2028-02-29");
  assert.equal(shiftYear("2026-10-28", -1), "2025-10-28");
  assert.equal(shiftYear("2026-10-28", 1), "2027-10-28");
});

test("week edges follow the week start", () => {
  // 2026-10-28 is a Wednesday.
  assert.deepEqual(weekEdges("2026-10-28", 1), { first: "2026-10-26", last: "2026-11-01" });
  assert.deepEqual(weekEdges("2026-10-28", 0), { first: "2026-10-25", last: "2026-10-31" });
  // the edge itself maps to itself
  assert.deepEqual(weekEdges("2026-10-26", 1), { first: "2026-10-26", last: "2026-11-01" });
  assert.deepEqual(weekEdges("2026-11-01", 1), { first: "2026-10-26", last: "2026-11-01" });
});

test("quick dates on every weekday (Monday week start)", () => {
  // 2026-10-26 is a Monday.
  const expected: Array<[string, string | null, string]> = [
    // [today, weekend, nextWeek]
    ["2026-10-26", "2026-10-31", "2026-11-02"], // Mon
    ["2026-10-27", "2026-10-31", "2026-11-02"], // Tue
    ["2026-10-28", "2026-10-31", "2026-11-02"], // Wed
    ["2026-10-29", "2026-10-31", "2026-11-02"], // Thu
    ["2026-10-30", null, "2026-11-02"], // Fri: Saturday is tomorrow
    ["2026-10-31", null, "2026-11-02"], // Sat: today
    ["2026-11-01", null, "2026-11-02"], // Sun: tomorrow is Monday
  ];
  for (const [today, weekend, nextWeek] of expected) {
    const quick = quickDates(today, 1);
    assert.equal(quick.today, today);
    assert.equal(quick.tomorrow, shiftDay(today, 1));
    assert.equal(quick.weekend, weekend, `weekend from ${today}`);
    assert.equal(quick.nextWeek, nextWeek, `next week from ${today}`);
  }
});

test("next week is the first week-start day strictly after today", () => {
  // Monday today: next Monday is seven days out, never today.
  assert.equal(quickDates("2026-10-26", 1).nextWeek, "2026-11-02");
  // Sunday-first: from a Wednesday, the next Sunday.
  assert.equal(quickDates("2026-10-28", 0).nextWeek, "2026-11-01");
  // Sunday today with a Sunday start is seven days out.
  assert.equal(quickDates("2026-11-01", 0).nextWeek, "2026-11-08");
});

test("quick dates cross month and year ends", () => {
  const quick = quickDates("2026-12-30", 1); // Wednesday
  assert.equal(quick.tomorrow, "2026-12-31");
  assert.equal(quick.weekend, "2027-01-02");
  assert.equal(quick.nextWeek, "2027-01-04");
});

test("quick dates follow the profile zone's midnight, not the browser's", () => {
  // Los Angeles leaves DST on 2026-11-01 (midnight local is 07:00Z): one
  // minute before it the zone is still on Saturday, though UTC is Sunday.
  const justBefore = new Date("2026-11-01T06:59:00Z");
  const justAfter = new Date("2026-11-01T07:00:00Z");
  const zone = "America/Los_Angeles";
  assert.equal(dateKey(justBefore, zone), "2026-10-31");
  assert.equal(dateKey(justAfter, zone), "2026-11-01");

  const saturday = quickDates(dateKey(justBefore, zone), 1);
  assert.equal(saturday.today, "2026-10-31");
  assert.equal(saturday.weekend, null);
  assert.equal(saturday.nextWeek, "2026-11-02");

  const sunday = quickDates(dateKey(justAfter, zone), 1);
  assert.equal(sunday.today, "2026-11-01");
  assert.equal(sunday.tomorrow, "2026-11-02");
  assert.equal(sunday.weekend, null);
  assert.equal(sunday.nextWeek, "2026-11-02");

  // the same two instants a zone east of UTC land on the other side of midnight
  assert.equal(dateKey(justBefore, "Asia/Tokyo"), "2026-11-01");
  assert.equal(quickDates(dateKey(new Date("2026-10-27T14:59:00Z"), "Asia/Tokyo"), 1).weekend, "2026-10-31");
  assert.equal(quickDates(dateKey(new Date("2026-10-27T15:00:00Z"), "Asia/Tokyo"), 1).today, "2026-10-28");
});

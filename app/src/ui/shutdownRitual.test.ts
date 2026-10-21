import assert from "node:assert/strict";
import test from "node:test";
import {
  bannerVisible,
  briefVisible,
  closeAnnouncement,
  firstFreeSlot,
  leftoverSummary,
  minutesLabel,
  morningBriefText,
  turnHint,
} from "./shutdownRitual.ts";

/**
 * The shutdown ritual's copy and arithmetic (distinctive roadmap F3, criteria
 * 1-8): what the sheet's summary reads, what the live region announces, when
 * the banner is up, and what the morning brief says. The components
 * (ui/ShutdownSheet.tsx, ui/MorningBrief.tsx) own rendering, the gesture and
 * the writes; every sentence they show is decided here so the wording can be
 * pinned without a browser.
 *
 * Day keys are the profile zone's calendar days (never instants), and the
 * weekday the announcement names is read from the day key itself, so two
 * devices in different zones agree on "tomorrow".
 */

test("the ritual's summary reads the two counts, and says nothing is left when nothing is", () => {
  assert.equal(leftoverSummary({ done: 3, leftOver: 2 }), "3 done · 2 left over");
  assert.equal(leftoverSummary({ done: 1, leftOver: 1 }), "1 done · 1 left over");
  // Criterion 2: a day with no leftovers says what to do instead of counting.
  assert.equal(leftoverSummary({ done: 0, leftOver: 0 }), "Nothing left over. Close the day.");
  assert.equal(leftoverSummary({ done: 3, leftOver: 0 }), "Nothing left over. Close the day.");
});

test("the announcement names the day the leftovers moved to", () => {
  // 2026-03-12 is a Thursday.
  assert.equal(closeAnnouncement({ moved: 2, tomorrowKey: "2026-03-12" }), "Day closed. 2 tasks moved to Thursday.");
  assert.equal(closeAnnouncement({ moved: 1, tomorrowKey: "2026-03-12" }), "Day closed. 1 task moved to Thursday.");
  // A close with nothing to roll still closed the day.
  assert.equal(closeAnnouncement({ moved: 0, tomorrowKey: "2026-03-12" }), "Day closed. Nothing moved.");
});

test("the banner is up from the shutdown time until the day is closed", () => {
  const day = "2026-03-10";
  const at = (wallMinutes: number, lastShutdown?: string) =>
    bannerVisible({ today: day, wallMinutes, shutdownTime: 18 * 60, lastShutdown });
  assert.equal(at(17 * 60 + 59), false);
  // At the shutdown minute, not only after it.
  assert.equal(at(18 * 60), true);
  assert.equal(at(20 * 60), true);
  // Criterion 6: a day already closed on any device shows no banner.
  assert.equal(at(20 * 60, day), false);
  // A stamp ahead of today (a zone change, a clock set back) also counts as
  // closed: it is never moved backwards, so the banner stays down.
  assert.equal(at(20 * 60, "2026-03-11"), false);
  // Yesterday's close says nothing about today.
  assert.equal(at(20 * 60, "2026-03-09"), true);
});

test("the morning brief states the day's blocks and the next free time", () => {
  assert.equal(
    morningBriefText({ blockCount: 4, firstStartMinutes: 9 * 60, firstFreeSlotMinutes: 10 * 60 + 30 }),
    "Today: 4 blocks, first at 09:00. First free slot 10:30.",
  );
  assert.equal(
    morningBriefText({ blockCount: 1, firstStartMinutes: 9 * 60, firstFreeSlotMinutes: 10 * 60 + 30 }),
    "Today: 1 block, first at 09:00. First free slot 10:30.",
  );
  // No free time left: the brief says what it knows and nothing it does not.
  assert.equal(morningBriefText({ blockCount: 4, firstStartMinutes: 9 * 60 }), "Today: 4 blocks, first at 09:00.");
  // A day with nothing on it has nothing to brief.
  assert.equal(morningBriefText({ blockCount: 0 }), null);
});

test("the brief is shown once a day and only when the day has blocks", () => {
  const today = "2026-03-10";
  assert.equal(briefVisible({ storedDay: null, today, blockCount: 2 }), true);
  assert.equal(briefVisible({ storedDay: "2026-03-09", today, blockCount: 2 }), true);
  assert.equal(briefVisible({ storedDay: today, today, blockCount: 2 }), false);
  assert.equal(briefVisible({ storedDay: null, today, blockCount: 0 }), false);
});

test("the first free slot is the first stretch of the day still ahead", () => {
  const window = { startMinutes: 8 * 60, endMinutes: 21 * 60 };
  // One chain 09:00-10:30, read at 10:00: the day is booked until 10:30.
  const booked = [{ startMinutes: 9 * 60, endMinutes: 10 * 60 + 30 }];
  assert.equal(firstFreeSlot(booked, window, 10 * 60), 10 * 60 + 30);
  // The same day read before it starts offers the morning.
  assert.equal(firstFreeSlot(booked, window, 8 * 60), 8 * 60);
  // A full window has no free slot at all.
  assert.equal(firstFreeSlot([{ startMinutes: 8 * 60, endMinutes: 21 * 60 }], window, 8 * 60), undefined);
  // The 10-minute gap between 10:50 and 11:00 is not a slot to plan into; the
  // day is free from 12:00 on.
  assert.equal(
    firstFreeSlot([{ startMinutes: 8 * 60, endMinutes: 10 * 60 + 50 }, { startMinutes: 11 * 60, endMinutes: 12 * 60 }], window, 8 * 60),
    12 * 60,
  );
});

test("minutes read as a clock, and the hint follows the pointer", () => {
  assert.equal(minutesLabel(9 * 60), "09:00");
  assert.equal(minutesLabel(10 * 60 + 30), "10:30");
  assert.equal(minutesLabel(0), "00:00");
  assert.equal(turnHint({ touch: true }), "Swipe left to close the day");
  assert.equal(turnHint({ touch: false }), "Drag left, or press Close day");
});

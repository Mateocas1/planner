import assert from "node:assert/strict";
import test from "node:test";
import {
  bannerVisible,
  briefExpired,
  briefVisible,
  claimCloseDay,
  closeAnnouncement,
  closeDayKey,
  closeFailedMessage,
  dayChangedMessage,
  firstFreeSlot,
  hasFreeTimeAhead,
  lateCloseFailure,
  leftoverSummary,
  minutesLabel,
  morningBriefState,
  morningBriefText,
  releaseCloseDay,
  turnHint,
  undoMessage,
} from "./shutdownRitual.ts";
import { setDeviceLanguage } from "../i18n/index.ts";

test("the brief state counts only the blocks that start today, in the planner's zone", () => {
  const state = morningBriefState({
    blocks: [
      { start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z" },
      { start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:00:00Z" },
    ],
    timeZone: "UTC",
    workWindow: { startMinutes: 480, endMinutes: 1080 },
    now: new Date("2026-10-22T10:30:00Z"),
  });
  assert.deepEqual(state, {
    today: "2026-10-22",
    blockCount: 1,
    text: null,
  });
  // Before the first block starts the brief says what it knows.
  const morning = morningBriefState({
    blocks: [{ start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:00:00Z" }],
    timeZone: "UTC",
    workWindow: { startMinutes: 480, endMinutes: 1080 },
    now: new Date("2026-10-22T08:30:00Z"),
  });
  assert.deepEqual(morning, {
    today: "2026-10-22",
    blockCount: 1,
    text: "Today: 1 block, first at 09:00. First free slot 08:00.",
  });
  const empty = morningBriefState({ blocks: [], timeZone: "UTC", workWindow: { startMinutes: 480, endMinutes: 1080 }, now: new Date("2026-10-22T10:30:00Z") });
  assert.deepEqual(empty, { today: "2026-10-22", blockCount: 0, text: null });
});

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

/**
 * The data-safety findings of the F3c review, pinned where the sheet gets its
 * decisions from: what a rejected close says and takes back (S2), what undo
 * says in every ending (S1/S2), and one close in flight per owner and day (S4).
 * The sentences are the sheet's own copy, so they are asserted verbatim.
 */

test("a close the server rejected says nothing changed and withdraws its undo offer", () => {
  // Criterion 5's sentence: one batch, so a rejected batch changed nothing.
  assert.equal(closeFailedMessage(), "Couldn't close the day. Nothing changed.");
  assert.deepEqual(lateCloseFailure(), { message: closeFailedMessage(), withdrawUndo: true });
});

test("the day a sheet outlived is re-read instead of closed", () => {
  assert.equal(dayChangedMessage(), "The day changed. Review it again.");
});

test("undo says what each ending means, and never blames a later close for a rejected one", () => {
  // An undo that did its work has nothing to say.
  assert.equal(undoMessage({ kind: "reverted" }), null);
  // A roll that never happened is not a failure to revert.
  assert.equal(undoMessage({ kind: "refused", refusal: "nothing-applied" }), null);
  assert.equal(undoMessage({ kind: "refused", refusal: "later-close" }), "The day was closed again, so nothing was undone.");
  // A write accepted locally and rejected by the server must not return to
  // Today silently (S1).
  assert.equal(undoMessage({ kind: "unsaved" }), "The undo could not be saved.");
  /* S2: the close whose batch the server rejected never closed the day, so its
     undo reports the failed close rather than a later close nobody made. */
  assert.equal(undoMessage({ kind: "rejected" }), closeFailedMessage());
  assert.notEqual(undoMessage({ kind: "rejected" }), undoMessage({ kind: "refused", refusal: "later-close" }));
});

/**
 * The transport under the ritual's retraction (S2). `ui/write.ts` is the only
 * place that knows a write can be accepted locally and rejected later, and the
 * ritual's retraction hangs off exactly that: the closure that withdraws the
 * undo offer must receive the rejection, and must receive nothing while the
 * write may still land. A browser test cannot force the emulator to reject an
 * owner's write, so this is pinned here, with the one global it needs.
 */
test("a write rejected after its local acceptance is reported to the closure that retracts it", async () => {
  const { settleTracked } = await import("./write.ts");
  const globals = globalThis as { window?: unknown };
  const saved = globals.window;
  globals.window = { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms) };
  try {
    // Accepted, then refused: the close had already been announced by then.
    let rejectWrite: (cause: unknown) => void = () => {};
    const late = new Promise((_, fail) => {
      rejectWrite = fail;
    });
    const tracked = settleTracked(late);
    await tracked.accepted;
    rejectWrite(new Error("Missing or insufficient permissions."));
    assert.equal(await tracked.late, "Missing or insufficient permissions.");

    // Refused before the accept beat: the caller has not closed yet, so the
    // rejection is still its own to handle and the retraction stays quiet.
    const early = new Promise((_, fail) => {
      setTimeout(() => fail(new Error("invalid day")), 0);
    });
    await assert.rejects(settleTracked(early).accepted, /invalid day/);

    // Landed: there is nothing to retract, so `late` never resolves.
    const landed = settleTracked(Promise.resolve("written"));
    await landed.accepted;
    assert.equal(
      await Promise.race([landed.late, new Promise(resolve => setTimeout(() => resolve("pending"), 20))]),
      "pending",
    );
  } finally {
    globals.window = saved;
  }
});

test("one close of a day is in flight, and only one", () => {
  assert.equal(claimCloseDay("ada", "2026-05-04"), true);
  // A sheet reopened while the batch is pending cannot start a second close.
  assert.equal(claimCloseDay("ada", "2026-05-04"), false);
  // Another day, or another owner, is a different close.
  assert.equal(claimCloseDay("ada", "2026-05-05"), true);
  assert.equal(claimCloseDay("grace", "2026-05-04"), true);
  // The claim is released when the batch is accepted or abandoned.
  releaseCloseDay("ada", "2026-05-04");
  assert.equal(claimCloseDay("ada", "2026-05-04"), true);
  /* Keys cannot collide across an owner/day boundary: two fragments that read
     the same joined with one character are different closes. */
  assert.notEqual(closeDayKey("a/b", "c"), closeDayKey("a", "b/c"));
  assert.notEqual(closeDayKey("a", "b/c"), closeDayKey("a/b", "c"));
  for (const [uid, day] of [["ada", "2026-05-04"], ["ada", "2026-05-05"], ["grace", "2026-05-04"]] as const) {
    releaseCloseDay(uid, day);
  }
});

test("minutes read as a clock, and the hint follows the pointer", () => {
  assert.equal(minutesLabel(9 * 60), "09:00");
  assert.equal(minutesLabel(10 * 60 + 30), "10:30");
  assert.equal(minutesLabel(0), "00:00");
  assert.equal(turnHint({ touch: true }), "Swipe left to close the day");
  assert.equal(turnHint({ touch: false }), "Drag left, or press Close day");
});

test("the brief is over once the first block has started or at noon, whichever comes first", () => {
  // Before the first block: still the morning's brief.
  assert.equal(briefExpired({ nowMinutes: 8 * 60 + 59, firstStartMinutes: 9 * 60 }), false);
  // The first block has started: the day is under way, the brief has nothing to add.
  assert.equal(briefExpired({ nowMinutes: 9 * 60, firstStartMinutes: 9 * 60 }), true);
  // A late first block does not keep the brief past noon.
  assert.equal(briefExpired({ nowMinutes: 11 * 60 + 59, firstStartMinutes: 14 * 60 }), false);
  assert.equal(briefExpired({ nowMinutes: 12 * 60, firstStartMinutes: 14 * 60 }), true);
  // No blocks: there is no first start, only the noon rule.
  assert.equal(briefExpired({ nowMinutes: 10 * 60 }), false);
  assert.equal(briefExpired({ nowMinutes: 17 * 60 + 30 }), true);
});

test("the brief state drops the sentence after 12:00 even when the first block is still ahead", () => {
  const state = morningBriefState({
    blocks: [{ start: "2026-10-22T15:00:00Z", end: "2026-10-22T16:00:00Z" }],
    timeZone: "UTC",
    workWindow: { startMinutes: 480, endMinutes: 1080 },
    now: new Date("2026-10-22T12:00:00Z"),
  });
  assert.equal(state.text, null);
  assert.equal(state.blockCount, 1);
});

test("free time ahead is any stretch of the work window of 15 minutes or more after now", () => {
  const window = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
  // Empty day at 17:30, window closed at 17:00: nothing left to plan into.
  assert.equal(hasFreeTimeAhead([], window, 17 * 60 + 30), false);
  // Mid-afternoon on an empty day: plenty.
  assert.equal(hasFreeTimeAhead([], window, 14 * 60), true);
  // Planning starts at the next quarter hour; less than 15 minutes of window left is no room.
  assert.equal(hasFreeTimeAhead([], window, 16 * 60 + 50), false);
  // A block to the window's end leaves nothing after it.
  assert.equal(hasFreeTimeAhead([{ startMinutes: 13 * 60, endMinutes: 17 * 60 }], window, 13 * 60 + 30), false);
  // A gap before a later block counts.
  assert.equal(hasFreeTimeAhead([{ startMinutes: 15 * 60, endMinutes: 17 * 60 }], window, 13 * 60 + 30), true);
});

test("the ritual's sentences follow the language", () => {
  setDeviceLanguage("es");
  try {
    assert.equal(closeFailedMessage(), "No se pudo cerrar el día. No ha cambiado nada.");
    assert.equal(leftoverSummary({ done: 3, leftOver: 2 }), "3 hechas · 2 pendientes");
    assert.equal(morningBriefText({ blockCount: 1, firstStartMinutes: 540, firstFreeSlotMinutes: 630 }), "Hoy: 1 bloque, el primero a las 09:00. Primer hueco libre 10:30.");
    assert.equal(morningBriefText({ blockCount: 4, firstStartMinutes: 540 }), "Hoy: 4 bloques, el primero a las 09:00.");
    assert.match(closeAnnouncement({ moved: 2, tomorrowKey: "2026-10-29" }), /^Día cerrado\. 2 tareas movidas a jueves\.$/);
  } finally {
    setDeviceLanguage(null);
  }
});

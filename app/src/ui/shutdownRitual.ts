import { freeSlots, type Interval, type WorkWindow } from "../planning/window.ts";
import { isDayKey, type UndoRefusal } from "../planning/shutdown.ts";
import { t } from "../i18n/index.ts";
import { dateKey, formatWall, keyToWallUtc, pad, wallMinutes } from "./time.ts";

/**
 * The shutdown ritual's words and thresholds (distinctive roadmap F3).
 *
 * The ritual itself is three surfaces over data that already exists: the Home
 * banner, the sheet with its Today and Tomorrow pages, and the morning brief.
 * This module owns every sentence they show and the two decisions that are
 * arithmetic rather than rendering -- is the banner up, and is the brief shown
 * -- so the copy of criteria 1, 2, 5 and 7 is pinned by unit tests and no
 * component invents a wording of its own. It also owns the two decisions the
 * data-safety review of F3c added: what an undo says in each of its endings,
 * and the fact that one owner's one day has at most one close in flight.
 *
 * Nothing here reads a clock, a document or the DOM: the caller hands in the
 * profile zone's today, the zone's wall-clock minutes, and what the store
 * holds. Day keys are the zone's calendar days (`YYYY-MM-DD`), never instants,
 * which is what keeps a close correct across a clock skew or a zone change
 * (roadmap §2 F3, "Risks").
 */

/** Criterion 5: one batch, so a refused write changed nothing at all. */
export const closeFailedMessage = (): string => t("shutdown.closeFailed");

/** The toast's sentence; its `Undo` action is the undo toast's own button. */
export const closeToastMessage = (): string => t("shutdown.closeToast");

/**
 * The sheet outlived its own day: it stayed open past midnight, so committing
 * would close the day the page under it used to be. Nothing is written and the
 * sheet re-reads the day instead (F3c review item 2).
 */
export const dayChangedMessage = (): string => t("shutdown.dayChanged");

/** An undo whose write was accepted locally and then rejected by the server. */
export const undoFailedMessage = (): string => t("shutdown.undoFailed");

/** Undo found the profile stamped by a close that is not the one it reverts. */
export const laterCloseMessage = (): string => t("shutdown.laterClose");

/**
 * A close the server rejected after the sheet had already turned the page and
 * announced it (F3c review item 5). The day is not closed, so the page returns
 * to Today with criterion 5's sentence and the undo offer is withdrawn: it
 * promised to revert a batch that never landed.
 */
export function lateCloseFailure(): { message: string; withdrawUndo: true } {
  return { message: closeFailedMessage(), withdrawUndo: true };
}

/**
 * Why an undo ended where it did: it reverted, it refused (nothing was applied,
 * or a later close owns the stamp), its write was accepted locally and rejected
 * by the server, or the close it belongs to was itself rejected.
 */
export type UndoOutcome =
  | { kind: "reverted" }
  | { kind: "refused"; refusal: UndoRefusal }
  | { kind: "unsaved" }
  | { kind: "rejected" };

/**
 * The sentence an undo owes, or null when it did what it promised.
 *
 * A rejection is never a later close: the batch Undo would have reverted was
 * refused by the server, so the day was never closed, and saying a later close
 * took it would describe a write nobody made (F3c review items 4 and 5).
 */
export function undoMessage(outcome: UndoOutcome): string | null {
  switch (outcome.kind) {
    case "reverted":
      return null;
    case "refused":
      return outcome.refusal === "later-close" ? laterCloseMessage() : null;
    case "unsaved":
      return undoFailedMessage();
    case "rejected":
      return closeFailedMessage();
  }
}

/**
 * The closes in flight, keyed by owner and day (F3c review item 1).
 *
 * A close is in flight from the commit until Firestore accepts the batch
 * locally, which is exactly the window in which the store does not hold the
 * close yet. The sheet that committed can be dismissed and reopened inside it,
 * and a second close would then plan against that older store. The guard is
 * module-level because it must outlive the sheet instance that claimed it.
 */
const closesInFlight = new Set<string>();

/** One key per owner and day; the NUL keeps two fragments from colliding. */
export function closeDayKey(uid: string, today: string): string {
  return `${uid}\u0000${today}`;
}

/**
 * Claims the close of one day. False means another close of the same owner and
 * day is still in flight, and this caller must not start a second batch.
 */
export function claimCloseDay(uid: string, today: string): boolean {
  const key = closeDayKey(uid, today);
  if (closesInFlight.has(key)) return false;
  closesInFlight.add(key);
  return true;
}

/** Releases the claim, once the batch is accepted locally or abandoned. */
export function releaseCloseDay(uid: string, today: string): void {
  closesInFlight.delete(closeDayKey(uid, today));
}

/**
 * Where the brief remembers that it was dismissed. Keyed by the profile zone's
 * day: a dismissal is for that day's brief, not forever, and tomorrow's brief
 * is a different day. `localStorage`, not the profile document: a dismissal is
 * a property of this device's morning, not of the planner.
 */
export const briefStorageKey = "planner-brief-dismissed";

/** `09:30` from 570: the wall clock the ritual and the brief write. */
export function minutesLabel(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * The ritual's Today page counts what the day left behind (criteria 1 and 2).
 * Both counts are bare numbers: "3 done · 2 left over" is a summary of two
 * lists, and a day with no leftovers gets the one sentence that names the
 * action instead of a pair of zeros.
 */
export function leftoverSummary(input: { done: number; leftOver: number }): string {
  if (input.leftOver === 0) return t("shutdown.summary.none");
  return t("shutdown.summary.counts", { done: input.done, leftOver: input.leftOver });
}

/**
 * Criterion 3's live region: what the close did, in the day it did it to.
 *
 * The weekday is read from the day key through the one wall-clock formatter
 * (`ui/time.ts`), not from a `Date` built off the ambient zone: "tomorrow" is
 * the profile zone's tomorrow, and a device in another zone reads the same day.
 */
export function closeAnnouncement(input: { moved: number; tomorrowKey: string }): string {
  const weekday = formatWall(keyToWallUtc(input.tomorrowKey), { weekday: "long" });
  if (input.moved === 0) return t("shutdown.announce.none");
  return t("shutdown.announce.moved", { count: input.moved, weekday });
}

/**
 * Criterion 6: the banner belongs to the end of an open day. It appears at the
 * shutdown minute (not only after it), and it is gone once the profile says the
 * day was closed -- on this device or on any other.
 *
 * The stamp is compared as a day key and never as an instant: `>= today` counts
 * as closed, because a stamp ahead of the local today is what a changed profile
 * zone or a clock set back leaves behind, and the roll never moves a stamp
 * backwards (`planning/shutdown.ts`). Yesterday's close says nothing about
 * today.
 */
export function bannerVisible(input: {
  today: string;
  wallMinutes: number;
  shutdownTime: number;
  lastShutdown?: unknown;
}): boolean {
  if (input.wallMinutes < input.shutdownTime) return false;
  const last = input.lastShutdown;
  return !(isDayKey(last) && last >= input.today);
}

/**
 * Criterion 7: the morning brief is the first thing a new day says. It waits
 * for the day to have something on it ("nothing when the day is empty"), and it
 * is dismissed for the rest of that day only.
 */
export function briefVisible(input: { storedDay: string | null; today: string; blockCount: number }): boolean {
  if (input.blockCount === 0) return false;
  return input.storedDay !== input.today;
}

/** After this wall-clock minute (12:00) the morning brief is over, whatever the blocks say. */
export const briefEndMinutes = 12 * 60;

/**
 * The brief is the morning's: it is over once the day's first block has
 * started (the day is under way, the sentence would describe the past) and at
 * noon at the latest, which also covers a day whose first block is late. A day
 * with no blocks has no first start and only the noon rule applies.
 */
export function briefExpired(input: { nowMinutes: number; firstStartMinutes?: number }): boolean {
  if (input.nowMinutes >= briefEndMinutes) return true;
  return input.firstStartMinutes !== undefined && input.nowMinutes >= input.firstStartMinutes;
}

/**
 * Criterion 7's sentence: `Today: 4 blocks, first at 09:00. First free slot
 * 10:30.` The free-slot clause is dropped when the working window has no free
 * stretch left, and the whole line is dropped when the day has no blocks.
 */
export function morningBriefText(input: {
  blockCount: number;
  firstStartMinutes?: number;
  firstFreeSlotMinutes?: number;
}): string | null {
  if (input.blockCount === 0) return null;
  const count = input.blockCount;
  const first = input.firstStartMinutes === undefined ? undefined : minutesLabel(input.firstStartMinutes);
  const free = input.firstFreeSlotMinutes === undefined ? undefined : minutesLabel(input.firstFreeSlotMinutes);
  if (first !== undefined && free !== undefined) return t("brief.full", { count, first, free });
  if (first !== undefined) return t("brief.noFree", { count, first });
  if (free !== undefined) return t("brief.noFirst", { count, free });
  return t("brief.plain", { count });
}

/**
 * The brief's day state, computed from the blocks and clock the Home screen
 * reads. Home renders from it and so does the desktop sign-in launch
 * (`desktop-autostart.ts`), so both agree on whether today's brief applies.
 */
export function morningBriefState(input: {
  blocks: readonly { start: string; end: string }[];
  timeZone: string;
  workWindow: WorkWindow;
  now: Date;
}): { today: string; blockCount: number; text: string | null } {
  const today = dateKey(input.now, input.timeZone);
  const todays = input.blocks
    .filter(block => dateKey(new Date(block.start), input.timeZone) === today)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const nowMinutes = wallMinutes(input.now, input.timeZone);
  const firstStartMinutes = todays.length === 0 ? undefined : wallMinutes(new Date(todays[0].start), input.timeZone);
  const expired = briefExpired({ nowMinutes, firstStartMinutes });
  const text = expired ? null : morningBriefText({
    blockCount: todays.length,
    firstStartMinutes,
    firstFreeSlotMinutes: firstFreeSlot(
      todays.map(block => {
        const startMinutes = wallMinutes(new Date(block.start), input.timeZone);
        const endMinutes = wallMinutes(new Date(block.end), input.timeZone);
        return { startMinutes, endMinutes: endMinutes <= startMinutes ? 1440 : endMinutes };
      }),
      input.workWindow,
      nowMinutes,
    ),
  });
  return { today, blockCount: todays.length, text };
}

/** The day the brief was dismissed on this device. A browser that refuses
 *  storage (private modes, hardened browsers throw on access) reads as none. */
export function readBriefDismissal(): string | null {
  try {
    return window.localStorage.getItem(briefStorageKey);
  } catch {
    return null;
  }
}

export function writeBriefDismissal(day: string): void {
  try {
    window.localStorage.setItem(briefStorageKey, day);
  } catch {
    // A browser that refuses storage still gets a dismissal for this mount.
  }
}

/**
 * The first free stretch of the day that is still ahead, as the minute it
 * starts at. "Still ahead" is what a person means by the brief's "First free
 * slot": a gap whose last 15 minutes have already gone by is not somewhere
 * work can go now.
 *
 * The slots themselves are `planning/window.ts`'s (one definition of free
 * time, shared with the radar and plan-my-day), read from the window's start so
 * a gap that began before `nowMinutes` is still the day's first free slot.
 */
export function firstFreeSlot(
  items: readonly Interval[],
  window: WorkWindow,
  nowMinutes: number,
  minimumMinutes = 15,
): number | undefined {
  for (const [start, end] of freeSlots(items, window, null)) {
    if (end <= nowMinutes) continue;
    if (end - Math.max(start, nowMinutes) < minimumMinutes) continue;
    return start;
  }
  return undefined;
}

/**
 * Whether any part of the work window is still free ahead of `nowMinutes`:
 * what Plan my day can place into. Uses `freeSlots` from the quarter hour after
 * now, the same start `planDay` plans from, so the button and the plan agree.
 */
export function hasFreeTimeAhead(
  items: readonly Interval[],
  window: WorkWindow,
  nowMinutes: number,
  minimumMinutes = 15,
): boolean {
  return freeSlots(items, window, nowMinutes).some(([start, end]) => end - start >= minimumMinutes);
}

/**
 * The sheet's hint names the gesture that works on this device: a thumb swipes,
 * a mouse drags, and only a fine pointer has a `Close day` button to press.
 */
export function turnHint(input: { touch: boolean }): string {
  return input.touch ? t("shutdown.hint.touch") : t("shutdown.hint.pointer");
}

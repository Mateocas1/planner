/**
 * The weekly review's pure half (S3, ronda 2 task W2a): the Rituals settings
 * model, the ISO week identity, the per-week review state, the moment that is
 * due now, the week's review numbers, and the clean-up candidates.
 *
 * No Firebase, no React, no clock: the caller supplies `now` and the profile
 * zone, and gets back data — the same shape `planning/shutdown.ts` uses. The
 * flow UI, the nudges and the Rituals settings rows (W2b) consume this module;
 * `data/weeklyReview.ts` persists what it computes.
 *
 * Day numbers follow JavaScript's `Date.getDay` convention: 0 is Sunday and 6
 * is Saturday. Ordering inside the ISO week (Monday first) goes through
 * `weekDayIndex`, because the week the review belongs to is an ISO week.
 *
 * Wall-clock reading goes through `ui/time.ts` (the one implementation), so a
 * 23- or 25-hour DST day keeps its wall clock and the zone never comes from
 * the browser.
 */

import { MIN_ACTUAL_MINUTES } from "./bias.ts";
import { dateKey, dayMs, keyToWallUtc, mondayOf, todayWallUtc, wallAsUtc, wallDayKey, wallMinutes } from "../ui/time.ts";

/** The four steps one review walks through, in flow order (S3). */
export type WeeklyReviewStep = "review" | "cleanup" | "plan" | "reflect";

/** The step values a stored document may hold; the closed set readers accept. */
export const weeklyReviewSteps: readonly WeeklyReviewStep[] = ["review", "cleanup", "plan", "reflect"];

function isWeeklyReviewStep(value: unknown): value is WeeklyReviewStep {
  return typeof value === "string" && (weeklyReviewSteps as readonly string[]).includes(value);
}

/** One scheduled moment: the zone's weekday (`day`), the wall-clock minute it
 *  opens (`time`, minutes after midnight), and the steps it runs. */
export type WeeklyMoment = { day: number; time: number; steps: WeeklyReviewStep[] };

/** The Rituals settings (S3): whether the review proposes itself, and when. */
export type WeeklyReviewSettings = { nudges: boolean; moments: WeeklyMoment[] };

/** Friday 17:00 — Review, Clean up, Reflect — and Sunday 19:00 — Plan (L2).
 *  Days are JavaScript weekday numbers: 0 is Sunday, 5 is Friday. */
export const defaultWeeklyReviewSettings: WeeklyReviewSettings = {
  nudges: true,
  moments: [
    { day: 5, time: 17 * 60, steps: ["review", "cleanup", "reflect"] },
    { day: 0, time: 19 * 60, steps: ["plan"] },
  ],
};

/** The longest reflection note a document may hold (S3: a short note). */
export const MAX_NOTE_CHARS = 2000;

/** How far "Later" pushes a nudge (L1b: +2 h). */
export const snoozeMinutes = 120;

/** 0=Sunday..6=Saturday, as stored, to Monday-first 0..6 inside the ISO week. */
export function weekDayIndex(day: number): number {
  const sundayFirst = ((day % 7) + 7) % 7;
  return (sundayFirst + 6) % 7;
}

/**
 * Rejects one moment the reader would drop: a weekday of the week, a
 * whole-minute time inside the day, and at least one known step (repeats
 * collapse to their first occurrence). This is the writer's guard — nothing
 * reaches the profile that `parseWeeklyReviewSettings` would silently replace.
 */
function requireMoment(moment: unknown, label: string): WeeklyMoment {
  if (moment === null || typeof moment !== "object") throw new Error(`${label} is invalid`);
  const value = moment as Record<string, unknown>;
  if (!Number.isInteger(value.day) || (value.day as number) < 0 || (value.day as number) > 6) {
    throw new Error(`${label} day must be a weekday 0 (Sunday) through 6 (Saturday)`);
  }
  if (!Number.isInteger(value.time) || (value.time as number) < 0 || (value.time as number) >= 1440) {
    throw new Error(`${label} time must be a whole minute count between 0 and 1439`);
  }
  if (!Array.isArray(value.steps)) throw new Error(`${label} steps must be a list`);
  const steps: WeeklyReviewStep[] = [];
  for (const step of value.steps) {
    if (!isWeeklyReviewStep(step)) throw new Error(`${label} steps must be review, cleanup, plan or reflect`);
    if (!steps.includes(step)) steps.push(step);
  }
  if (steps.length === 0) throw new Error(`${label} must run at least one step`);
  return { day: value.day as number, time: value.time as number, steps };
}

/**
 * Validates the whole settings object before a write. Throws on anything the
 * reader would replace, so the Rituals settings never store a schedule they
 * cannot read back.
 */
export function validateWeeklyReviewSettings(settings: WeeklyReviewSettings): void {
  if (typeof settings.nudges !== "boolean") throw new Error("nudges must be a boolean");
  if (!Array.isArray(settings.moments)) throw new Error("moments must be a list");
  for (const moment of settings.moments) requireMoment(moment, "weekly review moment");
}

/**
 * Reads the weekly review settings out of the profile document. An absent
 * field, or one a hand-edited document or older client mangled, reads as the
 * defaults (Friday 17:00 and Sunday 19:00, nudges on): readers never fail.
 * A malformed moment is dropped whole — half a moment is not a schedule
 * anybody wrote — and a `moments` field that is not a list, or that leaves no
 * valid moment, falls back to the defaults.
 */
export function parseWeeklyReviewSettings(data: Record<string, unknown> | undefined): WeeklyReviewSettings {
  const stored = data?.weeklyReview;
  if (stored === null || typeof stored !== "object") return defaultWeeklyReviewSettings;
  const value = stored as Record<string, unknown>;
  const nudges = typeof value.nudges === "boolean" ? value.nudges : defaultWeeklyReviewSettings.nudges;
  if (!Array.isArray(value.moments)) return { nudges, moments: defaultWeeklyReviewSettings.moments };
  const moments: WeeklyMoment[] = [];
  for (const moment of value.moments) {
    try {
      moments.push(requireMoment(moment, "weekly review moment"));
    } catch {
      // A malformed moment is dropped, not repaired: a repaired schedule is a
      // schedule nobody wrote.
    }
  }
  if (moments.length === 0) return { nudges, moments: defaultWeeklyReviewSettings.moments };
  return { nudges, moments };
}

/** One review per ISO week, named `YYYY-Www` (e.g. `2026-W43`). */
export type WeekIdentity = { week: string; monday: string; sunday: string };

const weekKeyPattern = /^\d{4}-W\d{2}$/;

export function isWeekKey(value: unknown): value is string {
  return typeof value === "string" && weekKeyPattern.test(value);
}

/** The ISO week (`YYYY-Www`) a Monday's wall-UTC value opens. */
function isoWeekOfMonday(mondayWallUtc: number): string {
  const thursday = new Date(mondayWallUtc + 3 * dayMs);
  const year = thursday.getUTCFullYear();
  const januaryFirst = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - januaryFirst) / dayMs / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The ISO week an instant falls on, in the given zone: its week key and the
 * Monday and Sunday day keys that bound it. The week belongs to the profile
 * zone, not to the browser's, exactly like the planner's calendar days.
 */
export function weekOfInstant(now: Date, timeZone: string): WeekIdentity {
  const monday = mondayOf(todayWallUtc(timeZone, now));
  return {
    week: isoWeekOfMonday(monday),
    monday: wallDayKey(monday),
    sunday: wallDayKey(monday + 6 * dayMs),
  };
}

/** The ISO week a day key falls on (the zone's calendar days are ISO days). */
export function weekOfDay(dayKey: string): WeekIdentity {
  const monday = mondayOf(keyToWallUtc(dayKey));
  return {
    week: isoWeekOfMonday(monday),
    monday: wallDayKey(monday),
    sunday: wallDayKey(monday + 6 * dayMs),
  };
}

/**
 * One week's review state: the steps already walked, whether the week was
 * skipped, and how long a "Later" holds the nudge. One document per week.
 */
export type WeeklyReviewState = {
  week: string;
  stepsDone: WeeklyReviewStep[];
  skipped: boolean;
  /** Zoned ISO instant; the nudge stays quiet until it passes. */
  snoozedUntil?: string;
};

/** A fresh week: nothing done, not skipped, not snoozed. */
export function emptyWeekState(week: string): WeeklyReviewState {
  if (!isWeekKey(week)) throw new Error(`week must be an ISO week key (YYYY-Www), got ${JSON.stringify(week)}`);
  return { week, stepsDone: [], skipped: false };
}

/**
 * Reads one week's state out of its document. Anything that is not a real
 * field of the week being read — another week's document, an unknown step, a
 * mangled snooze stamp — reads as absent rather than crashing the surface,
 * exactly like `parseLastShutdown`.
 */
export function parseWeeklyReviewState(data: Record<string, unknown> | undefined, week: string): WeeklyReviewState {
  const fresh = emptyWeekState(week);
  if (data === undefined || data.week !== week) return fresh;
  const stepsDone: WeeklyReviewStep[] = [];
  if (Array.isArray(data.stepsDone)) {
    for (const step of data.stepsDone) {
      if (isWeeklyReviewStep(step) && !stepsDone.includes(step)) stepsDone.push(step);
    }
  }
  const snoozedUntil = typeof data.snoozedUntil === "string" && Number.isFinite(Date.parse(data.snoozedUntil))
    ? data.snoozedUntil
    : undefined;
  return { week, stepsDone, skipped: data.skipped === true, ...(snoozedUntil === undefined ? {} : { snoozedUntil }) };
}

/** The reflection note exactly as it is stored: `{ week, text, createdAt }`. */
export type WeeklyReviewNote = { week: string; text: string; createdAt: string };

/**
 * Reads the reflection note out of a week's document. An absent, empty,
 * oversized or mangled note reads as no note — an unreadable note is not a
 * note anybody wrote.
 */
export function parseWeeklyReviewNote(data: Record<string, unknown> | undefined, week: string): WeeklyReviewNote | undefined {
  if (data === undefined || data.week !== week) return undefined;
  const note = data.note;
  if (note === null || typeof note !== "object") return undefined;
  const value = note as Record<string, unknown>;
  if (typeof value.text !== "string" || value.text === "" || value.text.length > MAX_NOTE_CHARS) return undefined;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
  return { week, text: value.text, createdAt: value.createdAt };
}

/** The moment that is due now, with the steps it offers. */
export type DueMoment = { week: string; moment: WeeklyMoment; steps: WeeklyReviewStep[] };

/** Where a moment opens inside its ISO week: Monday-first day × 1440 + time. */
function momentPosition(moment: WeeklyMoment): number {
  return weekDayIndex(moment.day) * 1440 + moment.time;
}

/**
 * The moment the review should propose now, or null.
 *
 * The rules (S3):
 * - a moment is due from its wall-clock time until the next moment of the
 *   week opens (or the week ends);
 * - a moment whose steps are all done is never re-offered, and a later moment
 *   offers the earlier one's unfinished steps too — skipped Friday, Sunday
 *   offers the whole flow;
 * - a skipped week offers nothing, and a snoozed nudge stays quiet until
 *   `snoozedUntil` passes;
 * - a state from another week is ignored: the new week starts fresh.
 *
 * Wall-clock positions come from the profile zone, so the answer is the same
 * on every device and a 23-hour DST Sunday keeps its 19:00.
 */
export function dueMoment(
  now: Date,
  timeZone: string,
  settings: WeeklyReviewSettings,
  state: WeeklyReviewState | undefined,
): DueMoment | null {
  const { week } = weekOfInstant(now, timeZone);
  const current = state !== undefined && state.week === week ? state : undefined;
  if (current?.skipped) return null;
  if (current?.snoozedUntil !== undefined && Date.parse(current.snoozedUntil) > now.getTime()) return null;

  const done = new Set(current?.stepsDone ?? []);
  const sorted = settings.moments
    .map((moment, index) => ({ moment, position: momentPosition(moment), index }))
    .sort((left, right) => left.position - right.position || left.index - right.index);

  const zoneToday = todayWallUtc(timeZone, now);
  const nowPosition = weekDayIndex(new Date(zoneToday).getUTCDay()) * 1440 + wallMinutes(now, timeZone);

  let due: WeeklyMoment | undefined;
  for (const entry of sorted) {
    if (entry.position > nowPosition) break;
    due = entry.moment;
  }
  if (due === undefined) return null;

  // The due moment offers its own steps plus every unfinished step the
  // earlier moments of this week scheduled, each moment's steps in the order
  // the person configured them.
  const steps: WeeklyReviewStep[] = [];
  for (const entry of sorted) {
    if (entry.position > momentPosition(due)) break;
    for (const step of entry.moment.steps) {
      if (!done.has(step) && !steps.includes(step)) steps.push(step);
    }
  }
  if (steps.length === 0) return null;
  return { week, moment: due, steps };
}

/** The instant a "Later" nudge holds until: `now` plus `snoozeMinutes`. */
export function snoozedUntil(now: Date, minutes: number = snoozeMinutes): string {
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("snooze must be a whole positive minute count");
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** A task as the review reads it: `TaskView` fits without adapters. */
export type ReviewTask = {
  id: string;
  title: string;
  completed: boolean;
  deadline?: string;
  estimate?: number;
  actualMinutes?: number;
  completedAt?: string;
  /** The Clean-up step's "someday" shelf: a flagged task is never a candidate
   *  again, or flagging it once would only resurface it next week. */
  someday?: boolean;
};

/** A block as the review reads it: which task it planned, and when. */
export type ReviewBlock = { start: string; end: string; taskId?: string };

/** The few numbers the Review step shows (S3): no charts, no streaks. */
export type WeeklyNumbers = {
  week: string;
  /** Sum of this week's block durations, in minutes. */
  plannedMinutes: number;
  /** Sum of `actualMinutes` over the tasks completed this week. */
  actualMinutes: number;
  /** Median `actual / estimate` over the week's tracked, estimated work; null
   *  when the week left nothing to learn from. */
  biasRatio: number | null;
  /** Tasks completed this week. */
  doneCount: number;
  /** Distinct tasks with at least one block in the week. */
  plannedCount: number;
  /** Where the time went: top three titles by tracked minutes. */
  topTasks: { title: string; minutes: number }[];
};

/** The middle value, or the mean of the two middle values for an even count
 *  (the same median `planning/bias.ts` learns from). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** The zone's day an ISO instant falls on, or undefined when it is not an
 *  instant (a hand-edited document must not crash the review). */
function instantDayKey(instant: string, timeZone: string): string | undefined {
  const stamp = Date.parse(instant);
  return Number.isFinite(stamp) ? dateKey(new Date(stamp), timeZone) : undefined;
}

/** The real instant of the zone's midnight on a day key: the same two-pass
 *  correction `toZonedInstant` applies (stamp = wall − offset), so a DST day's
 *  00:00 lands on the exact epoch millisecond. */
function zonedMidnight(dayKey: string, timeZone: string): number {
  const guess = Date.parse(`${dayKey}T00:00:00Z`);
  let stamp = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    stamp = guess - (wallAsUtc(new Date(stamp), timeZone) - stamp);
  }
  return stamp;
}

/**
 * The Review step's numbers for the week `now` falls on, in the zone.
 *
 * Two limits of the stored model, both reported rather than hidden:
 * - `actualMinutes` on a task is a cumulative counter, so a week's actual time
 *   is the tracked minutes of the tasks *completed* that week; minutes
 *   tracked on still-open work land in a later week's numbers.
 * - a task's actual time is grouped by its title, which is the only label the
 *   model gives tracked work.
 *
 * The bias ratio reuses the learner's sample rule from `planning/bias.ts`
 * (only tracked sessions of at least `MIN_ACTUAL_MINUTES` count) over the
 * week's completed tasks, and reports the median without clamping: this is a
 * record of the week, not a suggestion.
 */
export function weeklyNumbers(input: {
  now: Date;
  timeZone: string;
  tasks: readonly ReviewTask[];
  blocks: readonly ReviewBlock[];
}): WeeklyNumbers {
  const { week, monday, sunday } = weekOfInstant(input.now, input.timeZone);
  const inWeek = (day: string | undefined) => day !== undefined && day >= monday && day <= sunday;
  // The week's real window in the zone: Monday 00:00 through the next Monday
  // 00:00, as actual instants (so a DST change inside the week shifts the
  // window by its real hour). A block is attributed by the minutes it actually
  // spends inside this window.
  const weekStart = zonedMidnight(monday, input.timeZone);
  const weekEnd = zonedMidnight(wallDayKey(keyToWallUtc(monday) + 7 * dayMs), input.timeZone);

  let plannedMinutes = 0;
  const plannedTasks = new Set<string>();
  for (const block of input.blocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // Clip to the week's Monday-to-Monday window: a block crossing the edge
    // (Sunday 23:00 → Monday 01:00) counts its minutes in each week it touches
    // instead of landing whole in the week of its start day.
    const clippedStart = Math.max(start, weekStart);
    const clippedEnd = Math.min(end, weekEnd);
    if (clippedEnd <= clippedStart) continue;
    plannedMinutes += (clippedEnd - clippedStart) / 60_000;
    if (block.taskId !== undefined) plannedTasks.add(block.taskId);
  }

  const minutesByTitle = new Map<string, number>();
  const ratios: number[] = [];
  let actualMinutes = 0;
  let doneCount = 0;
  for (const task of input.tasks) {
    if (!task.completed || !inWeek(instantDayKey(task.completedAt ?? "", input.timeZone))) continue;
    doneCount += 1;
    const tracked = task.actualMinutes ?? 0;
    actualMinutes += tracked;
    const title = task.title.trim() === "" ? task.id : task.title.trim();
    minutesByTitle.set(title, (minutesByTitle.get(title) ?? 0) + tracked);
    if (typeof task.estimate === "number" && Number.isFinite(task.estimate) && task.estimate > 0
        && tracked >= MIN_ACTUAL_MINUTES) {
      ratios.push(tracked / task.estimate);
    }
  }

  const topTasks = [...minutesByTitle.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 3)
    .map(([title, minutes]) => ({ title, minutes }));

  return {
    week,
    plannedMinutes: Math.round(plannedMinutes),
    actualMinutes,
    biasRatio: ratios.length === 0 ? null : median(ratios),
    doneCount,
    plannedCount: plannedTasks.size,
    topTasks,
  };
}

/** Why a candidate shows up in the Clean-up step. */
export type CleanupReason = "overdue" | "scheduled-not-done";

/** The three actions the Clean-up step offers for every candidate (S3). */
export type CleanupAction = "this-week" | "someday" | "delete";

export const cleanupActions: readonly CleanupAction[] = ["this-week", "someday", "delete"];

/** One stale task and what the step may do with it. */
export type CleanupCandidate = {
  task: ReviewTask;
  reasons: CleanupReason[];
  actions: readonly CleanupAction[];
};

/**
 * The Clean-up step's candidates (S3): unfinished tasks that are overdue, or
 * that had a block in the week containing `today` and are still open. Tasks
 * flagged `someday` are never candidates: the step's own action must not feed
 * the task straight back into next week's list.
 *
 * "Postponed ≥ 2 times" is not derivable from the stored model: neither tasks
 * nor blocks record a postponement count (the daily roll moves deadlines
 * without leaving a tally), so that rule degrades to the two reasons above
 * until the model records postponements.
 *
 * The actions are data, not writes: `this-week` sets a deadline this week
 * (`data/tasks.ts` `setTaskDeadline`), `someday` flags the task
 * (`data/weeklyReview.ts` `setTaskSomeday`) and `delete` removes it
 * (`data/tasks.ts` `deleteTask`).
 */
export function cleanupCandidates(input: {
  tasks: readonly ReviewTask[];
  blocks: readonly ReviewBlock[];
  today: string;
  timeZone: string;
}): CleanupCandidate[] {
  const { monday, sunday } = weekOfDay(input.today);
  const scheduledThisWeek = new Set<string>();
  for (const block of input.blocks) {
    if (block.taskId === undefined) continue;
    const day = instantDayKey(block.start, input.timeZone);
    if (day !== undefined && day >= monday && day <= sunday) scheduledThisWeek.add(block.taskId);
  }
  const candidates: CleanupCandidate[] = [];
  for (const task of input.tasks) {
    if (task.completed || task.someday) continue;
    const reasons: CleanupReason[] = [];
    if (task.deadline !== undefined && task.deadline < input.today) reasons.push("overdue");
    if (scheduledThisWeek.has(task.id)) reasons.push("scheduled-not-done");
    if (reasons.length === 0) continue;
    candidates.push({ task, reasons, actions: cleanupActions });
  }
  // Deadline ascending with no deadline last, then title, then id: the order
  // the person reads top to bottom (the shutdown ritual's order).
  return candidates.sort((left, right) => {
    const leftKey = left.task.deadline ?? "";
    const rightKey = right.task.deadline ?? "";
    if (leftKey !== rightKey) {
      if (leftKey === "") return 1;
      if (rightKey === "") return -1;
      return leftKey < rightKey ? -1 : 1;
    }
    if (left.task.title !== right.task.title) return left.task.title < right.task.title ? -1 : 1;
    return left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0;
  });
}

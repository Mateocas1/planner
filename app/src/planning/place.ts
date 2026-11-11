/**
 * Plan my day: placing the unscheduled tray into the free time of one day.
 *
 * The module is pure: it receives the day to plan, the tasks, the stored blocks,
 * the profile's work window and the current instant, and returns placements for
 * the caller to write. No Firebase, no React, no clock of its own.
 *
 * One day at a time, on the profile zone's wall clock. Free time comes from
 * `planning/window.ts`'s `freeSlots`, so plan-my-day and the capacity radar
 * agree on what "free" means and a DST day keeps its 08:00-21:00 window. A block
 * is clipped at each of its days' midnights (a 23:30-00:30 block occupies the
 * last 30 minutes of one day and the first 30 of the next), exactly like the
 * grid draws it.
 *
 * Rules (roadmap §F4):
 * - candidates are open tasks with no block in the future, ordered by deadline
 *   ascending (undated last), then by planned estimate descending; a task with
 *   no estimate is planned for the 60-minute assumption;
 * - each task goes in the earliest free slot that holds its whole estimate;
 * - a task that fits no single slot may split into at least two chunks of 45
 *   minutes or more, at most four of them; otherwise it stays in the tray;
 * - nothing is placed in the past: on today's plan, free time starts at the
 *   next quarter hour.
 */

import { pad, wallParts } from "../domain/instant.ts";
import { ASSUMED_ESTIMATE_MINUTES, parseEstimate } from "../domain/model.ts";
import { t } from "../i18n/index.ts";
import { freeSlots, minutesPerDay, validateWorkWindow, type Interval, type WorkWindow } from "./window.ts";

const dayMs = 86_400_000;
const dayKey = /^\d{4}-\d{2}-\d{2}$/;

/** The shortest chunk a split may produce (roadmap: chunks of 45 minutes or more). */
export const MIN_CHUNK_MINUTES = 45;
/** The most chunks one task may be split into. */
export const MAX_CHUNKS = 4;

/** A task as the tray knows it: an open task and its optional plan. */
export type PlanTask = {
  id: string;
  title: string;
  /** The day it is due, `YYYY-MM-DD` in the profile zone. */
  deadline?: string;
  /** Planned length in minutes; absent means the 60-minute assumption. */
  estimate?: number;
  completed?: boolean;
};

/** A stored block: zoned instants, as the block collection holds them. */
export type PlanBlock = { taskId?: string; start: string; end: string };

export type PlanInput = {
  /** The day to plan, `YYYY-MM-DD` in the profile zone; never before today. */
  day: string;
  /** The current instant, and the profile zone every wall clock is read in. */
  now: Date;
  timeZone: string;
  /** The profile's one working window, minutes after midnight. */
  window: WorkWindow;
  tasks: readonly PlanTask[];
  blocks: readonly PlanBlock[];
};

/** One block to write: a task, and its wall-clock range on the planned day. */
export type Placement = { taskId: string; title: string; startMinutes: number; endMinutes: number };

/**
 * Why a candidate stayed in the tray. `day-over` means the day held no free
 * minute at all (its window closed, or every minute is booked); `no-room` means
 * free time existed but not enough for this task, either whole or in chunks.
 */
export type UnplacedReason = "day-over" | "no-room";

export type Unplaced = { task: PlanTask; reason: UnplacedReason };

export type Plan = { day: string; placements: Placement[]; unplaced: Unplaced[] };

/**
 * The minutes planning reserves for a task: its stored estimate, or the
 * 60-minute assumption. An estimate the domain would reject reads as absent,
 * so a hand-edited document can never shorten or stretch a plan silently.
 */
export function taskMinutes(task: PlanTask): number {
  return parseEstimate(task.estimate) ?? ASSUMED_ESTIMATE_MINUTES;
}

/**
 * Places every candidate that fits into the free time of `day`, in order, and
 * reports the rest. The caller writes the placements; this function mutates
 * nothing it was given.
 */
export function planDay({ day, now, timeZone, window: workWindow, tasks, blocks }: PlanInput): Plan {
  assertDayKey(day);
  validateWorkWindow(workWindow);
  const nowMs = now.getTime();
  const today = wallClock(nowMs, timeZone);
  if (day < today.day) throw new Error("cannot plan a day in the past");

  const slots = freeSlots(occupancy(blocks, day, timeZone), workWindow, day === today.day ? today.minutes : null).map(
    ([startMinutes, endMinutes]) => ({ startMinutes, endMinutes }),
  );
  const dayOver = slots.length === 0;
  const candidates = tasks
    .filter(task => task.completed !== true && !blocks.some(block => block.taskId === task.id && Date.parse(block.end) > nowMs))
    .sort(byPriority);

  const placements: Placement[] = [];
  const unplaced: Unplaced[] = [];
  for (const task of candidates) {
    const minutes = taskMinutes(task);
    const whole = take(slots, minutes);
    if (whole !== null) {
      placements.push({ taskId: task.id, title: task.title, startMinutes: whole[0], endMinutes: whole[1] });
      continue;
    }
    const split = splitInto(slots, minutes);
    if (split === null) {
      unplaced.push({ task, reason: dayOver ? "day-over" : "no-room" });
      continue;
    }
    slots.splice(0, slots.length, ...split.slots);
    for (const [startMinutes, endMinutes] of split.chunks) {
      placements.push({ taskId: task.id, title: task.title, startMinutes, endMinutes });
    }
  }

  // A split task's later chunk can start after a shorter task placed later, so
  // the result is ordered by the clock, then by task, for a stable diff.
  placements.sort((left, right) => left.startMinutes - right.startMinutes || (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
  unplaced.sort((left, right) => byPriority(left.task, right.task));
  return { day, placements, unplaced };
}

/**
 * Whether two plans would write the same blocks: the same day and the same
 * placements, task and clock range, in the same order. Apply compares the plan
 * on screen with a fresh one before it writes (the day may have changed while
 * the proposal stayed open). Titles and unplaced tasks are not compared: they
 * never change what is written.
 */
export function samePlan(left: Plan, right: Plan): boolean {
  return (
    left.day === right.day &&
    left.placements.length === right.placements.length &&
    left.placements.every((placement, index) => {
      const other = right.placements[index];
      return placement.taskId === other.taskId && placement.startMinutes === other.startMinutes && placement.endMinutes === other.endMinutes;
    })
  );
}

/**
 * The sentence a surface shows for tasks that stayed in the tray, e.g.
 * `2 tasks didn't fit today: Report, Taxes. Plan tomorrow?`. Empty when every
 * candidate was placed; `when` lets a caller say the day it planned.
 */
export function unplacedNotice(unplaced: readonly Unplaced[], when = t("plan.whenToday")): string {
  if (unplaced.length === 0) return "";
  const names = unplaced.map(item => item.task.title).join(", ");
  return t("plan.unplaced", { count: unplaced.length, when, names });
}

/** Deadline ascending (undated last), then the longer plan first, then id. */
function byPriority(left: PlanTask, right: PlanTask): number {
  if (left.deadline !== right.deadline) {
    if (left.deadline === undefined) return 1;
    if (right.deadline === undefined) return -1;
    return left.deadline < right.deadline ? -1 : 1;
  }
  const length = taskMinutes(right) - taskMinutes(left);
  if (length !== 0) return length;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Takes `minutes` from the earliest slot that holds them, shrinking the slot. */
function take(slots: Interval[], minutes: number): [number, number] | null {
  const index = slots.findIndex(slot => slot.endMinutes - slot.startMinutes >= minutes);
  if (index < 0) return null;
  const slot = slots[index];
  const range: [number, number] = [slot.startMinutes, slot.startMinutes + minutes];
  slot.startMinutes += minutes;
  if (slot.endMinutes <= slot.startMinutes) slots.splice(index, 1);
  return range;
}

/**
 * Splits `total` minutes into chunks that each fit one free slot, each at least
 * MIN_CHUNK_MINUTES long and at most MAX_CHUNKS of them, filled from the
 * earliest slot. Returns null when no such split exists, leaving the slots
 * untouched: a refused split must not leave half a task behind.
 */
function splitInto(slots: readonly Interval[], total: number): { chunks: [number, number][]; slots: Interval[] } | null {
  const next = slots.map(slot => ({ ...slot }));
  const chunks: [number, number][] = [];
  let remaining = total;
  for (const slot of next) {
    if (remaining === 0) break;
    const room = slot.endMinutes - slot.startMinutes;
    if (room < MIN_CHUNK_MINUTES) continue;
    let length = Math.min(remaining, room);
    // Taking the whole slot would leave an illegal tail: keep back one chunk.
    if (remaining - length > 0 && remaining - length < MIN_CHUNK_MINUTES) length = remaining - MIN_CHUNK_MINUTES;
    if (length < MIN_CHUNK_MINUTES || chunks.length === MAX_CHUNKS) return null;
    chunks.push([slot.startMinutes, slot.startMinutes + length]);
    slot.startMinutes += length;
    remaining -= length;
  }
  if (remaining > 0) return null;
  return { chunks, slots: next.filter(slot => slot.endMinutes > slot.startMinutes) };
}

/** The wall-clock ranges a set of blocks occupies on `day`, clipped per day. */
function occupancy(blocks: readonly PlanBlock[], day: string, timeZone: string): Interval[] {
  const ranges: Interval[] = [];
  for (const block of blocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const from = wallClock(start, timeZone);
    const to = wallClock(end, timeZone);
    const last = Date.parse(`${to.day}T00:00:00.000Z`);
    for (let value = Date.parse(`${from.day}T00:00:00.000Z`); value <= last; value += dayMs) {
      const key = new Date(value).toISOString().slice(0, 10);
      if (key !== day) continue;
      const startMinutes = key === from.day ? from.minutes : 0;
      const endMinutes = key === to.day ? to.minutes : minutesPerDay;
      if (endMinutes > startMinutes) ranges.push({ startMinutes, endMinutes });
    }
  }
  return ranges;
}

function wallClock(stamp: number, timeZone: string): { day: string; minutes: number } {
  const parts = wallParts(new Date(stamp), timeZone);
  return { day: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, minutes: parts.hour * 60 + parts.minute };
}

/** A malformed or impossible day key must fail before any block is planned. */
function assertDayKey(day: string): void {
  const value = Date.parse(`${day}T00:00:00.000Z`);
  if (!dayKey.test(day) || !Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) {
    throw new Error("expected a day key");
  }
}

/**
 * The Plan step's pure half (S3): spreading the week's chosen priorities across
 * next week's days, one day at a time, with the same placement arithmetic the
 * daily plan-my-day uses.
 *
 * `planning/place.ts` stays the one decision-maker for a day (free time from
 * the profile's working window, deadline order, the 60-minute assumption, the
 * 45-minute chunk floor). This module only runs it over the week's days in two
 * passes — the picked priorities claim the week's first free slots, then the
 * remaining open tasks fill what is left — and converts the placements to the
 * zoned instants the block collection stores.
 *
 * No Firebase, no React, no clock: `now` is handed in, and a caller writes what
 * comes back (`data/blocks.ts` `addBlocks`).
 */

import { planDay, type PlanBlock, type PlanTask, type Placement, type Unplaced } from "../../planning/place.ts";
import type { WorkWindow } from "../../planning/window.ts";
import { localValue, toZonedInstant } from "../time.ts";

/** One block to write for next week: a task, a day, and its wall-clock range. */
export type WeekPlacement = {
  day: string;
  taskId: string;
  title: string;
  startMinutes: number;
  endMinutes: number;
};

export type WeekPlan = {
  /** The blocks to write, ordered by day then start time. */
  placements: WeekPlacement[];
  /** Tasks neither pass could place, with `place.ts`'s own reason. */
  unplaced: Unplaced[];
};

/**
 * Plans the week's chosen tasks over `days` (the next week's Monday through
 * Sunday day keys, in order).
 *
 * Two passes per day: first the priorities in the order they were picked, then
 * everything else the day still has room for. Each pass sees the blocks the
 * earlier placements created, so no day is ever double-booked, and a task
 * placed on Tuesday is not offered to Wednesday.
 *
 * `planDay` refuses a day before `now`'s day — which cannot happen here, every
 * day of next week lies ahead — but a malformed day key still throws: the
 * caller's mistake should be loud, not silently empty.
 */
export function planWeek(input: {
  days: readonly string[];
  now: Date;
  timeZone: string;
  window: WorkWindow;
  tasks: readonly PlanTask[];
  blocks: readonly PlanBlock[];
  /** The picked priorities, in the order the person chose them. */
  priorityIds: readonly string[];
}): WeekPlan {
  const byId = new Map(input.tasks.map(task => [task.id, task]));
  const priorities = input.priorityIds
    .map(id => byId.get(id))
    .filter((task): task is PlanTask => task !== undefined && task.completed !== true);
  const rest = input.tasks.filter(
    task => task.completed !== true && !input.priorityIds.includes(task.id) && !input.blocks.some(block => block.taskId === task.id && Date.parse(block.end) > input.now.getTime()),
  );

  const placements: WeekPlacement[] = [];
  const unplaced: Unplaced[] = [];
  /** Everything placed so far, as stored blocks: the next pass's occupancy. */
  const placed: PlanBlock[] = [...input.blocks];

  /** Writes one placement and feeds it back as the next call's occupancy. */
  const take = (placement: Placement, day: string) => {
    placements.push(placementToWeek(placement, day, input.timeZone));
    placed.push({
      start: toZonedInstant(localValue(day, placement.startMinutes), input.timeZone),
      end: toZonedInstant(localValue(day, placement.endMinutes), input.timeZone),
      taskId: placement.taskId,
    });
  };

  // The priorities, strictly in the order they were picked: each one claims
  // the earliest free slot that fits it anywhere in the week. One planDay per
  // task, because planDay orders its own candidates and the pick order has to
  // outrank it.
  for (const priority of priorities) {
    let reason: Unplaced["reason"] = "no-room";
    let done = false;
    for (const day of input.days) {
      const plan = planDay({
        day,
        now: input.now,
        timeZone: input.timeZone,
        window: input.window,
        tasks: [priority],
        blocks: placed,
      });
      if (plan.placements.length > 0) {
        take(plan.placements[0], day);
        done = true;
        break;
      }
      if (plan.unplaced.length > 0) reason = plan.unplaced[0].reason;
    }
    if (!done) unplaced.push({ task: priority, reason });
  }

  // Everything the person did not pick, filled into whatever is left, in the
  // day order place.ts itself decides.
  let remaining = [...rest];
  for (const day of input.days) {
    if (remaining.length === 0) break;
    const plan = planDay({
      day,
      now: input.now,
      timeZone: input.timeZone,
      window: input.window,
      tasks: remaining,
      blocks: placed,
    });
    for (const placement of plan.placements) take(placement, day);
    const placedIds = new Set(plan.placements.map(placement => placement.taskId));
    remaining = remaining.filter(task => !placedIds.has(task.id));
    for (const left of plan.unplaced) unplaced.push(left);
  }

  return { placements, unplaced: dedupeByTask(unplaced) };
}

/** A day's wall-clock placement becomes the instant pair the block stores. */
function placementToWeek(placement: Placement, day: string, timeZone: string): WeekPlacement {
  return {
    day,
    taskId: placement.taskId,
    title: placement.title,
    startMinutes: placement.startMinutes,
    endMinutes: placement.endMinutes,
  };
}

/** A task that failed every day of a pass is reported once, not once per day. */
function dedupeByTask(unplaced: readonly Unplaced[]): Unplaced[] {
  const seen = new Set<string>();
  const out: Unplaced[] = [];
  for (const entry of unplaced) {
    if (seen.has(entry.task.id)) continue;
    seen.add(entry.task.id);
    out.push(entry);
  }
  return out;
}

/** The next week's Monday–Sunday day keys from this week's Monday key. */
export function nextWeekDays(monday: string): string[] {
  const mondayMs = Date.parse(`${monday}T00:00:00Z`);
  if (!Number.isFinite(mondayMs)) throw new Error(`not a day key: ${monday}`);
  return Array.from({ length: 7 }, (_, index) =>
    new Date(mondayMs + index * 86_400_000).toISOString().slice(0, 10),
  );
}

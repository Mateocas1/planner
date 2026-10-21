/**
 * The shutdown ritual's pure half (F3a): what the day left behind, the batch
 * plan that rolls due and overdue deadlines to tomorrow, and the exact undo of
 * that plan.
 *
 * No Firebase, no React, no clock: the caller supplies the profile zone and
 * the zone's today, and gets back data. The UI that shows the ritual (F3c) and
 * the batch that applies it (`data/tasks.ts`) consume the same computation, so
 * what the sheet lists is exactly what the batch writes.
 *
 * Day keys are `YYYY-MM-DD` calendar days of the *profile* zone. Day
 * arithmetic goes through `ui/time.ts`, whose wall-UTC helpers are the one
 * implementation of "the zone's next day": adding 24 h to a wall-UTC midnight
 * yields the next calendar day even on a 23- or 25-hour DST day, because the
 * wall clock is not an instant.
 */

import { dateKey, dayMs, keyToWallUtc, wallDayKey } from "../ui/time.ts";

/** The stored fields of a task this module needs. `TaskView` fits without adapters. */
export type ShutdownTask = {
  id: string;
  title: string;
  completed: boolean;
  deadline?: string;
  completedAt?: string;
};

/** The stored fields of a block this module needs: which task it planned, and when. */
export type ShutdownBlock = { taskId?: string; start: string };

/** The two groups the ritual's Today page lists. */
export type DayGroups = { done: ShutdownTask[]; leftOver: ShutdownTask[] };

/** One deadline change of the roll: what it was, and what tomorrow is. */
export type DeadlineMove = { taskId: string; before: string; after: string };

/**
 * Everything one `writeBatch` does, computed once: the deadline moves, the
 * `lastShutdown` stamp, and the previous stamp the undo puts back. A day that
 * is already closed yields `alreadyClosed: true` and no moves, so a second
 * device renders the same state instead of rolling twice.
 */
export type ShutdownPlan = {
  today: string;
  alreadyClosed: boolean;
  moves: DeadlineMove[];
  lastShutdown: { before?: string; after: string };
};

/** The inverse writes: each rolled deadline back to its value, and the stamp back. */
export type ShutdownUndo = { deadlines: { taskId: string; deadline: string }[]; lastShutdown?: string };

const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads a calendar day key, rejecting anything that is not one: the pattern
 * alone accepts `2026-02-30`, so the value has to survive a round trip through
 * wall-UTC arithmetic. A stored value that fails is treated as absent rather
 * than repaired, because a repaired date is a date nobody wrote.
 */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !dayKeyPattern.test(value)) return false;
  const wallUtc = keyToWallUtc(value);
  return Number.isFinite(wallUtc) && wallDayKey(wallUtc) === value;
}

function requireDayKey(value: string, label: string): string {
  if (!isDayKey(value)) {
    throw new Error(`${label} must be a calendar day key (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The zone's next calendar day after `today`. */
export function nextDayKey(today: string): string {
  return wallDayKey(keyToWallUtc(requireDayKey(today, "today")) + dayMs);
}

/** The profile zone's day an instant falls on, or undefined when it is not an
 * instant at all (a hand-edited document must not crash the ritual). */
function instantDayKey(instant: string, timeZone: string): string | undefined {
  const stamp = Date.parse(instant);
  return Number.isFinite(stamp) ? dateKey(new Date(stamp), timeZone) : undefined;
}

/** Deadline ascending with no deadline last, then title, then id: the order
 * the person reads top to bottom, and a stable order for the batch. */
function byDeadline(left: ShutdownTask, right: ShutdownTask): number {
  const leftKey = left.deadline ?? "";
  const rightKey = right.deadline ?? "";
  if (leftKey !== rightKey) {
    if (leftKey === "") return 1;
    if (rightKey === "") return -1;
    return leftKey < rightKey ? -1 : 1;
  }
  return byTitleThenId(left, right);
}

/** Completion instant ascending, then title, then id. */
function byCompleted(left: ShutdownTask, right: ShutdownTask): number {
  const leftKey = left.completedAt ?? "";
  const rightKey = right.completedAt ?? "";
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return byTitleThenId(left, right);
}

function byTitleThenId(left: ShutdownTask, right: ShutdownTask): number {
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/**
 * The ritual's Today page: tasks completed today, and open tasks that had a
 * block today or are due today or overdue (roadmap §2 F3). A task with a
 * block today belongs to that block's calendar day, which is how the grid
 * buckets it; a completed task without a completion instant is history from
 * before estimates existed and belongs to neither group.
 */
export function dayLeftovers(input: {
  tasks: readonly ShutdownTask[];
  blocks: readonly ShutdownBlock[];
  today: string;
  timeZone: string;
}): DayGroups {
  const today = requireDayKey(input.today, "today");
  const plannedToday = new Set<string>();
  for (const block of input.blocks) {
    if (block.taskId === undefined) continue;
    if (instantDayKey(block.start, input.timeZone) === today) plannedToday.add(block.taskId);
  }
  const done: ShutdownTask[] = [];
  const leftOver: ShutdownTask[] = [];
  for (const task of input.tasks) {
    if (task.completed) {
      if (task.completedAt !== undefined && instantDayKey(task.completedAt, input.timeZone) === today) done.push(task);
      continue;
    }
    const due = task.deadline !== undefined && task.deadline <= today;
    if (due || plannedToday.has(task.id)) leftOver.push(task);
  }
  return { done: done.sort(byCompleted), leftOver: leftOver.sort(byDeadline) };
}

/**
 * The roll: every left-over task due today or overdue gets tomorrow as its
 * deadline, and nothing else changes (roadmap §5.2). A task with a future
 * deadline keeps it; a task with no deadline has no deadline to move and
 * simply returns to the tray; blocks and series are never touched.
 *
 * The plan stamps `lastShutdown = today` in the same batch, which is what makes
 * the ritual idempotent across devices: the stored day is compared in the
 * profile zone, so two clocks in different zones still agree on "today".
 */
export function planCloseDay(input: {
  tasks: readonly ShutdownTask[];
  blocks: readonly ShutdownBlock[];
  today: string;
  timeZone: string;
  lastShutdown?: string;
}): ShutdownPlan {
  const today = requireDayKey(input.today, "today");
  const previous = isDayKey(input.lastShutdown) ? input.lastShutdown : undefined;
  if (previous === today) {
    return { today, alreadyClosed: true, moves: [], lastShutdown: { before: today, after: today } };
  }
  const tomorrow = nextDayKey(today);
  const { leftOver } = dayLeftovers({ tasks: input.tasks, blocks: input.blocks, today, timeZone: input.timeZone });
  const moves: DeadlineMove[] = [];
  for (const task of leftOver) {
    if (task.deadline === undefined || task.deadline > today) continue;
    moves.push({ taskId: task.id, before: task.deadline, after: tomorrow });
  }
  return { today, alreadyClosed: false, moves, lastShutdown: { before: previous, after: today } };
}

/**
 * The exact inverse of a plan: each move's previous deadline, and the previous
 * `lastShutdown` — `undefined` when the first close introduced it, which the
 * data layer writes as a deleted field rather than a guess.
 */
export function planUndo(plan: ShutdownPlan): ShutdownUndo {
  return {
    deadlines: plan.moves.map(move => ({ taskId: move.taskId, deadline: move.before })),
    lastShutdown: plan.lastShutdown.before,
  };
}

/**
 * The shutdown ritual's pure half: what the day left behind, the batch
 * plan that rolls due and overdue deadlines to tomorrow, and the exact undo of
 * that plan.
 *
 * No Firebase, no React, no clock: the caller supplies the profile zone and
 * the zone's today, and gets back data. The UI that shows the ritual and
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
 * The `profile.lastShutdown` change of one close. `before` is the stored value
 * exactly as it was, whatever it was: a day key, a hand-edited string, a
 * number, or nothing at all. Undo writes it back raw instead of guessing a day
 * or deleting a value somebody wrote.
 */
export type ShutdownStamp = { before?: unknown; after: string };

/**
 * Everything one `writeBatch` does, computed once: the deadline moves, the
 * `lastShutdown` stamp, and the previous stamp the undo puts back. A day that
 * is already closed yields `alreadyClosed: true` and no moves, so a second
 * device renders the same state instead of rolling twice; a day with more due
 * tasks than one batch can hold yields `refused` and no moves, because a roll
 * split across several commits could stop between them.
 */
export type ShutdownPlan = {
  today: string;
  alreadyClosed: boolean;
  refused?: "too-many-moves";
  moves: DeadlineMove[];
  lastShutdown: ShutdownStamp;
};

/** One task's stored deadline: all undo compares against. */
export type StoredDeadline = { id: string; deadline?: string };

/**
 * The local document state undo checks its preconditions against: the tasks and
 * the profile stamp the app already holds in its store, which includes pending
 * local writes. Comparing against it works offline, where the obvious
 * alternative (a Firestore transaction) fails without connectivity.
 */
export type ShutdownState = { tasks: readonly StoredDeadline[]; lastShutdown?: unknown };

/** Why undo wrote nothing: the roll never happened, or a later close owns the stamp. */
export type UndoRefusal = "nothing-applied" | "later-close";

/**
 * The inverse writes and what could not be inverted. `skipped` counts rolled
 * tasks whose local deadline is no longer the one the close wrote, because
 * somebody edited them since; their edit wins. A refusal carries no writes at
 * all, so a refused undo cannot partially revert a roll.
 */
export type UndoPlan = {
  refused?: UndoRefusal;
  deadlines: { taskId: string; deadline: string }[];
  skipped: number;
  /** The raw stamp to put back; `undefined` deletes the field. */
  lastShutdown?: unknown;
};

/**
 * How many deadline moves one close may commit. Firestore commits at most 500
 * writes per batch and the profile stamp is one of them. A day with more due
 * tasks than this is refused rather than split into chunks: the chunks would
 * not be atomic, and a half-applied roll leaves undo reading deadlines it never
 * wrote, where "skipped" and "lost" look the same.
 */
export const maxCloseDayMoves = 499;

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
 * profile zone, so two clocks in different zones still agree on "today". A
 * stamp later than today counts as closed too -- a profile zone change or a
 * clock set back can leave one -- and is never moved backwards, because that
 * would claim a close nobody made.
 */
export function planCloseDay(input: {
  tasks: readonly ShutdownTask[];
  blocks: readonly ShutdownBlock[];
  today: string;
  timeZone: string;
  /** `profile.lastShutdown` as stored, whatever its type. */
  lastShutdown?: unknown;
}): ShutdownPlan {
  const today = requireDayKey(input.today, "today");
  const stored = input.lastShutdown;
  const previous = isDayKey(stored) ? stored : undefined;
  if (previous !== undefined && previous >= today) {
    // Nothing is written, so `after` names the day the stamp already holds.
    return { today, alreadyClosed: true, moves: [], lastShutdown: { before: stored, after: previous } };
  }
  const stamp: ShutdownStamp = { before: stored, after: today };
  const tomorrow = nextDayKey(today);
  const { leftOver } = dayLeftovers({ tasks: input.tasks, blocks: input.blocks, today, timeZone: input.timeZone });
  const moves: DeadlineMove[] = [];
  for (const task of leftOver) {
    if (task.deadline === undefined || task.deadline > today) continue;
    moves.push({ taskId: task.id, before: task.deadline, after: tomorrow });
  }
  if (moves.length > maxCloseDayMoves) {
    return { today, alreadyClosed: false, refused: "too-many-moves", moves: [], lastShutdown: stamp };
  }
  return { today, alreadyClosed: false, moves, lastShutdown: stamp };
}

/**
 * The exact inverse of a plan, checked against the state the app holds now.
 *
 * Two preconditions decide whether an undo may write at all: the plan must have
 * written something (a closed day or a refused roll wrote nothing), and the
 * profile's current stamp must still be the one this close wrote. If a later
 * close has stamped the profile since, undoing this plan would revert deadlines
 * that close rolled and rewrite its stamp, so it refuses and writes nothing.
 *
 * Each task is then reverted only when its local deadline is still the one the
 * close wrote; a task edited since keeps its edit and is counted as skipped.
 * The stamp goes back raw -- the value the plan recorded -- so an undo restores
 * what was there rather than deleting what the undo does not understand.
 */
export function planUndo(plan: ShutdownPlan, state: ShutdownState): UndoPlan {
  if (plan.alreadyClosed || plan.refused !== undefined) {
    return { refused: "nothing-applied", deadlines: [], skipped: 0 };
  }
  if (state.lastShutdown !== plan.lastShutdown.after) {
    return { refused: "later-close", deadlines: [], skipped: 0 };
  }
  const current = new Map<string, string | undefined>();
  for (const task of state.tasks) current.set(task.id, task.deadline);
  const deadlines: { taskId: string; deadline: string }[] = [];
  let skipped = 0;
  for (const move of plan.moves) {
    if (current.get(move.taskId) === move.after) deadlines.push({ taskId: move.taskId, deadline: move.before });
    else skipped += 1;
  }
  return { deadlines, skipped, lastShutdown: plan.lastShutdown.before };
}

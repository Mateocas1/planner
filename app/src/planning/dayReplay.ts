/**
 * Day replay model (Ronda 8, plan `odd/plans/day-replay.md` sections 2-4): the
 * pure plan-versus-actual diff behind the closing ritual's replay, plus the
 * deterministic timeline the stage plays.
 *
 * The plan is the morning snapshot of the day's blocks when the device kept
 * one, otherwise today's blocks as they stand (stretches and strikes still
 * show; moves and added blocks cannot). The actual is the profile-zone day's
 * `actualByDay` total per task: it carries no start time, so a worked bar sits
 * at the task's current block start and the module never claims one it does
 * not have.
 *
 * One row per task (every planned block of the task folded into one bar at the
 * first start, of the summed length) or per manual block. Google Calendar
 * blocks are left out: they have no tracked time to compare. All clock math is
 * the profile zone's: positions are elapsed minutes since the zone's midnight
 * (so a DST day is 23 or 25 hours wide), and a block crossing midnight counts
 * only the minutes inside the day.
 */

import { dateKey, dayMs, keyToWallUtc, toZonedInstant, wallDayKey } from "../ui/time.ts";

/** The fields of a task the replay reads; `TaskView` fits without adapters. */
export type ReplayTask = {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: string;
  actualByDay?: Record<string, number>;
};

/** A block as the replay reads it, current or from the morning snapshot. */
export type ReplayBlock = {
  id: string;
  start: string;
  end: string;
  taskId?: string;
  title?: string;
  /** Present on an imported (Google Calendar) block; its value is not read. */
  source?: unknown;
};

/** A stretch of the day in elapsed minutes since the zone's midnight. */
export type ReplaySpan = { start: number; end: number };

export type ReplayOutcome = "unchanged" | "moved" | "stretched" | "shrunk" | "struck" | "added";

export type ReplayRow = {
  /** `task:<id>` or `block:<id>`: stable across renders. */
  key: string;
  kind: "task" | "block";
  /** The title; empty for an untitled manual block (the surface localizes it). */
  label: string;
  outcome: ReplayOutcome;
  /** The task was completed on this day (the row gets a static check). */
  done: boolean;
  /** The plan ghost; null when the plan held nothing for the row (added). */
  plan: ReplaySpan | null;
  /** The bar of what happened; null when nothing did (struck). A done task
   *  with no time tracked keeps a bar of its planned length. */
  actual: ReplaySpan | null;
  /** False only for time tracked with no block: the bar starts at the axis
   *  origin and claims no time of day. */
  placed: boolean;
  plannedMinutes: number;
  /** Tracked minutes for a task; the current block length for a manual block. */
  actualMinutes: number;
};

export type DayReplay = {
  day: string;
  /** Minutes in the zone's day: 1440, or 1380 / 1500 on a DST change. */
  axisMinutes: number;
  /** The visible time-of-day range: whole hours covering every placed span. */
  range: ReplaySpan;
  /** Shown rows in start order (changed rows win the cap). */
  rows: ReplayRow[];
  /** What the cap folded away, or null. */
  more: { count: number; plannedMinutes: number; actualMinutes: number } | null;
  /** Totals over every row, shown or not. Tracked counts tasks only. */
  plannedMinutes: number;
  trackedMinutes: number;
  /** Changed rows over every row, shown or not. */
  changedCount: number;
};

/** Rows the stage shows before folding the rest into "+N more". */
export const MAX_REPLAY_ROWS = 6;

/** The smallest change worth showing: the planner's smallest estimate step. */
export const CHANGE_MINUTES = 5;

const MINUTE_MS = 60_000;

type Window = { startMs: number; endMs: number };

function dayWindow(day: string, timeZone: string): Window {
  const wallUtc = keyToWallUtc(day);
  if (!Number.isFinite(wallUtc) || wallDayKey(wallUtc) !== day) {
    throw new Error(`day must be a calendar day key (YYYY-MM-DD), got ${JSON.stringify(day)}`);
  }
  const startMs = Date.parse(toZonedInstant(`${day}T00:00`, timeZone));
  const endMs = Date.parse(toZonedInstant(`${wallDayKey(wallUtc + dayMs)}T00:00`, timeZone));
  return { startMs, endMs };
}

/** A block's minutes inside the day as a span, or null when none fall in it
 *  (or the stored instants are not instants: a hand-edited document must not
 *  crash the ritual). */
function clip(block: ReplayBlock, window: Window): ReplaySpan | null {
  const start = Date.parse(block.start);
  const end = Date.parse(block.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const clippedStart = Math.max(start, window.startMs);
  const clippedEnd = Math.min(end, window.endMs);
  if (clippedEnd <= clippedStart) return null;
  return {
    start: Math.round((clippedStart - window.startMs) / MINUTE_MS),
    end: Math.round((clippedEnd - window.startMs) / MINUTE_MS),
  };
}

type Group = { spans: ReplaySpan[]; title?: string };

function blockKey(block: ReplayBlock): string {
  return block.taskId === undefined ? `block:${block.id}` : `task:${block.taskId}`;
}

function group(blocks: readonly ReplayBlock[], window: Window): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const block of blocks) {
    if (block.source !== undefined) continue;
    const span = clip(block, window);
    if (span === null) continue;
    const key = blockKey(block);
    const entry = groups.get(key) ?? { spans: [] };
    entry.spans.push(span);
    const title = block.title?.trim();
    if (entry.title === undefined && title) entry.title = title;
    groups.set(key, entry);
  }
  return groups;
}

function firstStart(entry: Group | undefined): number | null {
  if (entry === undefined || entry.spans.length === 0) return null;
  return Math.min(...entry.spans.map(span => span.start));
}

function sumMinutes(entry: Group | undefined): number {
  return entry === undefined ? 0 : entry.spans.reduce((sum, span) => sum + (span.end - span.start), 0);
}

function trackedOn(task: ReplayTask | undefined, day: string): number {
  const minutes = task?.actualByDay?.[day];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function doneOn(task: ReplayTask | undefined, day: string, timeZone: string): boolean {
  if (task === undefined || !task.completed || task.completedAt === undefined) return false;
  const stamp = Date.parse(task.completedAt);
  return Number.isFinite(stamp) && dateKey(new Date(stamp), timeZone) === day;
}

function lengthOutcome(planned: number, actual: number): ReplayOutcome {
  const delta = actual - planned;
  if (delta >= CHANGE_MINUTES) return "stretched";
  if (delta <= -CHANGE_MINUTES) return "shrunk";
  return "unchanged";
}

/** How big a change is, to rank rows when the cap folds some away. */
function magnitude(row: ReplayRow): number {
  switch (row.outcome) {
    case "unchanged": return 0;
    case "struck": return row.plannedMinutes;
    case "added": return row.actualMinutes;
    case "moved": return row.plan !== null && row.actual !== null ? Math.abs(row.actual.start - row.plan.start) : 0;
    default: return Math.abs(row.actualMinutes - row.plannedMinutes);
  }
}

function rowStart(row: ReplayRow): number {
  return (row.actual ?? row.plan)?.start ?? 0;
}

function byStart(left: ReplayRow, right: ReplayRow): number {
  return rowStart(left) - rowStart(right) || left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
}

function buildRow(input: {
  key: string;
  planned: Group | undefined;
  current: Group | undefined;
  task: ReplayTask | undefined;
  day: string;
  timeZone: string;
}): ReplayRow | null {
  const { key, planned, current, task, day, timeZone } = input;
  const isTask = key.startsWith("task:");
  const label = (task?.title.trim() || planned?.title || current?.title || "");
  const plannedMinutes = sumMinutes(planned);
  const plannedStart = firstStart(planned);
  const currentStart = firstStart(current);
  const done = doneOn(task, day, timeZone);
  const tracked = isTask ? trackedOn(task, day) : 0;

  const plan: ReplaySpan | null = plannedStart === null ? null : { start: plannedStart, end: plannedStart + plannedMinutes };
  const base = { key, kind: isTask ? "task" : "block", label, done, plan, plannedMinutes } as const;

  if (!isTask) {
    // A manual block has no tracked time: the comparison is plan versus how
    // the block stands now.
    const currentMinutes = sumMinutes(current);
    if (plan === null && currentStart !== null) {
      return { ...base, outcome: "added", actual: { start: currentStart, end: currentStart + currentMinutes }, placed: true, actualMinutes: currentMinutes };
    }
    if (plan !== null && currentStart === null) {
      return { ...base, outcome: "struck", actual: null, placed: true, actualMinutes: 0 };
    }
    if (plan === null || currentStart === null) return null;
    const actual = { start: currentStart, end: currentStart + currentMinutes };
    let outcome = lengthOutcome(plannedMinutes, currentMinutes);
    if (outcome === "unchanged" && Math.abs(currentStart - plan.start) >= CHANGE_MINUTES) outcome = "moved";
    return { ...base, outcome, actual, placed: true, actualMinutes: currentMinutes };
  }

  if (plan === null) {
    // Time tracked on a task the plan never held. With a block now, the bar
    // sits on it; without one it claims no time of day.
    if (tracked <= 0) return null;
    return currentStart === null
      ? { ...base, outcome: "added", actual: { start: 0, end: tracked }, placed: false, actualMinutes: tracked }
      : { ...base, outcome: "added", actual: { start: currentStart, end: currentStart + tracked }, placed: true, actualMinutes: tracked };
  }

  // Planned task. Nothing tracked and not finished: the plan did not happen,
  // whether the block was removed or left standing.
  if (tracked <= 0 && !done) {
    return { ...base, outcome: "struck", actual: null, placed: true, actualMinutes: 0 };
  }
  const start = currentStart ?? plan.start;
  const length = tracked > 0 ? tracked : (current === undefined ? plannedMinutes : sumMinutes(current));
  const actual = { start, end: start + length };
  let outcome: ReplayOutcome = tracked > 0 ? lengthOutcome(plannedMinutes, tracked) : "unchanged";
  if (outcome === "unchanged" && Math.abs(start - plan.start) >= CHANGE_MINUTES) outcome = "moved";
  return { ...base, outcome, actual, placed: true, actualMinutes: tracked };
}

function visibleRange(rows: readonly ReplayRow[], axisMinutes: number): ReplaySpan {
  const spans: ReplaySpan[] = [];
  for (const row of rows) {
    if (row.plan !== null) spans.push(row.plan);
    if (row.actual !== null && row.placed) spans.push(row.actual);
  }
  if (spans.length === 0) return { start: 0, end: Math.min(axisMinutes, 120) };
  let start = Math.floor(Math.min(...spans.map(span => span.start)) / 60) * 60;
  let end = Math.min(axisMinutes, Math.ceil(Math.max(...spans.map(span => span.end)) / 60) * 60);
  if (end - start < 120) {
    end = Math.min(axisMinutes, start + 120);
    start = Math.max(0, end - 120);
  }
  return { start, end };
}

/**
 * The plan-versus-actual diff of one profile-zone day, or null when the day
 * held nothing to compare (no planned block and no tracked time). A day where
 * nothing changed still returns a replay (`changedCount` 0) so the surface can
 * show its static totals line; `replayTimeline` returns null for it.
 */
export function buildDayReplay(input: {
  day: string;
  timeZone: string;
  tasks: readonly ReplayTask[];
  /** Today's blocks as they stand now. */
  blocks: readonly ReplayBlock[];
  /** The morning snapshot's blocks; absent means "the plan is today's blocks". */
  plan?: readonly ReplayBlock[];
}): DayReplay | null {
  const { day, timeZone } = input;
  const window = dayWindow(day, timeZone);
  const axisMinutes = Math.round((window.endMs - window.startMs) / MINUTE_MS);
  const current = group(input.blocks, window);
  const planned = input.plan === undefined ? current : group(input.plan, window);
  const taskById = new Map(input.tasks.map(task => [task.id, task]));

  const keys = new Set<string>([...planned.keys(), ...current.keys()]);
  for (const task of input.tasks) {
    if (trackedOn(task, day) > 0) keys.add(`task:${task.id}`);
  }

  const all: ReplayRow[] = [];
  for (const key of keys) {
    const row = buildRow({
      key,
      planned: planned.get(key),
      current: current.get(key),
      task: key.startsWith("task:") ? taskById.get(key.slice(5)) : undefined,
      day,
      timeZone,
    });
    if (row !== null) all.push(row);
  }
  if (all.length === 0) return null;

  const changed = all.filter(row => row.outcome !== "unchanged").sort((a, b) => magnitude(b) - magnitude(a) || byStart(a, b));
  const quiet = all.filter(row => row.outcome === "unchanged").sort(byStart);
  const shown = [...changed, ...quiet].slice(0, MAX_REPLAY_ROWS);
  const hidden = [...changed, ...quiet].slice(MAX_REPLAY_ROWS);
  const rows = shown.sort(byStart);

  return {
    day,
    axisMinutes,
    range: visibleRange(rows, axisMinutes),
    rows,
    more: hidden.length === 0 ? null : {
      count: hidden.length,
      plannedMinutes: hidden.reduce((sum, row) => sum + row.plannedMinutes, 0),
      actualMinutes: hidden.reduce((sum, row) => sum + row.actualMinutes, 0),
    },
    plannedMinutes: all.reduce((sum, row) => sum + row.plannedMinutes, 0),
    trackedMinutes: all.filter(row => row.kind === "task").reduce((sum, row) => sum + row.actualMinutes, 0),
    changedCount: changed.length,
  };
}

/* ---------- timeline ---------- */

export type TimelineStep = {
  key: string;
  /** Rows fade in on a 60 ms stagger, all done by 700 ms. */
  enterMs: number;
  /** The change plays here; null for a row that did not change. */
  action: { kind: Exclude<ReplayOutcome, "unchanged">; atMs: number; durationMs: number } | null;
};

export type ReplayTimeline = {
  /** The whole replay, never padded below its floor. */
  totalMs: number;
  stageInMs: number;
  /** Rows hold the plan until the first change at `firstActMs`. */
  firstActMs: number;
  totalsAtMs: number;
  sentenceAtMs: number;
  steps: TimelineStep[];
};

const STAGE_IN_MS = 150;
const ENTER_STAGGER_MS = 60;
const FIRST_ACT_MS = 3000;
const ACT_STAGGER_MS = 650;
const ACTION_MS: Record<Exclude<ReplayOutcome, "unchanged">, number> = {
  moved: 800,
  stretched: 700,
  shrunk: 700,
  struck: 750,
  added: 400,
};
const TOTALS_FADE_MS = 200;
const TOTALS_HOLD_MS = 1800;
const SENTENCE_READ_MS = 1200;
const SENTENCE_SPAN_MS = 600;
const MIN_TOTAL_MS = 6000;
const PER_CHANGE_MS = 1100;
const MAX_TOTAL_MS = 12_600;

/**
 * When each beat of the replay plays, from the shown rows alone: the total is
 * `clamp(6000 + 1100 x changed rows, 6000, 12600)` ms (10.4 s at four changes,
 * never padded below), the changed rows act in start order 650 ms apart from
 * 3000 ms, and the totals line then the sentence follow. Null when nothing
 * changed: the surface shows one static line and plays nothing.
 */
export function replayTimeline(replay: DayReplay): ReplayTimeline | null {
  const changedRows = replay.rows.filter(row => row.outcome !== "unchanged").length;
  if (changedRows === 0) return null;

  const totalMs = Math.min(MAX_TOTAL_MS, Math.max(MIN_TOTAL_MS, MIN_TOTAL_MS + PER_CHANGE_MS * changedRows));
  let acted = 0;
  let actsEndMs = FIRST_ACT_MS;
  const steps = replay.rows.map((row, index): TimelineStep => {
    const enterMs = ENTER_STAGGER_MS * index;
    if (row.outcome === "unchanged") return { key: row.key, enterMs, action: null };
    const durationMs = ACTION_MS[row.outcome];
    const atMs = FIRST_ACT_MS + ACT_STAGGER_MS * acted;
    acted += 1;
    actsEndMs = Math.max(actsEndMs, atMs + durationMs);
    return { key: row.key, enterMs, action: { kind: row.outcome, atMs, durationMs } };
  });

  const sentenceAtMs = totalMs - SENTENCE_READ_MS - SENTENCE_SPAN_MS;
  const totalsAtMs = Math.max(actsEndMs, sentenceAtMs - TOTALS_FADE_MS - TOTALS_HOLD_MS);
  return { totalMs, stageInMs: STAGE_IN_MS, firstActMs: FIRST_ACT_MS, totalsAtMs, sentenceAtMs, steps };
}

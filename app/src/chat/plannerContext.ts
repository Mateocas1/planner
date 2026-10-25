/**
 * The read-only planner context (spec S4): a compact text snapshot of the
 * user's planner that every chat request carries in its system prompt. This
 * module is pure — it formats data, never fetches it — so `usePlannerSnapshot`
 * feeds it from the existing data hooks and nothing here can touch a write
 * path (task C3a).
 *
 * Bounding: ~1.5k tokens (≈6k characters). Sections cap their items, titles
 * truncate, and each capped section ends with a "+N more" line so the model
 * knows what it is not seeing.
 */

import { dateKey, dayMs, formatDuration, formatWall, keyToWallUtc, timeLabel, wallDayKey } from "../ui/time.ts";

/** The subset of a stored block the context needs (domain shape, read-only). */
export type ContextBlock = {
  id: string;
  /** Zoned ISO instants, as stored (`WorkBlock.start`/`end`). */
  start: string;
  end: string;
  taskId?: string;
  title?: string;
};

/** The subset of a stored task the context needs (`TaskView` minus writes). */
export type ContextTask = {
  id: string;
  title: string;
  completed: boolean;
  estimateMinutes?: number;
  /** Date-only key (`YYYY-MM-DD`). */
  deadline?: string;
};

export type PlannerSnapshot = {
  blocks: ContextBlock[];
  tasks: ContextTask[];
  /** Holiday labels (ronda4 S4): the context text and the read/hide tools
   * see the user's own classification. Optional so older fixtures compile. */
  holidays?: Array<{ id: string; date: string; title: string; kind: string; hidden?: boolean }>;
};

const WEEK_DAYS = 7;
const TITLE_MAX = 48;
const TODAY_BLOCKS_CAP = 14;
const WEEK_BLOCKS_PER_DAY_CAP = 6;
const OPEN_TASKS_CAP = 12;
/** ≈1.5k tokens of headroom for the whole context text. */
const CHAR_BUDGET = 6_000;

const truncate = (title: string): string => (title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`);

const weekdayOf = (wallUtc: number): string =>
  new Date(wallUtc).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });

const weekdayLongOf = (wallUtc: number): string =>
  new Date(wallUtc).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });

/** A block's line label: the title, prefixed with the linked task's id when
 * it has one, so the model can propose moves with `move_task` (spec S1). */
function blockLabel(
  block: ContextBlock,
  title: (block: ContextBlock, taskTitle: (taskId: string | undefined) => string | undefined) => string,
  taskTitle: (taskId: string | undefined) => string | undefined,
): string {
  if (block.taskId === undefined) return title(block, taskTitle);
  return `[${block.taskId}] ${title(block, taskTitle)}`;
}

/** What "done" means for a block: its time passed, or its task was completed. */
function blockDone(block: ContextBlock, taskCompleted: (taskId: string | undefined) => boolean, nowMs: number): boolean {
  return Date.parse(block.end) <= nowMs || taskCompleted(block.taskId);
}

function blockTitle(block: ContextBlock, taskTitle: (taskId: string | undefined) => string | undefined): string {
  return truncate(block.title ?? taskTitle(block.taskId) ?? "Work block");
}

/**
 * Builds the context text. `now` and `timeZone` decide what "today" means, so
 * the same snapshot renders differently at different instants without a
 * refetch.
 */
export function buildPlannerContext(snap: PlannerSnapshot, now: Date, timeZone: string): string {
  const nowMs = now.getTime();
  const todayKey = dateKey(now, timeZone);
  const todayWall = keyToWallUtc(todayKey);
  const completedById = new Map(snap.tasks.map(task => [task.id, task.completed]));
  const titlesById = new Map(snap.tasks.map(task => [task.id, task.title]));
  const taskCompleted = (taskId: string | undefined) => (taskId === undefined ? false : completedById.get(taskId) === true);
  const taskTitle = (taskId: string | undefined) => (taskId === undefined ? undefined : titlesById.get(taskId));

  const lines: string[] = [];
  lines.push(
    `Current time: ${weekdayLongOf(todayWall)} ${todayKey} ${timeLabel(now, timeZone)} (${timeZone})`,
    "",
  );

  // Today's blocks, in start order, capped. A block linked to a task names
  // the task's id: the agentic chat's move_task references tasks by id (S1).
  const todayBlocks = snap.blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === todayKey)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  lines.push(`Today (${todayKey}):`);
  if (todayBlocks.length === 0) {
    lines.push("- no blocks");
  } else {
    const shown = todayBlocks.slice(0, TODAY_BLOCKS_CAP);
    for (const block of shown) {
      const range = `${timeLabel(new Date(block.start), timeZone)}–${timeLabel(new Date(block.end), timeZone)}`;
      const done = blockDone(block, taskCompleted, nowMs) ? " · done" : "";
      lines.push(`- ${range} · ${blockLabel(block, blockTitle, taskTitle)}${done}`);
    }
    if (todayBlocks.length > shown.length) lines.push(`(+${todayBlocks.length - shown.length} more today)`);
  }
  lines.push("");

  // Tasks due today, with ids so the model can reference them (S1).
  const dueToday = snap.tasks.filter(task => !task.completed && task.deadline === todayKey);
  if (dueToday.length > 0) {
    lines.push("Tasks due today:");
    for (const item of dueToday.slice(0, TODAY_BLOCKS_CAP)) {
      const estimate = item.estimateMinutes === undefined ? "" : ` · ${formatDuration(item.estimateMinutes)}`;
      lines.push(`- [${item.id}] ${truncate(item.title)}${estimate}`);
    }
    lines.push("");
  }

  // The next 7 days, grouped by day; empty days stay visible because a free
  // day is exactly what a planning question asks about.
  lines.push(`Next ${WEEK_DAYS} days:`);
  for (let offset = 1; offset <= WEEK_DAYS; offset++) {
    const dayKey = wallDayKey(todayWall + offset * dayMs);
    const dayBlocks = snap.blocks
      .filter(block => dateKey(new Date(block.start), timeZone) === dayKey)
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
    const label = `${weekdayOf(keyToWallUtc(dayKey))} ${dayKey}`;
    if (dayBlocks.length === 0) {
      lines.push(`- ${label}: no blocks`);
      continue;
    }
    const shown = dayBlocks.slice(0, WEEK_BLOCKS_PER_DAY_CAP);
    const parts = shown.map(block => {
      const range = `${timeLabel(new Date(block.start), timeZone)}–${timeLabel(new Date(block.end), timeZone)}`;
      return `${range} · ${blockLabel(block, blockTitle, taskTitle)}`;
    });
    const more = dayBlocks.length > shown.length ? ` (+${dayBlocks.length - shown.length} more)` : "";
    lines.push(`- ${label}: ${parts.join("; ")}${more}`);
  }
  lines.push("");

  // Open unscheduled tasks: not completed and never placed on a block.
  const scheduledIds = new Set(snap.blocks.flatMap(block => (block.taskId === undefined ? [] : [block.taskId])));
  const open = snap.tasks
    .filter(task => !task.completed && !scheduledIds.has(task.id))
    .sort((left, right) => {
      if (left.deadline === right.deadline) return left.title.localeCompare(right.title);
      if (left.deadline === undefined) return 1;
      if (right.deadline === undefined) return -1;
      return left.deadline.localeCompare(right.deadline);
    });
  if (open.length > 0) {
    lines.push("Open unscheduled tasks:");
    for (const item of open.slice(0, OPEN_TASKS_CAP)) {
      const estimate = item.estimateMinutes === undefined ? "" : ` · ${formatDuration(item.estimateMinutes)}`;
      const deadline = item.deadline === undefined ? "" : ` · due ${item.deadline}`;
      lines.push(`- [${item.id}] ${truncate(item.title)}${estimate}${deadline}`);
    }
    if (open.length > OPEN_TASKS_CAP) lines.push(`(+${open.length - OPEN_TASKS_CAP} more)`);
    lines.push("");
  }

  // Final guard: the caps above bound the common case, but a pathological
  // snapshot still cannot blow the budget — drop trailing lines, never the
  // header.
  const text = lines.join("\n").trimEnd();
  if (text.length <= CHAR_BUDGET) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > CHAR_BUDGET - 32) break;
    kept.push(line);
    length += line.length + 1;
  }
  kept.push("(context truncated)");
  return kept.join("\n").trimEnd();
}

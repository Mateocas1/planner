import { ASSUMED_ESTIMATE_MINUTES, expandOccurrences, formatEstimate, type Recurrence } from "../domain/model.ts";
import { t } from "../i18n/index.ts";
import { dateKey, dayMs, formatWall, keyToWallUtc, mondayOf, wallDayKey, wallMinutes } from "../ui/time.ts";
import { freeSlots, minutesPerDay, type Interval, type WorkWindow } from "./window.ts";

/**
 * How full the planner really is: the pure math behind the overcommit
 * radar. It answers two questions and nothing else:
 *
 *  - per day, how much of the working window is already booked, and therefore
 *    how much is still free (`DayCapacity`);
 *  - per deadline, whether the open work still fits before it, counting from
 *    today and earliest deadline first (`Overcommit`).
 *
 * The rules, all of them taken from the roadmap so plan-my-day and the
 * radar agree on what "free" means:
 *
 * - The window comes from the profile (08:00-21:00 by default) and its
 *    minutes are wall-clock minutes, so a 23-hour DST day still has a 13-hour
 *    window. Blocks are sliced at midnight in the profile zone and unioned, so
 *    overlapping or imported blocks are never counted twice.
 *  - Today contributes only the free time that is still ahead: from the later
 *    of the window's start and the quarter hour after now (`freeSlots` applies
 *    the same rounding the Plan feature uses). Past days contribute nothing.
 *  - A task's remaining work is its estimate (60 min assumed when it has none)
 *    minus the blocks already planned for it that have not ended yet.
 *  - A deadline is overcommitted when the work due by then exceeds the free
 *    time from today through that day. Deadlines are checked cumulatively, so
 *    one full Thursday is what makes Friday's work unfeasible.
 *  - Series occurrences are expanded for `SERIES_HORIZON_DAYS` days; a series
 *    with no estimate adds nothing and is reported as a hint instead, because
 *    an occurrence nobody estimated is not zero work, it is unknown work.
 *
 * Everything here is pure: the clock is injected as `now`, the zone comes from
 * the profile, and there is no Firebase, React or ambient date. Wall-clock
 * reading goes through `ui/time.ts` (the one implementation), and the interval
 * sweep through `planning/window.ts` (the one definition of free time).
 */

/** How far ahead a recurring series plans its occurrences, in calendar days. */
export const SERIES_HORIZON_DAYS = 14;

/** From this share of the window onwards a day reads as packed. */
export const PACKED_PERCENT = 85;

/**
 * Free time is counted at most a year ahead. A deadline further out than that
 * is never reported as overcommitted: the radar is about work you can still
 * rearrange, and walking an unbounded horizon would only be slow.
 */
const FREE_HORIZON_DAYS = 366;

/** A block spanning more days than this is clipped; no work block is that long. */
const MAX_BLOCK_DAYS = 366;

/** One stored block, as the capacity math needs it: instants and the task link. */
export type PlanningBlock = { start: string; end: string; taskId?: string };

/** One stored task: the capacity math only reads these five fields. */
export type PlanningTask = { id: string; title: string; deadline?: string; estimate?: number; completed?: boolean };

/** One stored recurring series, read as its definition plus its estimate. */
export type PlanningSeries = {
  id: string;
  title: string;
  frequency: Recurrence["frequency"];
  anchorDate: string;
  estimate?: number;
};

/** Everything the radar needs, with the clock injected so it stays pure. */
export type CapacityInput = {
  now: Date;
  timeZone: string;
  workWindow: WorkWindow;
  tasks?: readonly PlanningTask[];
  blocks?: readonly PlanningBlock[];
  series?: readonly PlanningSeries[];
  /** Completion records by occurrence id (`store.completions`). */
  completions?: Record<string, string>;
};

/** One day's load inside the working window. */
export type DayCapacity = {
  /** Profile-zone date key, `YYYY-MM-DD`. */
  date: string;
  /** Length of the working window in wall-clock minutes (780 by default). */
  windowMinutes: number;
  /** Union of the blocks clipped to the window, in wall-clock minutes. */
  bookedMinutes: number;
  /** `windowMinutes - bookedMinutes`: time nobody has claimed yet. */
  freeMinutes: number;
  /** `bookedMinutes` as a rounded share of the window, for "38% booked". */
  percentBooked: number;
  /** True from `PACKED_PERCENT` onwards; the label says it in words too. */
  packed: boolean;
  /**
   * Free time that is still ahead: today counts from the quarter hour after
   * now, a future day counts all of its window, a past day counts nothing.
   * This is what the deadline check compares work against.
   */
  freeFromNowMinutes: number;
};

/** One unit of work owed by a deadline: an open task or a series occurrence. */
export type CommittedTask = {
  /** Task id, or the occurrence id (`seriesId:date`) for a series occurrence. */
  id: string;
  title: string;
  /** Profile-zone date key of the day the work is due. */
  deadline: string;
  /** Estimate minus the not-yet-ended blocks planned for it; never negative. */
  remainingMinutes: number;
  /** True when `remainingMinutes` started from the 60-minute assumption. */
  assumed: boolean;
  /** Set on series occurrences, absent on tasks. */
  seriesId?: string;
};

/** A deadline whose work no longer fits in the free time before it. */
export type Overcommit = {
  deadline: string;
  /** Work due on or before this day. */
  committedMinutes: number;
  /** Free time from today through this day. */
  freeMinutes: number;
  /** How much the work exceeds the free time. */
  overMinutes: number;
};

/** What the radar says besides the numbers. */
export type CapacityHints = {
  /** Committed tasks whose estimate is the 60-minute assumption. */
  assumedEstimateCount: number;
  /** Series with no estimate: unknown work, not zero work. */
  unestimatedSeriesCount: number;
  /** True when at least one committed minute came from a stored estimate. */
  hasEstimates: boolean;
  /** Nothing was entered at all, so the radar hides itself. */
  empty: boolean;
};

export type Capacity = {
  today: DayCapacity;
  /** Monday-to-Sunday row of the current planner week, for "This week". */
  week: { start: string; days: DayCapacity[] };
  /** Open work with a deadline from today onwards, ordered by deadline. */
  committed: CommittedTask[];
  /** Overcommitted deadlines in ascending order; empty when everything fits. */
  overcommit: Overcommit[];
  hints: CapacityHints;
};

/** A working window's length in wall-clock minutes. */
function lengthOf(window: WorkWindow): number {
  return window.endMinutes - window.startMinutes;
}

/** The date key `days` after `key`, in wall-UTC days like every other key. */
function addDays(key: string, days: number): string {
  return wallDayKey(keyToWallUtc(key) + days * dayMs);
}

function sum(ranges: readonly (readonly [number, number])[]): number {
  return ranges.reduce((total, [start, end]) => total + (end - start), 0);
}

/**
 * The wall-clock spans one block occupies, one per profile-zone day it touches.
 * A block that crosses midnight is two spans (23:30-00:30 is 30 minutes on
 * each day), and a block ending exactly at midnight has none on the day it
 * never reaches. A block longer than the horizon guard is clipped rather than
 * walked forever; a corrupt or zero-length block contributes nothing.
 */
function blockSpans(block: PlanningBlock, timeZone: string): { date: string; startMinutes: number; endMinutes: number }[] {
  const start = Date.parse(block.start);
  const end = Date.parse(block.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const first = dateKey(new Date(start), timeZone);
  const last = dateKey(new Date(end), timeZone);
  const startMinutes = wallMinutes(new Date(start), timeZone);
  const endMinutes = wallMinutes(new Date(end), timeZone);
  const spans: { date: string; startMinutes: number; endMinutes: number }[] = [];
  let date = first;
  for (let guard = 0; guard <= MAX_BLOCK_DAYS; guard += 1) {
    const from = date === first ? startMinutes : 0;
    const to = date === last ? endMinutes : minutesPerDay;
    if (to > from) spans.push({ date, startMinutes: from, endMinutes: to });
    if (date === last) break;
    date = addDays(date, 1);
  }
  return spans;
}

/** The blocks already planned for one task that have not ended yet. */
function linkedMinutes(blocks: readonly PlanningBlock[], taskId: string, nowMs: number, timeZone: string): number {
  let minutes = 0;
  for (const block of blocks) {
    if (block.taskId !== taskId) continue;
    if (Date.parse(block.end) <= nowMs) continue;
    minutes += sum(blockSpans(block, timeZone).map(span => [span.startMinutes, span.endMinutes] as const));
  }
  return minutes;
}

/** The input, indexed once so a week (or a year) of days costs no extra Intl work. */
type Context = {
  input: CapacityInput;
  today: string;
  nowMs: number;
  nowMinutes: number;
  windowMinutes: number;
  /** Booked spans by date key, unsorted and possibly overlapping. */
  occupied: Map<string, Interval[]>;
  days: Map<string, DayCapacity>;
};

function toContext(input: CapacityInput): Context {
  const occupied = new Map<string, Interval[]>();
  for (const block of input.blocks ?? []) {
    for (const span of blockSpans(block, input.timeZone)) {
      const entries = occupied.get(span.date);
      const interval = { startMinutes: span.startMinutes, endMinutes: span.endMinutes };
      if (entries) entries.push(interval);
      else occupied.set(span.date, [interval]);
    }
  }
  return {
    input,
    today: dateKey(input.now, input.timeZone),
    nowMs: input.now.getTime(),
    nowMinutes: wallMinutes(input.now, input.timeZone),
    windowMinutes: lengthOf(input.workWindow),
    occupied,
    days: new Map(),
  };
}

/** One day's load, memoized because the deadline walk visits days repeatedly. */
function dayOf(context: Context, date: string): DayCapacity {
  const cached = context.days.get(date);
  if (cached) return cached;
  const occupied = context.occupied.get(date) ?? [];
  const freeMinutes = sum(freeSlots(occupied, context.input.workWindow, null));
  const windowMinutes = context.windowMinutes;
  const bookedMinutes = windowMinutes - freeMinutes;
  const percentBooked = windowMinutes > 0 ? Math.round((bookedMinutes / windowMinutes) * 100) : 0;
  const freeFromNowMinutes = date < context.today
    ? 0
    : date > context.today
      ? freeMinutes
      : sum(freeSlots(occupied, context.input.workWindow, context.nowMinutes));
  const day: DayCapacity = {
    date,
    windowMinutes,
    bookedMinutes,
    freeMinutes,
    percentBooked,
    packed: percentBooked >= PACKED_PERCENT,
    freeFromNowMinutes,
  };
  context.days.set(date, day);
  return day;
}

/**
 * Whether each deadline still fits: work due by the day, earliest deadline
 * first, against the free time from today through that day. Only deadlines
 * that actually carry work are reported, so an empty Thursday after a full
 * Wednesday says nothing on its own.
 */
function overcommitRows(context: Context, committed: readonly CommittedTask[]): Overcommit[] {
  if (committed.length === 0) return [];
  const dueByDeadline = new Map<string, number>();
  for (const item of committed) dueByDeadline.set(item.deadline, (dueByDeadline.get(item.deadline) ?? 0) + item.remainingMinutes);
  const rows: Overcommit[] = [];
  let cursor = keyToWallUtc(context.today) - dayMs;
  let freeMinutes = 0;
  let committedMinutes = 0;
  let freeDays = 0;
  for (const deadline of [...dueByDeadline.keys()].sort()) {
    const deadlineWall = keyToWallUtc(deadline);
    while (cursor < deadlineWall && freeDays < FREE_HORIZON_DAYS) {
      cursor += dayMs;
      freeMinutes += dayOf(context, wallDayKey(cursor)).freeFromNowMinutes;
      freeDays += 1;
    }
    committedMinutes += dueByDeadline.get(deadline) ?? 0;
    if (committedMinutes > freeMinutes) {
      rows.push({ deadline, committedMinutes, freeMinutes, overMinutes: committedMinutes - freeMinutes });
    }
  }
  return rows;
}

/** One day's capacity in the profile zone; `date` is a `YYYY-MM-DD` key. */
export function dayCapacity(input: CapacityInput, date: string): DayCapacity {
  return dayOf(toContext(input), date);
}

/**
 * The radar: today, the current week, the committed work and the deadlines
 * that no longer fit. A caller that only needs one day uses `dayCapacity`.
 */
export function capacity(input: CapacityInput): Capacity {
  const context = toContext(input);
  const today = context.today;
  const blocks = input.blocks ?? [];
  const committed: CommittedTask[] = [];

  for (const task of input.tasks ?? []) {
    if (task.completed === true) continue;
    // Overdue work is not counted here: it belongs to the day it is due, and
    // rolling that deadline forward is the shutdown ritual's decision.
    if (task.deadline === undefined || task.deadline < today) continue;
    const estimate = task.estimate ?? ASSUMED_ESTIMATE_MINUTES;
    const remainingMinutes = Math.max(0, estimate - linkedMinutes(blocks, task.id, context.nowMs, input.timeZone));
    committed.push({ id: task.id, title: task.title, deadline: task.deadline, remainingMinutes, assumed: task.estimate === undefined });
  }

  let unestimatedSeriesCount = 0;
  const horizonEnd = addDays(today, SERIES_HORIZON_DAYS - 1);
  for (const series of input.series ?? []) {
    // An occurrence nobody estimated is unknown work, not zero work: it adds no
    // minutes and is reported once per series instead of pretending to be free.
    if (series.estimate === undefined) {
      unestimatedSeriesCount += 1;
      continue;
    }
    const recurrence: Recurrence = { seriesId: series.id, frequency: series.frequency, anchorDate: series.anchorDate };
    for (const occurrence of expandOccurrences(recurrence, today, horizonEnd)) {
      if (input.completions?.[occurrence.id] !== undefined) continue;
      committed.push({
        id: occurrence.id,
        title: series.title,
        deadline: occurrence.date,
        remainingMinutes: series.estimate,
        assumed: false,
        seriesId: series.id,
      });
    }
  }

  committed.sort((left, right) => left.deadline.localeCompare(right.deadline) || left.id.localeCompare(right.id));

  const weekStart = wallDayKey(mondayOf(keyToWallUtc(today)));
  return {
    today: dayOf(context, today),
    week: { start: weekStart, days: Array.from({ length: 7 }, (_, index) => dayOf(context, addDays(weekStart, index))) },
    committed,
    overcommit: overcommitRows(context, committed),
    hints: {
      assumedEstimateCount: committed.filter(item => item.assumed).length,
      unestimatedSeriesCount,
      hasEstimates: committed.some(item => !item.assumed),
      empty: (input.tasks ?? []).length === 0 && blocks.length === 0 && (input.series ?? []).length === 0,
    },
  };
}

/**
 * The sentence for one overcommitted deadline, in the words the radar uses:
 * `1h over for Fri. Move something or push a deadline.` The day name is read
 * from the date key, so it does not depend on the runtime's zone.
 */
export function overcommitNote(row: Overcommit): string {
  const day = formatWall(keyToWallUtc(row.deadline), { weekday: "short" });
  return t("radar.overcommit", { over: formatEstimate(row.overMinutes), day });
}

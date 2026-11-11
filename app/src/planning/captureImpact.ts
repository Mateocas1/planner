import { ASSUMED_ESTIMATE_MINUTES } from "../domain/model.ts";
import { dateKey, minutesPerDay, wallMinutes } from "../ui/time.ts";
import { suggestEstimate, type BiasSample, type BiasSuggestion } from "./bias.ts";
import { capacity, dayCapacity, type CapacityInput, type DayCapacity, type Overcommit } from "./capacity.ts";
import { freeSlots, type Interval, type WorkWindow } from "./window.ts";

/**
 * What a captured task would do to the radar (capture inbox U3): the
 * due day's booked share before and after, the earliest free slot on that day
 * and the bias chip. The card shows "Fri 14: 62% -> 79% booked [Block 10:00]".
 *
 * The radar only counts blocks, and a task reaches it through its deadline and
 * estimate. So "after" is the due day's blocks plus the estimate, the load the
 * day would carry once the work is done on it; the cumulative deadline check
 * comes from `capacity()` run on the live planner plus the candidate. The bias
 * chip is shown, never applied: the radar counts the stated estimate.
 *
 * Pure: the clock is injected as `now`, the zone comes from the profile, and
 * wall-clock reading goes through `ui/time.ts`. Nothing is written.
 */

/** A proposal as the card holds it: only the fields the radar reads. */
export type CaptureCandidate = {
  title: string;
  /** Profile-zone date key; without one the task has no place on the radar. */
  dueDay: string | null;
  /** Minutes; null, absent or unusable means "unstated" (60 assumed). */
  estimateMinutes?: number | null;
  /** Wall-clock minutes after midnight the text named, if any. */
  startMinutes?: number | null;
};

/** The radar input plus the bias history, with the live planner left untouched. */
export type CaptureImpactInput = CapacityInput & {
  samples?: readonly BiasSample[];
};

/** A free range of the due day, in wall-clock minutes after midnight. */
export type CaptureSlot = { startMinutes: number; endMinutes: number };

/** The chip data for "usually +30%: 60 min". */
export type CaptureBias = {
  /** Signed whole percent over (positive) or under (negative) the estimate. */
  percent: number;
  /** The padded estimate the chip offers, a multiple of five. */
  minutes: number;
  ratio: number;
  sampleCount: number;
  source: BiasSuggestion["source"];
};

export type CaptureImpact = {
  dueDay: string;
  /** The estimate the radar counted: the stated one, else the assumed hour. */
  estimateMinutes: number;
  /** True when `estimateMinutes` is the 60-minute assumption. */
  assumed: boolean;
  /** The due day as the radar reads it today. */
  before: DayCapacity;
  /** Blocks plus the estimate; may exceed the window. */
  afterBookedMinutes: number;
  /** `afterBookedMinutes` as a share of the window, capped at 100 for the bar. */
  afterPercent: number;
  /** True when the estimate does not fit in the day's free minutes. */
  overbooked: boolean;
  /** How much of the estimate exceeds the day's free time; 0 when it fits. */
  overMinutes: number;
  /** Earliest free slot that holds the estimate, or null (none fits). */
  slot: CaptureSlot | null;
  /** The due-day deadline row before and after the candidate joins the planner. */
  overcommit: { before: Overcommit | null; after: Overcommit | null };
  /** The user's pace on tasks like this, or null (no history, or on target). */
  bias: CaptureBias | null;
};

/** The wall-clock minutes a block occupies on one profile-zone day, if any. */
function spanOn(block: { start: string; end: string }, date: string, timeZone: string): Interval | null {
  const start = Date.parse(block.start);
  const end = Date.parse(block.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const first = dateKey(new Date(start), timeZone);
  const last = dateKey(new Date(end), timeZone);
  if (date < first || date > last) return null;
  const from = date === first ? wallMinutes(new Date(start), timeZone) : 0;
  const to = date === last ? wallMinutes(new Date(end), timeZone) : minutesPerDay;
  return to > from ? { startMinutes: from, endMinutes: to } : null;
}

/**
 * The earliest free range of `minutes` inside `window`, starting no earlier
 * than the quarter hour after `fromMinutes` (null: the window's start). A
 * `preferredStart` wins when the range it asks for is free.
 */
export function findSlot(
  occupied: readonly Interval[],
  window: WorkWindow,
  minutes: number,
  fromMinutes: number | null,
  preferredStart: number | null = null,
): CaptureSlot | null {
  const slots = freeSlots(occupied, window, fromMinutes);
  if (preferredStart !== null) {
    const wanted = slots.find(([start, end]) => start <= preferredStart && preferredStart + minutes <= end);
    if (wanted) return { startMinutes: preferredStart, endMinutes: preferredStart + minutes };
  }
  const fit = slots.find(([start, end]) => end - start >= minutes);
  return fit ? { startMinutes: fit[0], endMinutes: fit[0] + minutes } : null;
}

/** The overcommit row for one deadline, if the planner reports it. */
function rowFor(input: CapacityInput, dueDay: string): Overcommit | null {
  return capacity(input).overcommit.find(row => row.deadline === dueDay) ?? null;
}

/**
 * The radar impact of one proposal, or null when it has no place on the radar:
 * no due day, a due day that is not a date key, or one already past.
 */
export function captureImpact(input: CaptureImpactInput, candidate: CaptureCandidate): CaptureImpact | null {
  const dueDay = candidate.dueDay;
  if (dueDay === null || !/^\d{4}-\d{2}-\d{2}$/.test(dueDay)) return null;
  const today = dateKey(input.now, input.timeZone);
  if (dueDay < today) return null;

  const stated = candidate.estimateMinutes;
  const usable = typeof stated === "number" && Number.isFinite(stated) && stated > 0;
  const estimateMinutes = usable ? stated : ASSUMED_ESTIMATE_MINUTES;

  const before = dayCapacity(input, dueDay);
  const occupied: Interval[] = [];
  for (const block of input.blocks ?? []) {
    const span = spanOn(block, dueDay, input.timeZone);
    if (span) occupied.push(span);
  }
  const fromNow = dueDay === today ? wallMinutes(input.now, input.timeZone) : null;

  const afterBookedMinutes = before.bookedMinutes + estimateMinutes;
  const afterPercent = before.windowMinutes > 0 ? Math.min(100, Math.round((afterBookedMinutes / before.windowMinutes) * 100)) : 0;
  const overMinutes = Math.max(0, estimateMinutes - before.freeFromNowMinutes);

  const withCandidate: CapacityInput = {
    ...input,
    tasks: [...(input.tasks ?? []), { id: "capture:candidate", title: candidate.title, deadline: dueDay, estimate: estimateMinutes }],
  };

  const suggestion = suggestEstimate(input.samples ?? [], {
    title: candidate.title,
    ...(usable ? { estimate: estimateMinutes } : {}),
  });

  return {
    dueDay,
    estimateMinutes,
    assumed: !usable,
    before,
    afterBookedMinutes,
    afterPercent,
    overbooked: overMinutes > 0,
    overMinutes,
    slot: findSlot(occupied, input.workWindow, estimateMinutes, fromNow, candidate.startMinutes ?? null),
    overcommit: { before: rowFor(input, dueDay), after: rowFor(withCandidate, dueDay) },
    bias: suggestion
      ? {
          percent: Math.round((suggestion.ratio - 1) * 100),
          minutes: suggestion.minutes,
          ratio: suggestion.ratio,
          sampleCount: suggestion.sampleCount,
          source: suggestion.source,
        }
      : null,
  };
}

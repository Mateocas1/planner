/**
 * The working window and the free time inside it (W1).
 *
 * Extracted from `ui/Calendar.tsx` so the capacity radar (F1a) and
 * plan-my-day (F4a) can share one pure definition of "free" instead of each
 * restating it. The profile's work window (08:00-21:00 by default, editable in
 * Day settings, S1) is the only input this module knows about; it holds the
 * planner's wall-clock minutes after midnight, never instants, so a DST day
 * keeps its 13-hour window (the day may be 23 or 25 hours long, but its wall
 * clock still reads 08:00 and 21:00).
 *
 * Everything here is a pure function: no Firebase, no React, no clock.
 */

/** Length of a nominal day in minutes; mirrors `ui/time.ts` so this module
 * stays dependency-free (F1a and F4a import it without pulling UI code in). */
export const minutesPerDay = 1440;

/** A half-open range of wall-clock minutes, `[startMinutes, endMinutes)`. */
export type Interval = { startMinutes: number; endMinutes: number };

/** One working window, in minutes after midnight in the profile zone. */
export type WorkWindow = { startMinutes: number; endMinutes: number };

/** 08:00-21:00 for all seven days (roadmap §5.4): the same span the Plan
 * feature has always used, now stored in the profile so it is editable. */
export const defaultWorkWindow: WorkWindow = { startMinutes: 8 * 60, endMinutes: 21 * 60 };

/** A window whose end is not after its start is meaningless; reject it before
 * it reaches the server. */
export function validateWorkWindow(window: WorkWindow): void {
  if (window.endMinutes <= window.startMinutes) {
    throw new Error("work window end must be after start");
  }
}

/**
 * Read the working window from a profile document, falling back to the default
 * (08:00-21:00) when the stored fields are absent, non-numeric, out of the day
 * or inverted.  The reader accepts both numeric and string values so it works
 * with the emulator harness (which encodes strings) and with real Firestore
 * writes (which persist numbers).  Readers never fail — a profile written by
 * an older client, or by nobody yet, still yields a usable window.
 */
export function parseWorkWindow(data: Record<string, unknown> | undefined): WorkWindow {
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (!isNaN(n)) return n;
    }
    return undefined;
  };
  const startMinutes = num(data?.workStart);
  const endMinutes = num(data?.workEnd);
  if (
    typeof startMinutes === "number" &&
    typeof endMinutes === "number" &&
    startMinutes >= 0 &&
    endMinutes > startMinutes &&
    endMinutes <= minutesPerDay
  ) {
    return { startMinutes, endMinutes };
  }
  return defaultWorkWindow;
}

/**
 * The union of a set of intervals, sorted by start: overlapping ranges
 * collapse into one and touching ranges merge (the gap between them is
 * empty). Clipping to the day is the caller's job, because the capacity
 * radar clips to the work window while the grid clips at midnight.
 */
export function mergeIntervals(items: readonly Interval[]): Interval[] {
  const sorted = [...items].sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, item.endMinutes);
    } else {
      merged.push({ startMinutes: item.startMinutes, endMinutes: item.endMinutes });
    }
  }
  return merged;
}

/**
 * Free `[start, end)` minute ranges of one day inside `window`, starting no
 * earlier than the next quarter hour after `fromMinutes` (null means "from
 * the window's start"). Occupied ranges may come unsorted and may overlap.
 *
 * The body is the original `Calendar.tsx` sweep, unchanged apart from the
 * window argument, so the Plan feature keeps placing blocks exactly where it
 * did before. `window.ts`'s tests pin that parity fixture by fixture.
 */
export function freeSlots(items: readonly Interval[], window: WorkWindow, fromMinutes: number | null): [number, number][] {
  let cursor = Math.max(window.startMinutes, fromMinutes === null ? 0 : Math.ceil((fromMinutes + 5) / 15) * 15);
  const slots: [number, number][] = [];
  for (const item of [...items].sort((left, right) => left.startMinutes - right.startMinutes)) {
    if (item.endMinutes <= cursor) continue;
    if (item.startMinutes > cursor) slots.push([cursor, Math.min(item.startMinutes, window.endMinutes)]);
    cursor = Math.max(cursor, item.endMinutes);
    if (cursor >= window.endMinutes) break;
  }
  if (cursor < window.endMinutes) slots.push([cursor, window.endMinutes]);
  return slots.filter(([start, end]) => end > start);
}

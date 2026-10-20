/**
 * Calendar grid arithmetic: the pure minute maths shared by direct
 * manipulation (drag-create, edge resize, keyboard resize) and the grid's own
 * empty-slot creation.
 *
 * A block edge always lands on the grid's step, and a block keeps at least one
 * step between its start and its end. Days are minute counts after the profile
 * zone's midnight; instants are built through the wall-clock helpers in
 * time.ts, so a block that ends at midnight becomes the next day's 00:00.
 */

import { dayMs, keyToWallUtc, localValue, minutesPerDay, toZonedInstant, wallDayKey } from "./time.ts";

/** The grid's step: an edge snaps to half hours (the empty-slot creation step). */
export const stepMinutes = 30;
/** The shortest block a resize may produce: one step. */
export const minBlockMinutes = 30;
/** How long a task dropped on the grid is planned for. */
export const dropLengthMinutes = 60;

/** Rounds minutes to the step inside [min, max]. */
function snapInside(minutes: number, min: number, max: number): number {
  const snapped = Math.round(minutes / stepMinutes) * stepMinutes;
  return Math.max(min, Math.min(max, snapped));
}

/** Rounds minutes to the step, clamped to the day. */
export function snapMinutes(minutes: number): number {
  return snapInside(minutes, 0, minutesPerDay);
}

/**
 * The block a single edge dragged by `deltaMinutes` would produce: the moving
 * edge snaps to the step, the other edge stays put, the pair stays at least
 * `minBlockMinutes` apart, and neither edge leaves the day.
 *
 * A stored block shorter than one step can only grow from here: its moving edge
 * refuses the direction that would have to snap it past the other edge.
 */
export function movedEdge(
  edge: "start" | "end",
  deltaMinutes: number,
  start: number,
  end: number,
  dayMinutes: number = minutesPerDay,
): { start: number; end: number } {
  if (edge === "start") {
    return { start: snapInside(start + deltaMinutes, 0, Math.max(0, Math.min(dayMinutes, end) - minBlockMinutes)), end };
  }
  return { start, end: snapInside(end + deltaMinutes, start + minBlockMinutes, dayMinutes) };
}

/** The block a single edge sits at while it is dragged, before snapping: the
 * pointer's minute, clamped so the block never inverts or leaves the day, and
 * so an edge of a block shorter than one step never moves the block backwards. */
export function draggedEdge(
  edge: "start" | "end",
  deltaMinutes: number,
  start: number,
  end: number,
  dayMinutes: number = minutesPerDay,
): { start: number; end: number } {
  if (edge === "start") {
    const latest = end - minBlockMinutes >= start ? end - minBlockMinutes : start;
    return { start: Math.max(0, Math.min(start + deltaMinutes, latest)), end };
  }
  const earliest = start + minBlockMinutes <= end ? start + minBlockMinutes : end;
  return { start, end: Math.min(dayMinutes, Math.max(end + deltaMinutes, earliest)) };
}

/** Where a task dropped at `minutes` starts: snapped, with room for its length. */
export function dropStart(minutes: number, lengthMinutes: number = dropLengthMinutes, dayMinutes: number = minutesPerDay): number {
  const last = Math.max(0, dayMinutes - lengthMinutes);
  return snapInside(Math.min(minutes, last), 0, last);
}

/**
 * The stored instant for a wall-clock minute of a day key in a zone. Minute
 * `minutesPerDay` (or more) rolls into the next day, because a block may end at
 * midnight and the domain refuses 24:00.
 */
export function instantForEdge(dayKey: string, minutes: number, timeZone: string): string {
  const whole = Math.round(minutes);
  if (whole < minutesPerDay) return toZonedInstant(localValue(dayKey, Math.max(0, whole)), timeZone);
  const nextDay = wallDayKey(keyToWallUtc(dayKey) + dayMs);
  return toZonedInstant(localValue(nextDay, whole - minutesPerDay), timeZone);
}

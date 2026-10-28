import { ASSUMED_ESTIMATE_MINUTES, MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES } from "../domain/model.ts";

/** The grid the stepper moves on, in minutes. */
export const ESTIMATE_GRID_MINUTES = 5;

/** Coarse step for Shift+Arrow and PageUp/PageDown. */
export const ESTIMATE_COARSE_STEP = 30;

/**
 * The estimate one step away from `current`. An empty field starts from the
 * 60-minute assumption; any other value snaps to the 5-minute grid in the
 * direction of travel first (47 up is 50, 47 down is 45), then moves, then
 * clamps to the domain bounds.
 */
export function stepEstimate(current: number | undefined, delta: number): number {
  let next: number;
  if (current === undefined) {
    next = ASSUMED_ESTIMATE_MINUTES + delta;
  } else {
    const onGrid = current % ESTIMATE_GRID_MINUTES === 0;
    const snapped = onGrid
      ? current
      : delta > 0
        ? Math.ceil(current / ESTIMATE_GRID_MINUTES) * ESTIMATE_GRID_MINUTES
        : Math.floor(current / ESTIMATE_GRID_MINUTES) * ESTIMATE_GRID_MINUTES;
    // Snapping already consumed one step when it moved the value in the travel direction.
    const stepsLeft = onGrid ? delta : delta > 0 ? delta - ESTIMATE_GRID_MINUTES : delta + ESTIMATE_GRID_MINUTES;
    next = snapped + stepsLeft;
  }
  return Math.min(MAX_ESTIMATE_MINUTES, Math.max(MIN_ESTIMATE_MINUTES, next));
}

/** Keeps digits only, the one character class the field accepts. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** The draft as a number, or undefined when empty (the 60-minute assumption). */
export function parseDraft(draft: string): number | undefined {
  return draft === "" ? undefined : Number(draft);
}

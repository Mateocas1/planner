/**
 * Pure month-grid model for the date picker (form-controls.md §6.2).
 *
 * Days are `YYYY-MM-DD` keys. Arithmetic goes through wall-UTC values
 * (`keyToWallUtc`/`wallDayKey`), so a key never passes through the browser's
 * local zone: there is no `new Date(local)` here and DST cannot move a day.
 * `today` always arrives as a key derived in the profile zone (D3).
 */

import { dayMs, keyToWallUtc, wallDayKey } from "./time.ts";

/** 0 = Sunday ... 6 = Saturday, as `Date#getUTCDay`. */
export type WeekStart = number;

export const gridCells = 42;

/** Weekday of a day key, 0 = Sunday. */
export function weekdayOf(key: string): number {
  return new Date(keyToWallUtc(key)).getUTCDay();
}

/** The key `delta` calendar days from `key`. */
export function shiftDay(key: string, delta: number): string {
  return wallDayKey(keyToWallUtc(key) + delta * dayMs);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The key `delta` months from `key`, the day clamped to the target month ("Jan 31" + 1 = "Feb 28"). */
export function shiftMonth(key: string, delta: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const clamped = Math.min(day, daysInMonth(targetYear, targetMonth));
  return wallDayKey(Date.UTC(targetYear, targetMonth - 1, clamped));
}

/** The key `delta` years from `key` ("Feb 29" lands on "Feb 28" in a common year). */
export function shiftYear(key: string, delta: number): string {
  return shiftMonth(key, delta * 12);
}

/** First and last day of the week that contains `key`. */
export function weekEdges(key: string, weekStart: WeekStart): { first: string; last: string } {
  const offset = (weekdayOf(key) - weekStart + 7) % 7;
  const first = shiftDay(key, -offset);
  return { first, last: shiftDay(first, 6) };
}

/** The 42 keys (six full weeks) shown for a `YYYY-MM` month; a stable height whatever the month. */
export function monthCells(month: string, weekStart: WeekStart): string[] {
  const first = `${month}-01`;
  const start = weekEdges(first, weekStart).first;
  return Array.from({ length: gridCells }, (_, index) => shiftDay(start, index));
}

export interface QuickDates {
  today: string;
  tomorrow: string;
  /** The coming Saturday; `null` on Fri/Sat/Sun, where it would duplicate Today/Tomorrow or be a week out. */
  weekend: string | null;
  /** The first week-start day strictly after today. */
  nextWeek: string;
}

/** The resolved quick-list rows for a deadline (form-controls.md §3.1). */
export function quickDates(today: string, weekStart: WeekStart): QuickDates {
  const weekday = weekdayOf(today);
  const toSaturday = 6 - weekday;
  // Thursday (+2) is the latest day whose Saturday lies strictly after tomorrow.
  const weekend = weekday >= 1 && weekday <= 4 ? shiftDay(today, toSaturday) : null;
  const untilStart = ((weekStart - weekday + 7) % 7) || 7;
  return {
    today,
    tomorrow: shiftDay(today, 1),
    weekend,
    nextWeek: shiftDay(today, untilStart),
  };
}

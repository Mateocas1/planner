/**
 * Profile-timezone wall-clock helpers shared by every surface (D3).
 *
 * Every wall-clock part (day keys, hours, weekday names) is derived from the
 * stored profile zone through Intl.DateTimeFormat -- never from the browser's
 * getHours/getTimezoneOffset. Calendar days are handled as "wall-UTC" values:
 * the zone's wall date read as a UTC midnight, so day arithmetic on them yields
 * the zone's own calendar days.
 *
 * The instant arithmetic itself (wall parts, offsets, toZonedInstant) lives in
 * domain/instant.ts, because turning a wall clock into a stored instant is a
 * model concern; it is re-exported here so surfaces keep one import site.
 */

import { pad, wallAsUtc, wallParts, type WallParts } from "../domain/instant.ts";
import { getLocale, intlLocale, type Locale } from "../i18n/index.ts";

export { dateKey, pad, toZonedInstant, wallAsUtc, wallParts } from "../domain/instant.ts";
export type { WallParts } from "../domain/instant.ts";

export const dayMs = 86_400_000;
export const minutesPerDay = 1440;

/** Date key of a wall-UTC day value. */
export function wallDayKey(wallUtc: number): string {
  const date = new Date(wallUtc);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Wall-UTC day value of a date key. */
export function keyToWallUtc(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

/** The zone's today as a wall-UTC midnight. */
export function todayWallUtc(timeZone: string, now: Date = new Date()): number {
  const parts = wallParts(now, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

/** Minutes since the zone's midnight for an instant. */
export function wallMinutes(date: Date, timeZone: string): number {
  const parts = wallParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Wall-clock HH:MM of an instant in the given zone. */
export function timeLabel(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Monday of the week containing a wall-UTC day value. */
export function mondayOf(wallUtc: number): number {
  return wallUtc - ((new Date(wallUtc).getUTCDay() + 6) % 7) * dayMs;
}

/** A datetime-local value for a day key plus minutes since midnight. */
export function localValue(key: string, minutes: number): string {
  return `${key}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

const utc = { timeZone: "UTC" } as const;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats a wall-UTC day value with the given options, read as UTC, in the app
 * language (English is en-US as it always was). Formatters are cached per
 * language and options.
 */
export function formatWall(wallUtc: number, options: Intl.DateTimeFormatOptions, locale: Locale = getLocale()): string {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = wallFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlLocale(locale), { ...utc, ...options });
    wallFormatters.set(key, formatter);
  }
  return formatter.format(new Date(wallUtc));
}

/** A duration in minutes as the planner writes it: "40 min", "1 h", "1 h 30 min". */
export function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

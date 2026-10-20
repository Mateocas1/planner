/**
 * Profile-timezone wall-clock helpers shared by every surface (D3).
 *
 * Every wall-clock part (day keys, hours, weekday names) is derived from the
 * stored profile zone through Intl.DateTimeFormat -- never from the browser's
 * getHours/getTimezoneOffset. Calendar days are handled as "wall-UTC" values:
 * the zone's wall date read as a UTC midnight, so day arithmetic on them yields
 * the zone's own calendar days.
 */

export const dayMs = 86_400_000;
export const minutesPerDay = 1440;

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export type WallParts = { year: number; month: number; day: number; hour: number; minute: number };

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a named IANA zone. */
export function wallParts(date: Date, timeZone: string): WallParts {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Date key (YYYY-MM-DD) of an instant in the given zone. */
export function dateKey(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Date key of a wall-UTC day value. */
export function wallDayKey(wallUtc: number): string {
  const date = new Date(wallUtc);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Wall-UTC day value of a date key. */
export function keyToWallUtc(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

/** Epoch ms of an instant's wall clock in the zone, read as if UTC. */
export function wallAsUtc(date: Date, timeZone: string): number {
  const parts = wallParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
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

/** The zone's offset at an instant, formatted +HH:MM / -HH:MM (from Intl).
 * An instant's offset is its wall clock minus the instant itself: in
 * America/Sao_Paulo 09:30 is 12:30Z, so the offset is -03:00. */
function zoneOffset(stamp: number, timeZone: string): string {
  const minutes = Math.round((wallAsUtc(new Date(stamp), timeZone) - stamp) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The wall-clock value (YYYY-MM-DDTHH:MM) an instant reads as in a zone. */
function wallValue(stamp: number, timeZone: string): string {
  const parts = wallParts(new Date(stamp), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Converts a datetime-local value (YYYY-MM-DDTHH:MM) into a zoned ISO instant
 * interpreted in the given zone. Two correction passes land the instant whose
 * wall clock in the zone equals the input (stamp = wall - offset); a zone's own
 * offset at the result is what the string carries.
 *
 * A wall clock a DST gap skips names no instant: the passes resolve to the
 * first wall clock the zone shows after the gap, and the returned string names
 * that clock, so the string never denotes an instant the zone reads differently. */
export function toZonedInstant(value: string, timeZone: string): string {
  const guess = Date.parse(`${value}:00Z`);
  let stamp = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    stamp = guess - (wallAsUtc(new Date(stamp), timeZone) - stamp);
  }
  return `${wallValue(stamp, timeZone)}:00${zoneOffset(stamp, timeZone)}`;
}

/** A datetime-local value for a day key plus minutes since midnight. */
export function localValue(key: string, minutes: number): string {
  return `${key}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

const utc = { timeZone: "UTC" } as const;

/** Formats a wall-UTC day value with the given options (en-US, read as UTC). */
export function formatWall(wallUtc: number, options: Intl.DateTimeFormatOptions): string {
  return new Date(wallUtc).toLocaleDateString("en-US", { ...utc, ...options });
}

/** A duration in minutes as the planner writes it: "40 min", "1 h", "1 h 30 min". */
export function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

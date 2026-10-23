/**
 * Zoned-instant arithmetic, kept in the domain layer because it is what turns a
 * wall clock in a named IANA zone into the explicit-offset ISO instant the
 * model stores (see `model.createWorkBlock`). The surfaces re-export these
 * helpers from `ui/time.ts`; there is one implementation.
 *
 * Every wall-clock part comes from Intl, never from the browser's own offset,
 * so a result is the same in any runtime zone.
 */

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

/** Epoch ms of an instant's wall clock in the zone, read as if UTC. */
export function wallAsUtc(date: Date, timeZone: string): number {
  const parts = wallParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
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

/** Date key (YYYY-MM-DD) of an instant in the given zone. Lives here with the
 *  other zoned-arithmetic helpers (ronda 2, review fix 5): the model derives
 *  day keys from stored instants, so the domain layer must not reach into the
 *  ui/ — surfaces re-export it from `ui/time.ts` as before. */
export function dateKey(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
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

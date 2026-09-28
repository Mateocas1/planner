/**
 * Human date formatting for the planner surfaces (C1).
 *
 * Stored values stay ISO `YYYY-MM-DD`; only what the user reads changes. A
 * date key is a calendar day, so it is read back as a UTC midnight -- never
 * through the ambient zone, which could shift it by a day. Both formatters
 * take the browser's locale (Intl's own default) so nothing here hardcodes
 * one, and "today"/"tomorrow" are localized words rather than dates.
 */

const dayMs = 86_400_000;

const shortDate = new Intl.DateTimeFormat(undefined, {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

const relativeDay = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Epoch ms of a stored date key read as UTC midnight, or null when malformed. */
function dateKeyToUtc(dateKey: string): number | null {
  const stamp = Date.parse(`${dateKey}T00:00:00Z`);
  return Number.isNaN(stamp) ? null : stamp;
}

/**
 * A stored date key as the planner shows it: "today" and "tomorrow" are words
 * (localized by Intl), any other day is a short locale date such as
 * "Mon 29 Sep" in English. `today` is the profile zone's own date key (D3), so
 * the words follow the planner's day, not the browser's midnight.
 */
export function formatDateKey(dateKey: string, today: string): string {
  const stamp = dateKeyToUtc(dateKey);
  if (stamp === null) return dateKey;
  const todayStamp = dateKeyToUtc(today);
  if (todayStamp !== null) {
    const days = Math.round((stamp - todayStamp) / dayMs);
    if (days === 0) return relativeDay.format(0, "day");
    if (days === 1) return relativeDay.format(1, "day");
  }
  return shortDate.format(new Date(stamp));
}

/** True when a stored date key falls before the planner's today. */
export function isPastDateKey(dateKey: string, today: string): boolean {
  const stamp = dateKeyToUtc(dateKey);
  const todayStamp = dateKeyToUtc(today);
  if (stamp === null || todayStamp === null) return false;
  return stamp < todayStamp;
}

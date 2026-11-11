/**
 * Human date formatting for the planner surfaces.
 *
 * Stored values stay ISO `YYYY-MM-DD`; only what the user reads changes. A
 * date key is a calendar day, so it is read back as a UTC midnight -- never
 * through the ambient zone, which could shift it by a day. Both formatters
 * take the browser's locale (Intl's own default) so nothing here hardcodes
 * one, and "today"/"tomorrow" are localized words rather than dates.
 *
 * Both formatters now follow the app language instead of the
 * browser's: English keeps the en-US output the app always showed, Spanish
 * reads "mar, 29 sept". The formatters are cached per language.
 */

import { getLocale, intlLocale, type Locale } from "../i18n/index.ts";

const dayMs = 86_400_000;

const formatters = new Map<Locale, { shortDate: Intl.DateTimeFormat; relativeDay: Intl.RelativeTimeFormat }>();

function formattersFor(locale: Locale) {
  let found = formatters.get(locale);
  if (!found) {
    const tag = intlLocale(locale);
    found = {
      shortDate: new Intl.DateTimeFormat(tag, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }),
      relativeDay: new Intl.RelativeTimeFormat(tag, { numeric: "auto" }),
    };
    formatters.set(locale, found);
  }
  return found;
}

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
export function formatDateKey(dateKey: string, today: string, locale: Locale = getLocale()): string {
  const { shortDate, relativeDay } = formattersFor(locale);
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

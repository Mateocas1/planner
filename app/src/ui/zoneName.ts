/**
 * The long, localized name of a time zone ("Brasilia Standard Time") for copy,
 * instead of the raw IANA id ("America/Sao_Paulo"). The id stays available as a
 * `title` so nothing is lost. The name follows the zone's offset at `at`, so a
 * zone with daylight saving reads "Eastern Daylight Time" in July.
 *
 * `locale` is a BCP 47 tag (`intlLocale(locale)` in the app). An unknown zone or
 * a runtime without the data falls back to the id, which is still readable.
 */
export function zoneName(timeZone: string, locale: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" })
      .formatToParts(at)
      .find(p => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

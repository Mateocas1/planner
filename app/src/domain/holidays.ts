/**
 * Holidays from Google's holiday calendars. A holiday is a label on a
 * day, never a task or a block: it changes no planning behavior, so nothing in
 * `planning/` reads this module. Pure on purpose -- no network, Firestore or
 * DOM -- so the classifier and the stored shape are testable on their own.
 */

/**
 * How a day off is classified. `public` is a statutory holiday, `nonWorking`
 * is a day many people take off but employers may not grant (Argentina's "día
 * no laborable"), `observance` is a commemoration that is not a day off, and
 * `other` is whatever the wording does not say.
 */
export type HolidayKind = "public" | "nonWorking" | "observance" | "other";

export const HOLIDAY_KINDS: readonly HolidayKind[] = ["public", "nonWorking", "observance", "other"];

/** How each kind reads on screen. */
export const holidayKindLabels: Record<HolidayKind, string> = {
  public: "Public holiday",
  nonWorking: "Non-working day",
  observance: "Observance",
  other: "Other",
};

/** Where a holiday came from; the document id is derived from it. */
export type HolidaySource = { provider: "gcal"; calendarId: string; eventId: string };

/** One holiday label, as the calendar shows it. */
export type Holiday = {
  /** The deterministic import document id (see `importDocId`). */
  id: string;
  /** ISO date-only (`YYYY-MM-DD`). */
  date: string;
  title: string;
  /** What the classifier decided from Google's wording. */
  kind: HolidayKind;
  /** The user's own classification; an import never writes or clears it. */
  kindOverride?: HolidayKind;
  /** The user hid this holiday; an import never writes or clears it. */
  hidden?: boolean;
  source: HolidaySource;
};

/** The kind the user sees: their override wins over the classifier. */
export function effectiveKind(holiday: Pick<Holiday, "kind" | "kindOverride">): HolidayKind {
  return holiday.kindOverride ?? holiday.kind;
}

export function isHolidayKind(value: unknown): value is HolidayKind {
  return typeof value === "string" && (HOLIDAY_KINDS as readonly string[]).includes(value);
}

/**
 * Google's holiday calendars have ids like `en.usa#holiday@group.v.calendar.google.com`
 * or `es.ar#holiday@group.v.calendar.google.com`. Matched on the suffix, case
 * insensitively, because the region prefix is open-ended.
 */
const holidayCalendarSuffix = "#holiday@group.v.calendar.google.com";

export function isHolidayCalendar(calendarId: string): boolean {
  return typeof calendarId === "string" && calendarId.toLowerCase().endsWith(holidayCalendarSuffix);
}

/** Lower case, accents and markup gone, so one pattern reads every spelling. */
function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Explicit "may be worked" wording. Argentina's calendar says "día no laborable"
 * (also "no laborable con fines turísticos"); English calendars say "non-working
 * day" / "optional holiday"; "dia inhabil" is the Spanish/Latin American variant.
 */
const nonWorkingWording = /\bno laborables?\b|\bnon[- ]?working\b|\boptional holiday\b|\bdias? inhabil/;
/** Statutory days off: Google's "Public holiday", Spanish "Feriado" / "Festivo". */
const publicWording = /\bpublic holiday\b|\bbank holiday\b|\bnational holiday\b|\bfederal holiday\b|\bstatutory\b|\bferiados?\b|\bdias? festivos?\b|\bfestivos?\b|\bfiesta nacional\b/;
/** Google's other holiday-calendar category: "Observance" / "Observancia". */
const observanceWording = /\bobservances?\b|\bobservancias?\b/;

/**
 * Classifies a holiday from the wording Google sends. A Google holiday event's
 * `description` starts with its category line ("Public holiday", "Observance",
 * in the calendar's language) and may be followed by a hint such as "To hide
 * observances, go to Google Calendar Settings > Holidays". So the category is
 * the description's first line only; the hint is never read as a category.
 * Explicit non-working wording anywhere in the description or title ("Día no
 * laborable") beats the category, because Argentina's non-working days are
 * spelled out in the name. An unrecognised line is `other`, never a guess.
 */
export function classifyHoliday(fields: { description?: unknown; summary?: unknown }): HolidayKind {
  const description = plainText(fields.description).trim();
  const category = description.split("\n")[0] ?? "";
  const summary = plainText(fields.summary);
  if (nonWorkingWording.test(description) || nonWorkingWording.test(summary)) return "nonWorking";
  for (const text of [category, summary]) {
    if (observanceWording.test(text)) return "observance";
    if (publicWording.test(text)) return "public";
  }
  return "other";
}

/** Reads a stored holiday document; a malformed one is dropped, never thrown on. */
export function parseHoliday(id: string, data: Record<string, unknown>): Holiday | null {
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (title === "" || typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return null;
  const source = data.source as Partial<HolidaySource> | undefined;
  if (source === undefined || source === null || typeof source !== "object"
    || source.provider !== "gcal" || typeof source.calendarId !== "string" || typeof source.eventId !== "string") {
    return null;
  }
  return {
    id,
    date: data.date,
    title,
    kind: isHolidayKind(data.kind) ? data.kind : "other",
    ...(isHolidayKind(data.kindOverride) ? { kindOverride: data.kindOverride } : {}),
    ...(data.hidden === true ? { hidden: true } : {}),
    source: { provider: "gcal", calendarId: source.calendarId, eventId: source.eventId },
  };
}

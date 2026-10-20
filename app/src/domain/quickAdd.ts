/**
 * Natural-language quick add (value roadmap §2.2, roadmap step 3).
 *
 * Turns what the user typed into the three things the model actually stores --
 * a title, a deadline day and a repeat -- and nothing else. Pure and
 * dependency-free: the caller passes the instant and the planner's zone, so one
 * text parses to one day in every browser, every device and every test.
 *
 * Rules that hold for the whole grammar:
 *
 * - A recognized part is removed from the title and reported in `parts` with the
 *   exact span it occupied, so the UI can show it as a chip and put that text
 *   back in the title when the chip is undone.
 * - Dates resolve forward and never into the past; an ambiguous day is its next
 *   occurrence (`fri` on a Friday is today, `next fri` is that weekday in the
 *   following week).
 * - A token the model has no field for is not consumed. The task schema is
 *   closed -- title, completed, optional deadline *day* -- so a time of day
 *   ("3pm", "16hs") and a pattern outside `daily | weekly | monthly` ("every
 *   weekday", "every other monday") stay in the title. Taking them out would
 *   silently drop what the user asked for.
 * - At most one date and one repeat are taken: the earliest match in the text
 *   wins, and the title keeps everything else.
 *
 * Grammar, in both English and Spanish, with or without accents:
 *
 * | Kind   | Tokens |
 * | ---    | --- |
 * | Date   | `today`/`hoy`, `tomorrow`/`mañana`, `day after tomorrow`/`pasado mañana`, `<weekday>`, `next <weekday>`, `in N days`, `in a week`, `dd/mm`, `dd/mm/yyyy`, `d mmm`/`d de mmm`/`mmm d` |
 * | Repeat | `every day`/`daily`/`todos los días`/`cada día`, `every week`/`weekly`/`cada semana`, `every month`/`monthly`/`cada mes`, `every <weekday>`/`cada <weekday>`/`los <weekday>`/`todos los <weekday>` |
 *
 * Weekdays: mon/monday, tue/tuesday, wed/wednesday, thu/thursday, fri/friday,
 * sat/saturday, sun/sunday and lun/lunes, mar/martes, mié/miércoles,
 * jue/jueves, vie/viernes, sáb/sábado, dom/domingo. Months: the English names and
 * their three-letter forms, and ene/enero, feb/febrero, mar/marzo, abr/abril,
 * may/mayo, jun/junio, jul/julio, ago/agosto, sep/septiembre, oct/octubre,
 * nov/noviembre, dic/diciembre.
 */

/** The frequencies `domain/model.ts` defines for a series, restated here so the
 * domain stays free of the data layer that owns the write helpers. */
export type QuickAddFrequency = "daily" | "weekly" | "monthly";

/** One recognized part, and the exact text the user typed for it. */
export type QuickAddDatePart = {
  kind: "date";
  text: string;
  start: number;
  end: number;
  /** The day the date resolves to, as a `YYYY-MM-DD` planner date key. */
  date: string;
};

export type QuickAddRepeatPart = {
  kind: "repeat";
  text: string;
  start: number;
  end: number;
  frequency: QuickAddFrequency;
  /** For `every mon`: the weekday the series starts on (0 = Sunday). */
  weekday?: number;
};

export type QuickAddPart = QuickAddDatePart | QuickAddRepeatPart;

export type QuickAddPartKind = QuickAddPart["kind"];

export type QuickAdd = {
  /** The title with the recognized parts taken out, whitespace and stray
   * punctuation cleaned up. May be empty: the sheet decides what that means. */
  title: string;
  /** What was recognized, in the order it appears in the text. */
  parts: QuickAddPart[];
  /** The date part's day: what the Deadline control shows. */
  deadline?: string;
  /** The repeat part's frequency: what the Repeat control shows. */
  frequency?: QuickAddFrequency;
  /** The first day of the series: the named day when there is one, else today. */
  anchorDate?: string;
};

export type QuickAddInput = {
  /** The instant the text is parsed at, so a test can pin "now". */
  now: Date;
  /** The profile time zone: a day is the planner's day, never the browser's. */
  timeZone: string;
  /**
   * Matched texts whose chip the user undid, compared case-insensitively. Their
   * text stays in the title and they are not consumed again, so undoing a chip
   * is stable while the rest of the text keeps parsing.
   */
  ignore?: readonly string[];
};

const dayMs = 86_400_000;

/* ---------- the planner's calendar day ---------- */

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's wall-clock day of an instant, as a `YYYY-MM-DD` key. */
function dayKeyIn(now: Date, timeZone: string): string {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const keyToStamp = (key: string) => Date.parse(`${key}T00:00:00Z`);
const stampToKey = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);

/** `key` moved by whole calendar days. */
function addDays(key: string, days: number): string {
  return stampToKey(keyToStamp(key) + days * dayMs);
}

/** Weekday of a day key, 0 = Sunday. */
function weekdayOf(key: string): number {
  return new Date(keyToStamp(key)).getUTCDay();
}

/** A validated day key, or null when the month has no such day. */
function keyFor(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** The nearest occurrence of a weekday: today when it is today, unless `after`
 * asks for the same weekday in the following week. */
function upcomingWeekday(today: string, weekday: number, after: boolean): string {
  const delta = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, after ? delta + 7 : delta);
}

/* ---------- the vocabulary ---------- */

const weekdayNames: Array<{ weekday: number; names: string[] }> = [
  { weekday: 1, names: ["monday", "mon", "lunes", "lun"] },
  { weekday: 2, names: ["tuesday", "tues", "tue", "martes", "mar"] },
  { weekday: 3, names: ["wednesday", "weds", "wed", "miércoles", "miercoles", "mié", "mie"] },
  { weekday: 4, names: ["thursday", "thurs", "thur", "thu", "jueves", "jue"] },
  { weekday: 5, names: ["friday", "fri", "viernes", "vie"] },
  { weekday: 6, names: ["saturday", "sat", "sábado", "sabado", "sáb", "sab"] },
  { weekday: 0, names: ["sunday", "sun", "domingo", "dom"] },
];

const monthNames: Array<{ month: number; names: string[] }> = [
  { month: 1, names: ["january", "jan", "enero", "ene"] },
  { month: 2, names: ["february", "feb", "febrero"] },
  { month: 3, names: ["march", "mar", "marzo"] },
  { month: 4, names: ["april", "apr", "abril", "abr"] },
  { month: 5, names: ["may", "mayo"] },
  { month: 6, names: ["june", "jun", "junio"] },
  { month: 7, names: ["july", "jul", "julio"] },
  { month: 8, names: ["august", "aug", "agosto", "ago"] },
  { month: 9, names: ["september", "sept", "sep", "septiembre", "setiembre"] },
  { month: 10, names: ["october", "oct", "octubre"] },
  { month: 11, names: ["november", "nov", "noviembre"] },
  { month: 12, names: ["december", "dec", "diciembre", "dic"] },
];

const weekdayByName = new Map<string, number>(
  weekdayNames.flatMap(entry => entry.names.map(name => [name, entry.weekday] as const)),
);

const monthByName = new Map<string, number>(
  monthNames.flatMap(entry => entry.names.map(name => [name, entry.month] as const)),
);

/** The alternatives of a name list, longest first so `monday` beats `mon`. */
function alternation(names: Iterable<string>): string {
  const unique = [...new Set(names)].sort((left, right) => right.length - left.length);
  return unique.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/* ---------- rules ---------- */

type Context = { today: string };

type DateRule = {
  /** Regex source; matched with the `giu` flags and checked for word boundaries. */
  source: string;
  /** Reject a bare weekday that a repeat word in front of it already claims. */
  guarded?: boolean;
  /** The day the match names, or null when it names a day the planner will not take. */
  resolve: (match: RegExpExecArray, context: Context) => string | null;
};

type RepeatRule = {
  source: string;
  resolve: (match: RegExpExecArray) => { frequency: QuickAddFrequency; weekday?: number } | null;
};

const weekdays = alternation(weekdayNames.flatMap(entry => entry.names));
const months = alternation(monthNames.flatMap(entry => entry.names));

/** A prefix that may introduce a weekday. Only "next"-family prefixes -- the
 * English ones and the Spanish "que viene" suffix -- move the day past this week;
 * "on"/"el" still mean the nearest one. */
const weekdaySource = `(?:(next|pr[oó]ximo|proximo|siguiente|this|on|el|este)\\s+)?(${weekdays})(?:\\s+(que\\s+viene|pr[oó]ximo|proximo|siguiente))?`;

/** Words that make the word after them a repeat, not a one-off date. */
const repeatClaim = /^(?:every|each|cada|todos|todas|los|las|other|otro|otra)$/i;

/** `dd/mm`, optionally with a year. */
const numberedDate = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;

const dateRules: DateRule[] = [
  { source: `hoy|today`, resolve: (_match, context) => context.today },
  {
    source: `pasado\\s+mañana|pasado\\s+manana|(?:the\\s+)?day\\s+after\\s+tomorrow`,
    resolve: (_match, context) => addDays(context.today, 2),
  },
  {
    source: `tomorrow|tmrw|mañana|manana`,
    resolve: (_match, context) => addDays(context.today, 1),
  },
  {
    source: `in\\s+(\\d{1,3})\\s+days?|en\\s+(\\d{1,3})\\s+d[ií]as?`,
    resolve: (match, context) => {
      const amount = Number(match[1] ?? match[2]);
      return amount >= 1 ? addDays(context.today, amount) : null;
    },
  },
  {
    source: `in\\s+a\\s+day|en\\s+un\\s+d[ií]a`,
    resolve: (_match, context) => addDays(context.today, 1),
  },
  {
    source: `in\\s+a\\s+week|en\\s+una\\s+semana`,
    resolve: (_match, context) => addDays(context.today, 7),
  },
  {
    source: weekdaySource,
    guarded: true,
    resolve: (match, context) => {
      const weekday = weekdayByName.get(match[2]!.toLowerCase());
      if (weekday === undefined) return null;
      const after = [match[1], match[3]].some(mover => mover !== undefined && /^(?:next|pr|que|sig)/i.test(mover));
      return upcomingWeekday(context.today, weekday, after);
    },
  },
  {
    source: `(?:el\\s+|on\\s+)?${numberedDate.source}`,
    resolve: (match, context) => resolveNumbered(match, context, 1),
  },
  {
    source: `(?:el\\s+|on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:de\\s+)?(${months})`,
    resolve: (match, context) => resolveNamed(match, 1, 2, context),
  },
  {
    source: `(?:el\\s+|on\\s+)?(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    resolve: (match, context) => resolveNamed(match, 2, 1, context),
  },
];

const repeatPrefix = `every|each|cada|todos\\s+los|todas\\s+las|los|las`;

const repeatRules: RepeatRule[] = [
  {
    source: `every\\s+day|todos\\s+los\\s+d[ií]as?|cada\\s+d[ií]a|daily|diario|diaria|diariamente`,
    resolve: () => ({ frequency: "daily" }),
  },
  {
    source: `every\\s+week|cada\\s+semana|weekly|semanal|semanalmente`,
    resolve: () => ({ frequency: "weekly" }),
  },
  {
    source: `every\\s+month|cada\\s+mes|monthly|mensual|mensualmente`,
    resolve: () => ({ frequency: "monthly" }),
  },
  {
    source: `(?:${repeatPrefix})\\s+(${weekdays})`,
    resolve: match => {
      const weekday = weekdayByName.get(match[1]!.toLowerCase());
      return weekday === undefined ? null : { frequency: "weekly", weekday };
    },
  },
];

/* ---------- dates ---------- */

/** A `dd/mm(/yyyy)` match: this year, or the next one when the day has passed.
 * `dayGroup` is 1 unless the pattern put an `el`/`on` prefix in front of it. */
function resolveNumbered(match: RegExpExecArray, context: Context, dayGroup = 1): string | null {
  const day = Number(match[dayGroup]);
  const month = Number(match[dayGroup + 1]);
  const yearText = match[dayGroup + 2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = yearText === undefined ? undefined : yearText.length <= 2 ? 2000 + Number(yearText) : Number(yearText);
  return resolveDay(day, month, year, context);
}

/** A day and a month name, in either order: `25 oct`, `25 de octubre`, `oct 25`. */
function resolveNamed(match: RegExpExecArray, dayGroup: number, monthGroup: number, context: Context): string | null {
  const day = Number(match[dayGroup]);
  const month = monthByName.get(match[monthGroup]!.toLowerCase());
  if (month === undefined || day < 1 || day > 31) return null;
  return resolveDay(day, month, undefined, context);
}

/**
 * The first day the planner can take: this year when it has not passed, the next
 * year otherwise. An explicit year is honoured as written, so a date in the past
 * is not a date -- it stays in the title instead of silently moving.
 */
function resolveDay(day: number, month: number, year: number | undefined, context: Context): string | null {
  if (year !== undefined) {
    const key = keyFor(year, month, day);
    return key !== null && key >= context.today ? key : null;
  }
  const thisYear = Number(context.today.slice(0, 4));
  for (const candidate of [thisYear, thisYear + 1]) {
    const key = keyFor(candidate, month, day);
    if (key !== null && key >= context.today) return key;
  }
  return null;
}

/* ---------- scanning ---------- */

const compiledDates = dateRules.map(rule => ({ rule, pattern: new RegExp(rule.source, "giu") }));
const compiledRepeats = repeatRules.map(rule => ({ rule, pattern: new RegExp(rule.source, "giu") }));

const wordChar = /[\p{L}\p{N}]/u;

/** True when the span stands on its own: no letter or digit touches either end. */
function bounded(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1]!;
  const after = end >= text.length ? "" : text[end]!;
  return !wordChar.test(before) && !wordChar.test(after);
}

/** The word in front of a span, used to keep a repeat's weekday out of the dates. */
function wordBefore(text: string, start: number): string {
  const head = text.slice(0, start).trimEnd();
  const match = /([\p{L}]+)$/u.exec(head);
  return match === null ? "" : match[1]!;
}

type Found = { part: QuickAddPart; order: number };

/** Every date and repeat the grammar recognizes in `text`, before overlaps. */
function scan(text: string, context: Context): Found[] {
  const found: Found[] = [];
  for (const { rule, pattern } of compiledDates) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!bounded(text, start, end)) continue;
      if (rule.guarded === true && repeatClaim.test(wordBefore(text, start))) continue;
      const date = rule.resolve(match, context);
      if (date === null) continue;
      found.push({ part: { kind: "date", text: match[0], start, end, date }, order: found.length });
    }
  }
  for (const { rule, pattern } of compiledRepeats) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!bounded(text, start, end)) continue;
      const resolved = rule.resolve(match);
      if (resolved === null) continue;
      found.push({
        part: {
          kind: "repeat",
          text: match[0],
          start,
          end,
          frequency: resolved.frequency,
          ...(resolved.weekday === undefined ? {} : { weekday: resolved.weekday }),
        },
        order: found.length,
      });
    }
  }
  return found;
}

/**
 * The accepted parts: earliest first, longest first at the same start, never two
 * of one kind and never overlapping. A longer match wins over a shorter one that
 * starts later inside it (`pasado mañana` over `mañana`, `25 mar` over `mar`).
 */
function accepted(found: Found[], ignore: readonly string[]): QuickAddPart[] {
  const skipped = new Set(ignore.map(entry => entry.toLowerCase()));
  const ordered = [...found].sort(
    (left, right) =>
      left.part.start - right.part.start ||
      (right.part.end - right.part.start) - (left.part.end - left.part.start) ||
      left.order - right.order,
  );
  const result: QuickAddPart[] = [];
  const kinds = new Set<QuickAddPartKind>();
  for (const { part } of ordered) {
    if (kinds.has(part.kind)) continue;
    if (skipped.has(part.text.toLowerCase())) continue;
    if (result.some(other => part.start < other.end && other.start < part.end)) continue;
    kinds.add(part.kind);
    result.push(part);
  }
  return result.sort((left, right) => left.start - right.start);
}

/** The text with `parts` cut out, whitespace and stray separators cleaned up. */
function cleanTitle(text: string, parts: QuickAddPart[]): string {
  let rest = "";
  let cursor = 0;
  for (const part of parts) {
    rest += text.slice(cursor, part.start);
    cursor = part.end;
  }
  rest += text.slice(cursor);
  return rest
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/^[\s,;.:!?·–—-]+/, "")
    .replace(/[\s,;.:!?·–—-]+$/, "");
}

/**
 * Parses one line of quick-add text. Never throws: text it does not understand
 * is a title, and the caller decides whether an empty title can be saved.
 */
export function parseQuickAdd(text: string, input: QuickAddInput): QuickAdd {
  const today = dayKeyIn(input.now, input.timeZone);
  const parts = accepted(scan(text, { today }), input.ignore ?? []);
  const datePart = parts.find((part): part is QuickAddDatePart => part.kind === "date");
  const repeatPart = parts.find((part): part is QuickAddRepeatPart => part.kind === "repeat");
  const anchorDate =
    repeatPart === undefined
      ? undefined
      : datePart?.date ??
        (repeatPart.weekday === undefined ? today : upcomingWeekday(today, repeatPart.weekday, false));
  return {
    title: cleanTitle(text, parts),
    parts,
    ...(datePart === undefined ? {} : { deadline: datePart.date }),
    ...(repeatPart === undefined ? {} : { frequency: repeatPart.frequency }),
    ...(anchorDate === undefined ? {} : { anchorDate }),
  };
}

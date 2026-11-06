/**
 * The capture inbox's on-device reader (Ronda 8, S3): what the sheet shows with
 * no API key, on the web build, offline, or when the assistant fails. No
 * network, no model, no writes. It splits lists, takes a mail's subject or the
 * first line as the title, reads dates with the quick add grammar
 * (`domain/quickAdd.ts`) and durations with `parseDuration` below, and turns a
 * lone link into host plus a readable slug. Proposals pass through the same
 * `normalizeProposal` as the model's, so both sources share one closed shape.
 *
 * It is a reader, not a judge: a short single line reads like quick add (the
 * date and duration leave the title); prose keeps its first sentence whole,
 * and a date or duration found elsewhere in the text only fills the fields.
 */

import { parseQuickAdd } from "../domain/quickAdd.ts";
import { dateKey } from "../ui/time.ts";
import { cleanCaptureText, MAX_CAPTURE_CHARS } from "./prompt.ts";
import {
  cleanLine,
  cutSafe,
  MAX_CAPTURE_QUOTE_CHARS,
  MAX_CAPTURE_TASKS,
  mergeDuplicates,
  normalizeProposal,
  type CaptureProposal,
  type RawProposal,
} from "./schema.ts";

/* ---------- durations ---------- */

export type ParsedDuration = {
  minutes: number;
  /** The span the duration occupied in the text. */
  start: number;
  end: number;
  text: string;
};

const L = "[\\p{L}\\p{N}]";
const NUMBER = "(\\d{1,4}(?:[.,]\\d{1,2})?)";
const HOUR_UNIT = "(?:h|hr|hrs|hours?|horas?)";
const MINUTE_UNIT = "(?:min|mins|minutes?|minutos?)";

type DurationPattern = { regex: RegExp; minutes: (match: RegExpExecArray) => number };

const decimal = (value: string) => Number(value.replace(",", "."));

const DURATION_PATTERNS: DurationPattern[] = [
  // 1h 30m, 1 hora y 30 min
  {
    regex: new RegExp(`(?<!${L})(\\d{1,2})\\s*${HOUR_UNIT}\\s*(?:(?:y|and)\\s*)?(\\d{1,2})\\s*(?:m|${MINUTE_UNIT})(?!${L})`, "giu"),
    minutes: match => (Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN),
  },
  // 1h30
  {
    regex: new RegExp(`(?<!${L})(\\d{1,2})h(\\d{2})(?!${L})`, "giu"),
    minutes: match => (Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN),
  },
  // 2h, 1,5 hours (not "16hs": that is a clock time)
  {
    regex: new RegExp(`(?<![\\p{L}\\p{N}.,])${NUMBER}\\s*${HOUR_UNIT}(?!${L})`, "giu"),
    minutes: match => Math.round(decimal(match[1]) * 60),
  },
  // 30m (attached), 30 min, 45 minutos (not "5 m", not "3 meses")
  {
    regex: new RegExp(`(?<![\\p{L}\\p{N}.,])${NUMBER}(?:\\s*${MINUTE_UNIT}|m)(?!${L})`, "giu"),
    minutes: match => Math.round(decimal(match[1])),
  },
  // una hora y media, an hour and a half
  {
    regex: /(?<![\p{L}])(?:(?:una\s+)?hora\s+y\s+media|(?:an?|one)\s+hour\s+and\s+a\s+half)(?![\p{L}])/giu,
    minutes: () => 90,
  },
  // una hora, an hour
  { regex: /(?<![\p{L}])(?:una\s+hora|(?:an?|one)\s+hour)(?![\p{L}])/giu, minutes: () => 60 },
  // media hora, half an hour
  { regex: /(?<![\p{L}])(?:media\s+hora|half\s+an\s+hour|half[\s-]hour)(?![\p{L}])/giu, minutes: () => 30 },
  // un cuarto de hora, a quarter of an hour
  { regex: /(?<![\p{L}])(?:un\s+cuarto\s+de\s+hora|(?:a\s+)?quarter\s+(?:of\s+an\s+)?hour)(?![\p{L}])/giu, minutes: () => 15 },
];

/** The longest estimate the capture inbox accepts (matches the schema's clamp). */
const MAX_PARSED_MINUTES = 480;

/**
 * The first duration written in `text` (`30m`, `1,5 h`, `1h30`, `media hora`,
 * `an hour and a half`), with the span it occupied; null when there is none.
 * Zero, anything over eight hours, and units that are not time (`3 meses`,
 * `16hs`) do not parse. Never throws.
 */
export function parseDuration(text: string): ParsedDuration | null {
  let best: ParsedDuration | null = null;
  for (const { regex, minutes } of DURATION_PATTERNS) {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0] === "") {
        regex.lastIndex += 1;
        continue;
      }
      const value = minutes(match);
      if (!Number.isFinite(value) || value < 1 || value > MAX_PARSED_MINUTES) continue;
      const found: ParsedDuration = { minutes: value, start: match.index, end: match.index + match[0].length, text: match[0] };
      if (best === null || found.start < best.start || (found.start === best.start && found.end > best.end)) best = found;
      break;
    }
  }
  return best;
}

/* ---------- dates ---------- */

const WEEKDAY =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|lun(?:es)?|mar(?:tes)?|mi[eé](?:rcoles)?|jue(?:ves)?|vie(?:rnes)?|s[aá]b(?:ado)?|dom(?:ingo)?)";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)";
const EXPLICIT_DATE = `(?:\\d{1,2}(?:st|nd|rd|th)?(?:\\s+de)?\\s+${MONTH}|\\d{1,2}[/.-]\\d{1,2}|${MONTH}\\p{L}*\\.?\\s+\\d{1,2})`;
// "Friday 14 Nov": the quick add grammar takes the earliest date, which would
// be the bare weekday. A weekday that precedes an explicit date is only
// decoration, so it is masked (same length) before parsing.
const MASK = new RegExp(`(?<!${L})(?:el\\s+)?${WEEKDAY}(?!${L})[,.]?\\s+(?=${EXPLICIT_DATE})`, "giu");

type DateRead = { day: string; start: number; end: number };

function readDate(line: string, ctx: ReaderContext): DateRead | null {
  const masks: Array<{ start: number; end: number }> = [];
  const masked = line.replace(MASK, (matched, offset: number) => {
    masks.push({ start: offset, end: offset + matched.length });
    return " ".repeat(matched.length);
  });
  // "antes del 14 de noviembre": the grammar does not read a day glued to "del",
  // so it sees "de" (same length) there.
  const readable = masked.replace(/(?<!\p{L})del(?=\s+\d)/giu, "de ");
  const part = parseQuickAdd(readable, { now: ctx.now, timeZone: ctx.timeZone }).parts.find(entry => entry.kind === "date");
  if (part === undefined || part.kind !== "date") return null;
  const before = masks.find(mask => mask.end <= part.start && line.slice(mask.end, part.start).trim() === "");
  return { day: part.date, start: before?.start ?? part.start, end: part.end };
}

/* ---------- reading ---------- */

export type ReaderContext = { now: Date; timeZone: string };

export type DeviceReading = {
  tasks: CaptureProposal[];
  /** The paste was longer than the cap and was cut. */
  truncated: boolean;
  /** More than `MAX_CAPTURE_TASKS` items were found; the rest were cut. */
  capped: boolean;
};

/** Longest line the scanners look at, and most lines they visit. */
const SCAN_LINE_CHARS = 600;
const SCAN_LINES = 200;
/** A title source this short, with no sentence end, is read like quick add. */
const QUICK_LINE_CHARS = 80;

const LIST_LINE = /^\s*(?:[-*•‣▪·–—]|\d{1,3}[.)])\s+(?:\[([ xX]?)\]\s*)?(.*)$/u;
const CHECKBOX_LINE = /^\s*\[([ xX]?)\]\s+(.*)$/u;
const SUBJECT_LINE = /^\s*(?:subject|asunto)\s*:\s*(.*)$/i;
const HEADER_LINE = /^\s*(?:from|to|cc|bcc|date|sent|reply-to|de|para|enviado|fecha)\s*:/i;
/** A subject only counts as a mail header when it is near the top. */
const HEADER_LINES = 12;
const SUBJECT_PREFIX = /^\s*(?:re|fwd?|rv|fw|rif)\s*:\s*/i;
const GREETING =
  /^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|hola|buenas|buen\s+d[ií]a|buenos\s+d[ií]as|buenas\s+(?:tardes|noches)|estimad[oa]s?|querid[oa]s?)\b[^.!?]{0,40}[,:!]?$/iu;
const SENTENCE_END = /[.!?](?:\s|$)/u;
const HAS_CONTENT = /[\p{L}\p{N}]/u;
const LONE_URL = /^https?:\/\/\S+$/i;

type Item = { text: string; checked: boolean };

function listItems(lines: string[]): Item[] | null {
  const items: Item[] = [];
  for (const line of lines) {
    const bullet = LIST_LINE.exec(line);
    if (bullet !== null) {
      items.push({ text: cleanLine(bullet[2]), checked: bullet[1] === "x" || bullet[1] === "X" });
      continue;
    }
    const box = CHECKBOX_LINE.exec(line);
    if (box !== null) items.push({ text: cleanLine(box[2]), checked: box[1] === "x" || box[1] === "X" });
  }
  return items.length >= 2 ? items : null;
}

/** Host plus a readable slug; query, fragment and credentials are never used. */
function urlTitle(link: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./i, "");
  if (host === "") return null;
  const last = parsed.pathname.split("/").filter(segment => segment !== "").pop();
  let slug = "";
  if (last !== undefined) {
    try {
      slug = cleanLine(decodeURIComponent(last).replace(/\.(?:html?|php|aspx?|pdf|md)$/i, "").replace(/[-_+]+/g, " "));
    } catch {
      slug = "";
    }
  }
  return /\p{L}/u.test(slug) && slug.length >= 3 ? `${host} — ${slug}` : host;
}

/** A title tidied after pieces were cut out of it. */
function tidy(value: string): string {
  return cleanLine(value)
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/^[\s,;:.!?·–—-]+/u, "")
    .replace(/[\s,;:.!?·–—-]+$/u, "");
}

/** The date and duration of one line, plus the spans to cut in quick mode. */
function readLine(line: string, ctx: ReaderContext, todayKey: string): { day: string | null; minutes: number | null; cuts: Array<[number, number]> } {
  const date = readDate(line, ctx);
  const duration = parseDuration(line);
  const cuts: Array<[number, number]> = [];
  // A past date is flagged by the schema and its text stays in the title.
  if (date !== null && date.day >= todayKey) cuts.push([date.start, date.end]);
  if (duration !== null) cuts.push([duration.start, duration.end]);
  return { day: date?.day ?? null, minutes: duration?.minutes ?? null, cuts };
}

function cutSpans(line: string, cuts: Array<[number, number]>): string {
  let rest = line;
  for (const [start, end] of [...cuts].sort((left, right) => right[0] - left[0])) {
    if (end <= rest.length) rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
  }
  return tidy(rest);
}

/** One proposal for a list item or a quick-add-like line: spans leave the title. */
function quickProposal(text: string, ctx: ReaderContext, todayKey: string): RawProposal {
  const line = cutSafe(text, SCAN_LINE_CHARS);
  const read = readLine(line, ctx, todayKey);
  const cut = cutSpans(line, read.cuts);
  return { title: cut === "" ? text : cut, dueDay: read.day, estimateMinutes: read.minutes, quote: cutSafe(text, MAX_CAPTURE_QUOTE_CHARS) };
}

function firstSentence(line: string): string {
  const match = /^.*?[.!?](?=\s|$)/u.exec(line);
  return match === null ? line : match[0];
}

/** One task for a mail or a paragraph: subject or first useful line as title. */
function singleProposal(lines: string[], ctx: ReaderContext, todayKey: string): RawProposal | null {
  const subjectIndex = lines.slice(0, HEADER_LINES).findIndex(line => SUBJECT_LINE.test(line));
  const subjectLine = subjectIndex === -1 ? null : SUBJECT_LINE.exec(lines[subjectIndex]);
  // After the subject, any further header lines (Date:, To:) are not content.
  let bodyStart = subjectIndex + 1;
  while (subjectIndex !== -1 && bodyStart < lines.length && HEADER_LINE.test(lines[bodyStart])) bodyStart += 1;
  const body = subjectIndex === -1 ? lines : lines.slice(bodyStart);

  let titleSource: string | null = null;
  let titleLine: string | null = null;
  if (subjectLine !== null) {
    let subject = cleanLine(subjectLine[1]);
    while (SUBJECT_PREFIX.test(subject)) subject = subject.replace(SUBJECT_PREFIX, "");
    if (HAS_CONTENT.test(subject)) {
      titleSource = subject;
      titleLine = subject;
    }
  }
  if (titleSource === null) {
    for (const line of body.slice(0, SCAN_LINES)) {
      const text = cleanLine(line);
      if (!HAS_CONTENT.test(text) || GREETING.test(text)) continue;
      titleLine = text;
      titleSource = firstSentence(cutSafe(text, SCAN_LINE_CHARS));
      break;
    }
  }
  if (titleSource === null || titleLine === null) return null;

  // A short title line with no sentence end reads like quick add: its date and
  // duration leave the title. Prose keeps its title whole.
  const quick = titleSource.length <= QUICK_LINE_CHARS && !SENTENCE_END.test(titleLine);
  const own = readLine(cutSafe(quick ? titleLine : titleSource, SCAN_LINE_CHARS), ctx, todayKey);
  let title = titleSource;
  if (quick) {
    const cut = cutSpans(cutSafe(titleLine, SCAN_LINE_CHARS), own.cuts);
    if (cut !== "") title = cut;
  }

  // Fields the title line did not name come from the first body line that does.
  let day = own.day;
  let minutes = own.minutes;
  let dayLine = day === null ? null : titleLine;
  let minutesLine = minutes === null ? null : titleLine;
  for (const line of body.slice(0, SCAN_LINES)) {
    if (day !== null && minutes !== null) break;
    const text = cleanLine(line);
    if (!HAS_CONTENT.test(text)) continue;
    const read = readLine(cutSafe(text, SCAN_LINE_CHARS), ctx, todayKey);
    if (day === null && read.day !== null) {
      day = read.day;
      dayLine = text;
    }
    if (minutes === null && read.minutes !== null) {
      minutes = read.minutes;
      minutesLine = text;
    }
  }
  const quote = dayLine ?? minutesLine ?? titleLine;
  return { title, dueDay: day, estimateMinutes: minutes, quote: cutSafe(quote, MAX_CAPTURE_QUOTE_CHARS) };
}

/**
 * Reads pasted text on the device. Never throws; empty or content-free input
 * yields no tasks. At most `MAX_CAPTURE_TASKS` come back, duplicates merged.
 */
export function readOnDevice(raw: string, ctx: ReaderContext): DeviceReading {
  const none: DeviceReading = { tasks: [], truncated: false, capped: false };
  try {
    const cleaned = cleanCaptureText(raw);
    const truncated = cleaned.length > MAX_CAPTURE_CHARS;
    const text = truncated ? cutSafe(cleaned, MAX_CAPTURE_CHARS) : cleaned;
    const todayKey = dateKey(ctx.now, ctx.timeZone);
    const context = { text, todayKey };
    const lines = text.split("\n");
    const filled = lines.filter(line => line.trim() !== "");
    if (filled.length === 0) return { ...none, truncated };

    const proposals: Array<RawProposal | null> = [];
    const items = listItems(lines.slice(0, SCAN_LINES * 4));
    if (items !== null) {
      for (const item of items) {
        if (!item.checked && HAS_CONTENT.test(item.text)) proposals.push(quickProposal(item.text, ctx, todayKey));
      }
    } else if (filled.every(line => LONE_URL.test(line.trim()))) {
      for (const line of filled.slice(0, MAX_CAPTURE_TASKS + 1)) {
        const link = line.trim();
        const title = urlTitle(link);
        proposals.push(title === null ? null : { title, quote: cutSafe(link, MAX_CAPTURE_QUOTE_CHARS) });
      }
    } else {
      proposals.push(singleProposal(lines, ctx, todayKey));
    }

    const valid: CaptureProposal[] = [];
    for (const proposal of proposals) {
      const entry = proposal === null ? null : normalizeProposal(proposal, context);
      if (entry !== null) valid.push(entry);
    }
    const unique = mergeDuplicates(valid);
    return { tasks: unique.slice(0, MAX_CAPTURE_TASKS), truncated, capped: unique.length > MAX_CAPTURE_TASKS };
  } catch {
    return none;
  }
}

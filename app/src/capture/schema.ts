/**
 * The capture inbox's reply schema and its total validator.
 *
 * The model's reply is untrusted text, so everything it says passes through
 * `parseCaptureReply` before a card exists. The validator never throws and
 * never writes: a malformed item is dropped alone (the batch survives), unknown
 * keys are ignored (the proposal type is closed, so an injected
 * `"op":"delete_all"` has nowhere to land), and each surviving item also passes
 * `checkCreateTask`, so a captured task obeys exactly the rules a chat-created
 * one does. The on-device reader builds its proposals through the same
 * `normalizeProposal`, so both sources produce the same closed shape.
 *
 * Reply shape the prompt asks for (`prompt.ts`):
 * `{"tasks":[{"title","dueDay","startTime","estimateMinutes","quote"}]}`.
 */

import { extractJson } from "../chat/memoryExtract.ts";
import { checkCreateTask, isValidDayKey } from "../chat/tools.ts";

export const MAX_CAPTURE_TASKS = 8;
/** Items of a reply that are inspected at all. */
const MAX_REPLY_ITEMS = 64;
export const MAX_CAPTURE_TITLE_CHARS = 120;
export const MAX_CAPTURE_QUOTE_CHARS = 160;
export const MIN_CAPTURE_ESTIMATE = 5;
export const MAX_CAPTURE_ESTIMATE = 480;

/** A quote shorter than this proves nothing about where an item came from. */
const MIN_QUOTE_CHARS = 4;

/** One card's worth of proposal: the closed shape every source produces. */
export type CaptureProposal = {
  title: string;
  /** `YYYY-MM-DD` in the planner's zone, never before today. */
  dueDay: string | null;
  /** Minutes since midnight; only ever set together with `dueDay`. */
  startMinutes: number | null;
  /** Whole minutes, a multiple of 5 in 5-480. */
  estimateMinutes: number | null;
  /** A verbatim span of the pasted text, for the card's source line. */
  quote: string | null;
  /** The source named a day the planner cannot use (past or malformed). */
  dateIgnored: boolean;
};

/** What a source claims before validation; any field may be junk. */
export type RawProposal = {
  title?: unknown;
  dueDay?: unknown;
  startTime?: unknown;
  estimateMinutes?: unknown;
  quote?: unknown;
};

export type CaptureContext = {
  /** The text the source read (the capped text that was actually sent). */
  text: string;
  /** The planner's today as `YYYY-MM-DD`. */
  todayKey: string;
};

export type CaptureReply = {
  /** `empty`: the model found nothing. `unparseable`: no usable item at all
   * (junk, wrong shape, or every item invalid); the caller falls back to the
   * on-device reading. */
  status: "ok" | "empty" | "unparseable";
  tasks: CaptureProposal[];
  /** Items that failed validation and were dropped. */
  dropped: number;
  /** More than `MAX_CAPTURE_TASKS` valid items arrived; the rest were cut. */
  capped: boolean;
};

/* ---------- text hygiene ---------- */

/** C0/C1 controls, bidi overrides and isolates, zero-width marks, BOM, soft
 * hyphen, fillers, variation selectors and Unicode tag characters. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\u00ad\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** One line of plain text: controls gone, whitespace collapsed, trimmed. */
export function cleanLine(value: string): string {
  return value
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `value` cut to `max` UTF-16 units without splitting a surrogate pair. */
export function cutSafe(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** A title of at most `MAX_CAPTURE_TITLE_CHARS`, ending in an ellipsis when cut. */
export function fitTitle(value: string): string {
  if (value.length <= MAX_CAPTURE_TITLE_CHARS) return value;
  return `${cutSafe(value, MAX_CAPTURE_TITLE_CHARS - 1).trimEnd()}…`;
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

/** A quote that is verifiably part of the text, or null. Models like to wrap
 * quotes in ellipses, which are not part of the source. */
function verifiedQuote(value: unknown, text: string): string | null {
  if (typeof value !== "string") return null;
  const quote = cutSafe(cleanLine(value).replace(/^(?:…|\.{3})\s*/, "").replace(/\s*(?:…|\.{3})$/, ""), MAX_CAPTURE_QUOTE_CHARS);
  if (quote.length < MIN_QUOTE_CHARS) return null;
  return collapse(text).includes(collapse(quote)) ? quote : null;
}

/* ---------- field rules ---------- */

/** Rounds a model's estimate to 5 and clamps to 5-480; anything else is null. */
export function normalizeEstimate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value / 5) * 5;
  return Math.min(MAX_CAPTURE_ESTIMATE, Math.max(MIN_CAPTURE_ESTIMATE, rounded));
}

const TIME_SHAPE = /^\d{2}:\d{2}$/;

/**
 * Turns one claimed item into a proposal, or null when it is unusable. The
 * lenient parts (dates, times, quotes) degrade to null so the task survives;
 * the title is the one thing an item cannot do without.
 */
export function normalizeProposal(raw: RawProposal, context: CaptureContext): CaptureProposal | null {
  if (typeof raw.title !== "string") return null;
  const title = fitTitle(cleanLine(raw.title));
  if (title === "") return null;

  let dueDay: string | null = null;
  let dateIgnored = false;
  if (typeof raw.dueDay === "string" && raw.dueDay.trim() !== "") {
    const day = raw.dueDay.trim();
    if (isValidDayKey(day) && day >= context.todayKey) dueDay = day;
    else dateIgnored = true;
  }
  const estimateMinutes = normalizeEstimate(raw.estimateMinutes);
  const startTime = dueDay !== null && typeof raw.startTime === "string" && TIME_SHAPE.test(raw.startTime.trim()) ? raw.startTime.trim() : null;

  // The chat's own create rules have the last word (time of day, midnight
  // room). A start time that breaks them is dropped, not the whole task.
  const args = (withTime: boolean) =>
    JSON.stringify({
      title,
      ...(dueDay === null ? {} : { day: dueDay }),
      ...(withTime && startTime !== null ? { startTime } : {}),
      ...(estimateMinutes === null ? {} : { estimateMinutes }),
    });
  let checked = checkCreateTask(args(true), context.todayKey);
  if (!checked.ok && startTime !== null) checked = checkCreateTask(args(false), context.todayKey);
  if (!checked.ok) return null;

  return {
    title: checked.value.title,
    dueDay: checked.value.day ?? null,
    startMinutes: checked.value.startMinutes ?? null,
    estimateMinutes: checked.value.estimateMinutes ?? null,
    quote: verifiedQuote(raw.quote, context.text),
    dateIgnored,
  };
}

const sameTask = (left: CaptureProposal, right: CaptureProposal) =>
  collapse(left.title) === collapse(right.title) && left.dueDay === right.dueDay;

/** Merges proposals with the same title and day into the first, which keeps
 * what it has and takes what only a later one knew. Order is preserved. */
export function mergeDuplicates(list: readonly CaptureProposal[]): CaptureProposal[] {
  const merged: CaptureProposal[] = [];
  for (const entry of list) {
    const first = merged.find(candidate => sameTask(candidate, entry));
    if (first === undefined) {
      merged.push({ ...entry });
      continue;
    }
    first.startMinutes ??= entry.startMinutes;
    first.estimateMinutes ??= entry.estimateMinutes;
    first.quote ??= entry.quote;
    first.dateIgnored = first.dateIgnored || entry.dateIgnored;
  }
  return merged;
}

/* ---------- the reply ---------- */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const unparseable = (dropped = 0): CaptureReply => ({ status: "unparseable", tasks: [], dropped, capped: false });

/**
 * Validates the model's reply. Total: any input, however hostile, returns a
 * `CaptureReply`; nothing here throws, writes or follows an instruction.
 */
export function parseCaptureReply(raw: unknown, context: CaptureContext): CaptureReply {
  try {
    if (typeof raw !== "string") return unparseable();
    const json = extractJson(raw);
    if (json === null) return unparseable();
    const parsed: unknown = JSON.parse(json);
    const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.tasks : undefined;
    if (!Array.isArray(list)) return unparseable();
    const valid: CaptureProposal[] = [];
    let dropped = 0;
    // Bound the work on a hostile reply: the sheet shows at most 8.
    const items = list.slice(0, MAX_REPLY_ITEMS);
    for (const item of items) {
      const entry = isRecord(item) && !Array.isArray(item) ? normalizeProposal(item, context) : null;
      if (entry === null) dropped += 1;
      else valid.push(entry);
    }
    if (items.length === 0) return { status: "empty", tasks: [], dropped: 0, capped: false };
    if (valid.length === 0) return unparseable(dropped);
    const unique = mergeDuplicates(valid);
    return { status: "ok", tasks: unique.slice(0, MAX_CAPTURE_TASKS), dropped, capped: unique.length > MAX_CAPTURE_TASKS };
  } catch {
    return unparseable();
  }
}

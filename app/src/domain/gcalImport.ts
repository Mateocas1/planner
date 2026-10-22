import { classifyHoliday, isHolidayCalendar, type Holiday } from "./holidays.ts";
import { toZonedInstant } from "./instant.ts";
import { createTask, createWorkBlock, type BlockSource, type Task, type WorkBlock } from "./model.ts";

/**
 * The pure half of "Import from Google Calendar": Google's `events.list` items
 * (fetched with `singleEvents=true`) in, an `ImportPlan` out. Nothing here
 * touches the network, Firestore or the DOM, so the whole mapping -- offsets,
 * zones, dedupe and the deterministic document ids -- is testable and the
 * write in data/gcal.ts only has to apply the plan.
 *
 * Owner decisions encoded here: a timed event becomes a work block, an all-day
 * event becomes a task dated from its first day, and a meeting never becomes a
 * task (a meeting is timed, so it is a block). An event of a Google holiday
 * calendar is neither: it becomes a day label (see domain/holidays.ts).
 */

/** The `start`/`end` shape of a Calendar API event. */
export type GcalEventTime = { date?: string; dateTime?: string; timeZone?: string };

/** The attendee fields the mapper reads (only the viewer's own answer matters). */
export type GcalAttendee = { self?: boolean; responseStatus?: string };

/**
 * The subset of a Calendar API event the import reads. Every field is optional
 * because the input is untrusted JSON off the wire: the mapper decides what is
 * usable and counts the rest instead of throwing.
 */
export type GcalEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  updated?: string;
  eventType?: string;
  recurringEventId?: string;
  start?: GcalEventTime;
  end?: GcalEventTime;
  attendees?: GcalAttendee[];
};

/** Why an event produced no block and no task. */
export type ImportSkipReason =
  | "cancelled"
  | "declined"
  | "workingLocation"
  | "outOfOffice"
  | "focusTime"
  | "imported"
  | "unusable";

export type ImportSkips = Record<ImportSkipReason, number>;

/** What the planner already holds, so a second import writes nothing twice. */
export type ExistingImportData = {
  /** Document ids of the stored blocks. */
  blockIds?: Iterable<string>;
  /** Document ids of the stored tasks. */
  taskIds?: Iterable<string>;
  /** `source.eventId` of the stored imported blocks. */
  eventIds?: Iterable<string>;
  /** Document ids of the stored holidays. */
  holidayIds?: Iterable<string>;
};

export type ImportPlanInput = {
  /** The Google calendar the events came from (`primary` for the main one). */
  calendarId: string;
  events: GcalEvent[];
  /** The profile's IANA zone: the fallback for a `dateTime` without an offset. */
  timeZone: string;
  existing?: ExistingImportData;
};

export type ImportPlan = {
  calendarId: string;
  /** Blocks to write, each with a deterministic document id. */
  blocks: WorkBlock[];
  /** Tasks to write, each with a deterministic document id. */
  tasks: Task[];
  /** Holiday labels to write, each with a deterministic document id. */
  holidays: Holiday[];
  skipped: ImportSkips;
};

/** Every imported document id starts with this prefix. */
export const GCAL_ID_PREFIX = "gcal_";

const wallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const offsetInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Google's own event id alphabet; anything else cannot become a document id. */
const safeEventId = /^[A-Za-z0-9._-]{1,200}$/;

/** A real calendar date in `YYYY-MM-DD` form. */
function validDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function emptySkips(): ImportSkips {
  return { cancelled: 0, declined: 0, workingLocation: 0, outOfOffice: 0, focusTime: 0, imported: 0, unusable: 0 };
}

/** FNV-1a as base 36: short, stable, and the same in every runtime. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A short, safe key for a calendar id. The readable slug alone can collide
 * once it is truncated (`me@a.com` and `me@b.com` both slug to `me-a-com`), so
 * a digest of the full id follows it; the result only ever holds `[a-z0-9-]`,
 * which is what makes it usable inside a document id.
 */
export function calendarKey(calendarId: string): string {
  const slug = calendarId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return `${slug === "" ? "cal" : slug}-${digest(calendarId)}`;
}

/** The deterministic document id a calendar event imports as. */
export function importDocId(calendarId: string, eventId: string): string {
  return `${GCAL_ID_PREFIX}${calendarKey(calendarId)}_${eventId}`;
}

/** A JSON value that can be read as an object; everything else cannot be an event. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A declined invitation: the viewer's own attendee entry says `declined`. */
function declinedBySelf(event: GcalEvent): boolean {
  return Array.isArray(event.attendees)
    && event.attendees.some(attendee => isRecord(attendee) && attendee.self === true && attendee.responseStatus === "declined");
}

/** The event's only, or first, day; an all-day event carries `date`, not `dateTime`. */
function isAllDay(event: GcalEvent): boolean {
  const start = event.start;
  return isRecord(start) && typeof start.date === "string" && start.dateTime === undefined;
}

/**
 * The zoned ISO instant an event edge denotes. A stamp that already carries an
 * offset is kept exactly as Google sent it; a bare wall clock is interpreted in
 * the event's own zone, falling back to the profile zone -- the same helper the
 * planner uses when it turns a grid slot into a block, so a DST day behaves the
 * same in both paths. Returns null for an edge the mapper cannot place.
 */
function instantOf(time: GcalEventTime | null | undefined, fallbackTimeZone: string): string | null {
  // `== null` on purpose: an absent edge and a JSON `null` edge are the same
  // thing to the mapper, and a non-object edge cannot carry a stamp at all.
  if (time == null || typeof time !== "object") return null;
  const value = typeof time.dateTime === "string" ? time.dateTime.trim() : "";
  if (offsetInstant.test(value)) return value;
  if (!wallClock.test(value)) return null;
  const zone = typeof time.timeZone === "string" && time.timeZone !== "" ? time.timeZone : fallbackTimeZone;
  try {
    return toZonedInstant(value.slice(0, 16), zone);
  } catch {
    return null;
  }
}

/**
 * Maps one page (or every page) of Google events to the blocks and tasks to
 * create. Already-imported events are skipped by document id and by event id,
 * so re-importing the same window is a no-op -- with the deterministic ids the
 * write path is idempotent even if two imports race.
 */
export function planImport(input: ImportPlanInput): ImportPlan {
  const skipped = emptySkips();
  const blocks: WorkBlock[] = [];
  const tasks: Task[] = [];
  const holidays: Holiday[] = [];
  const holidayCalendar = isHolidayCalendar(input.calendarId);
  const existingHolidayIds = new Set(input.existing?.holidayIds ?? []);
  const existingBlockIds = new Set(input.existing?.blockIds ?? []);
  const existingTaskIds = new Set(input.existing?.taskIds ?? []);
  const existingEventIds = new Set(input.existing?.eventIds ?? []);
  // Two copies of one event in one response must not produce two writes.
  const planned = new Set<string>();

  // Untrusted JSON: a body whose `items` is not a list holds no events, and an
  // item that is not an object is counted, never thrown on. `data/google-client.ts`
  // refuses a page that is not a list page before it reaches this point.
  const events: unknown[] = Array.isArray(input.events) ? input.events : [];

  for (const item of events) {
    if (!isRecord(item)) {
      skipped.unusable += 1;
      continue;
    }
    const event = item as GcalEvent;
    // A status that is present but not text leaves the event's fate unknown, so
    // it is not imported on a guess; a missing status reads as a live event.
    const status = event.status;
    if (status !== undefined && typeof status !== "string") {
      skipped.unusable += 1;
      continue;
    }
    if (status === "cancelled") {
      skipped.cancelled += 1;
      continue;
    }
    if (declinedBySelf(event)) {
      skipped.declined += 1;
      continue;
    }
    const eventType = event.eventType;
    if (eventType === "workingLocation" || eventType === "outOfOffice" || eventType === "focusTime") {
      skipped[eventType] += 1;
      continue;
    }
    const eventId = typeof event.id === "string" ? event.id : "";
    if (!safeEventId.test(eventId)) {
      skipped.unusable += 1;
      continue;
    }
    const id = importDocId(input.calendarId, eventId);
    // A holiday calendar's event is a day label: never a task or a block, even
    // when an earlier import stored it as a task (the cleanup handles those).
    if (holidayCalendar) {
      const date = isAllDay(event) ? (event.start?.date ?? "") : "";
      const title = typeof event.summary === "string" ? event.summary.trim() : "";
      if (existingHolidayIds.has(id) || planned.has(id)) {
        skipped.imported += 1;
      } else if (title === "" || !validDateKey(date)) {
        skipped.unusable += 1;
      } else {
        holidays.push({
          id,
          date,
          title,
          kind: classifyHoliday({ description: event.description, summary: title }),
          source: { provider: "gcal", calendarId: input.calendarId, eventId },
        });
        planned.add(id);
      }
      continue;
    }
    if (existingBlockIds.has(id) || existingTaskIds.has(id) || existingEventIds.has(eventId) || planned.has(id)) {
      skipped.imported += 1;
      continue;
    }
    const title = typeof event.summary === "string" ? event.summary.trim() : "";
    if (isAllDay(event)) {
      const date = event.start?.date ?? "";
      try {
        tasks.push(createTask(id, title, date));
        planned.add(id);
      } catch {
        // No summary, or a date Google did not send: a task needs both.
        skipped.unusable += 1;
      }
      continue;
    }
    const start = instantOf(event.start, input.timeZone);
    const end = instantOf(event.end, input.timeZone);
    const updated = typeof event.updated === "string" ? event.updated : "";
    if (start === null || end === null || updated === "") {
      skipped.unusable += 1;
      continue;
    }
    const source: BlockSource = {
      provider: "gcal",
      calendarId: input.calendarId,
      eventId,
      updated,
      ...(typeof event.recurringEventId === "string" && event.recurringEventId !== ""
        ? { recurringEventId: event.recurringEventId }
        : {}),
    };
    try {
      blocks.push(createWorkBlock(id, start, end, undefined, { ...(title === "" ? {} : { title }), source }));
      planned.add(id);
    } catch {
      // A rejected pair of instants (an end not after its start) is not imported.
      skipped.unusable += 1;
    }
  }

  return { calendarId: input.calendarId, blocks, tasks, holidays, skipped };
}

/** The smallest shape `importedIds` needs from a stored block. */
export type ImportedBlockRef = { id: string; source?: { provider: string } };

/**
 * The documents "Remove imported events" deletes: blocks that say where they
 * came from, and tasks whose id carries the import prefix. Tasks have no
 * `source` field -- their schema is closed -- so their deterministic id is the
 * record of where they came from, and nothing else in the app mints that
 * prefix (Firestore assigns every user-created task a random id).
 */
export function importedIds(blocks: Iterable<ImportedBlockRef>, tasks: Iterable<{ id: string }>): { blockIds: string[]; taskIds: string[] } {
  const blockIds = [...blocks].filter(block => block.source?.provider === "gcal").map(block => block.id);
  const taskIds = [...tasks].filter(task => task.id.startsWith(GCAL_ID_PREFIX)).map(task => task.id);
  return { blockIds, taskIds };
}

/**
 * The stored tasks an earlier import made out of a Google holiday calendar's
 * events. A task has no `source` field (its schema is closed), so the proof is
 * its deterministic id: `gcal_<calendarKey>_<eventId>`, where the key carries a
 * digest of the full calendar id. A task is selected only when its id starts
 * with the key of a holiday calendar the account actually lists. Never the
 * title or the date: a user's "Christmas" task and a normal calendar's all-day
 * event are not holiday tasks, and ids Firestore mints for user tasks never
 * start with `gcal_`.
 *
 * `calendars` is the account's whole calendar list. A holiday calendar whose
 * key a non-holiday calendar shares (a 32-bit digest collision plus an equal
 * 24-character slug, in practice never) is left out, so a shared key can never
 * delete the tasks of a normal calendar.
 */
export function selectHolidayTasks<T extends { id: string }>(tasks: Iterable<T>, calendars: Iterable<{ id: string }>): T[] {
  const holidayKeys = new Set<string>();
  const otherKeys = new Set<string>();
  for (const calendar of calendars) {
    (isHolidayCalendar(calendar.id) ? holidayKeys : otherKeys).add(calendarKey(calendar.id));
  }
  const prefixes = [...holidayKeys].filter(key => !otherKeys.has(key)).map(key => `${GCAL_ID_PREFIX}${key}_`);
  if (prefixes.length === 0) return [];
  return [...tasks].filter(task => prefixes.some(prefix => task.id.startsWith(prefix)));
}

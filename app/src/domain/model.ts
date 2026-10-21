export type Task = { id: string; title: string; deadline?: string; estimate?: number };

/**
 * How long a task is expected to take, in whole minutes. An estimate is a
 * plan, not a record: an absent one is not zero, it is an unstated guess, and
 * every surface that shows an estimate says which of the two it is showing
 * (see ASSUMED_ESTIMATE_MINUTES).
 */
export const MIN_ESTIMATE_MINUTES = 5;
export const MAX_ESTIMATE_MINUTES = 1440;

/** The number planning assumes for a task that carries no estimate. */
export const ASSUMED_ESTIMATE_MINUTES = 60;

/**
 * Where an imported block came from. A block that was not imported carries no
 * source at all, so every stored block written before imports existed still
 * reads as it did.
 */
export type BlockSource = {
  provider: "gcal";
  calendarId: string;
  eventId: string;
  updated: string;
  recurringEventId?: string;
};

/** The optional fields an imported block adds to the plain start/end pair. */
export type BlockExtras = { title?: string; source?: BlockSource };

export type WorkBlock = {
  id: string;
  start: string;
  end: string;
  taskId?: string;
  title?: string;
  source?: BlockSource;
};
export type Recurrence = {
  seriesId: string;
  frequency: "daily" | "weekly" | "monthly";
  anchorDate: string;
};
export type Occurrence = { id: string; date: string };
export type OccurrenceCompletion = { occurrenceId: string; completedAt: string };

export const MAX_OCCURRENCE_WINDOW_DAYS = 366;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const zonedInstant = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const day = 86_400_000;

function validDate(date: string): boolean {
  if (!dateOnly.test(date)) return false;
  const value = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date;
}

function requireDate(date: string): void {
  if (!validDate(date)) throw new Error("expected a valid ISO date-only value");
}

/**
 * Validates a zoned ISO instant. Exported because a task's completion instant
 * is written by the data layer and restored by undo, and both write the exact
 * value they were given: a malformed one must fail before any document changes.
 */
export function requireInstant(instant: string): void {
  const match = zonedInstant.exec(instant);
  if (!match) throw new Error("expected a zoned ISO instant");
  const [, date, hours, minutes, seconds, , zone] = match;
  requireDate(date);
  if (+hours > 23 || +minutes > 59 || +seconds > 59 ||
      (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) ||
      !Number.isFinite(Date.parse(instant))) {
    throw new Error("expected a valid zoned ISO instant");
  }
}

/**
 * Validates an estimate and returns it. The rule is one rule, shared by every
 * write that sets an estimate (create, edit, series): whole minutes, 5 to 1440.
 * A fractional, negative, non-numeric or out-of-range value is rejected rather
 * than rounded, because a rounded estimate is a number nobody wrote.
 */
export function requireEstimate(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < MIN_ESTIMATE_MINUTES || minutes > MAX_ESTIMATE_MINUTES) {
    throw new Error(`estimate must be a whole number of minutes between ${MIN_ESTIMATE_MINUTES} and ${MAX_ESTIMATE_MINUTES}`);
  }
  return minutes;
}

/**
 * Reads a stored estimate out of a document. A task or series written before
 * estimates existed has none, and a hand-edited document may hold anything; in
 * both cases the value reads as absent rather than crashing the surface.
 */
export function parseEstimate(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  try {
    return requireEstimate(value);
  } catch {
    return undefined;
  }
}

/** An estimate in the words a person uses: "45 min", "1h", "1h 30m". */
export function formatEstimate(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The words a surface uses for an estimate: the value itself, or the
 * 60-minute assumption when the task carries none. One function, so every
 * surface that shows an estimate (details, create sheet, the radar and the
 * bias hint that follow) says the same thing about the same absence.
 */
export function estimateNote(estimate: number | undefined): string {
  return estimate === undefined ? `Assumed ${formatEstimate(ASSUMED_ESTIMATE_MINUTES)}` : formatEstimate(estimate);
}

export function createTask(id: string, title: string, deadline?: string, estimate?: number): Task {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("task title is required");
  if (deadline !== undefined) requireDate(deadline);
  return {
    id,
    title: trimmed,
    ...(deadline === undefined ? {} : { deadline }),
    ...(estimate === undefined ? {} : { estimate: requireEstimate(estimate) }),
  };
}

/**
 * Validates the import source of a block. The provider is a closed one-value
 * union today, and the identifiers must be non-empty and free of the path
 * separator, because they end up in document ids.
 */
function requireBlockSource(source: BlockSource): BlockSource {
  const valid = source !== null && typeof source === "object"
    && source.provider === "gcal"
    && typeof source.calendarId === "string" && source.calendarId !== ""
    && typeof source.eventId === "string" && source.eventId !== "" && !source.eventId.includes("/")
    && (source.recurringEventId === undefined || (typeof source.recurringEventId === "string" && source.recurringEventId !== ""));
  if (!valid) throw new Error("block source is invalid");
  // `updated` is Google's own RFC 3339 stamp; the zoned-instant check is what
  // makes it comparable later, so a stamp without an offset is rejected.
  try {
    requireInstant(source.updated);
  } catch {
    throw new Error("block source is invalid: expected a zoned ISO updated stamp");
  }
  return {
    provider: "gcal",
    calendarId: source.calendarId,
    eventId: source.eventId,
    updated: source.updated,
    ...(source.recurringEventId === undefined ? {} : { recurringEventId: source.recurringEventId }),
  };
}

/**
 * Reads an import source out of a stored document. A block written before
 * imports existed has no source, and a hand-edited document may hold a partial
 * one; in either case the block still reads, minus the source. Only a complete
 * source is reported.
 */
function parseBlockSource(value: unknown): BlockSource | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (data.provider !== "gcal"
      || typeof data.calendarId !== "string" || data.calendarId === ""
      || typeof data.eventId !== "string" || data.eventId === ""
      || typeof data.updated !== "string" || data.updated === "") {
    return undefined;
  }
  return {
    provider: "gcal",
    calendarId: data.calendarId,
    eventId: data.eventId,
    updated: data.updated,
    ...(typeof data.recurringEventId === "string" && data.recurringEventId !== ""
      ? { recurringEventId: data.recurringEventId }
      : {}),
  };
}

/**
 * Reads a stored block document as a work block. The optional fields are
 * dropped when they are absent or malformed, so a document written before
 * titles and import sources existed reads as the plain block it always was.
 */
export function parseBlock(id: string, data: Record<string, unknown>): WorkBlock {
  const taskId = data.taskId === undefined ? undefined : String(data.taskId);
  const title = typeof data.title === "string" && data.title !== "" ? data.title : undefined;
  const source = parseBlockSource(data.source);
  return {
    id,
    start: String(data.start),
    end: String(data.end),
    ...(taskId === undefined ? {} : { taskId }),
    ...(title === undefined ? {} : { title }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * The stored document fields of a work block. This is the closed block schema:
 * optional fields are omitted rather than written as null, so a plain block is
 * still exactly its two instants. Every whole-document block write (create,
 * restore, import) goes through here, which is what makes a restored block the
 * same document that was deleted, and `parseBlock` its exact inverse.
 */
export function blockFields(block: WorkBlock): Record<string, unknown> {
  return {
    start: block.start,
    end: block.end,
    ...(block.taskId === undefined ? {} : { taskId: block.taskId }),
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.source === undefined ? {} : { source: block.source }),
  };
}

export function createWorkBlock(id: string, start: string, end: string, taskId?: string, extras?: BlockExtras): WorkBlock {
  requireInstant(start);
  requireInstant(end);
  if (Date.parse(end) <= Date.parse(start)) throw new Error("work block duration must be positive");
  const title = extras?.title === undefined ? undefined : extras.title.trim();
  if (title !== undefined && title === "") throw new Error("work block title must not be empty");
  const source = extras?.source === undefined ? undefined : requireBlockSource(extras.source);
  return {
    id,
    start,
    end,
    ...(taskId === undefined ? {} : { taskId }),
    ...(title === undefined ? {} : { title }),
    ...(source === undefined ? {} : { source }),
  };
}

export function occurrenceId(seriesId: string, date: string): string {
  if (!seriesId || seriesId.includes(":")) throw new Error("series ID is invalid");
  requireDate(date);
  return `${seriesId}:${date}`;
}

export function createOccurrenceCompletion(occurrence: string, completedAt: string): OccurrenceCompletion {
  const separator = occurrence.lastIndexOf(":");
  if (separator <= 0 || occurrenceId(occurrence.slice(0, separator), occurrence.slice(separator + 1)) !== occurrence) {
    throw new Error("occurrence ID is invalid");
  }
  requireInstant(completedAt);
  return { occurrenceId: occurrence, completedAt };
}

export function expandOccurrences(recurrence: Recurrence, from: string, to: string): Occurrence[] {
  requireDate(recurrence.anchorDate);
  requireDate(from);
  requireDate(to);
  if (from > to) throw new Error("expansion range is invalid");
  const anchor = Date.parse(`${recurrence.anchorDate}T00:00:00.000Z`);
  const lower = Date.parse(`${from}T00:00:00.000Z`);
  const upper = Date.parse(`${to}T00:00:00.000Z`);
  if ((upper - lower) / day + 1 > MAX_OCCURRENCE_WINDOW_DAYS) throw new Error("expansion window exceeds prototype limit");
  if (recurrence.frequency !== "daily" && recurrence.frequency !== "weekly" && recurrence.frequency !== "monthly") {
    throw new Error(`expected a daily, weekly or monthly recurrence frequency, got ${JSON.stringify(recurrence.frequency)}`);
  }
  if (recurrence.frequency === "monthly") {
    const dayOfMonth = Number(recurrence.anchorDate.slice(8, 10));
    const anchorMonths = Number(recurrence.anchorDate.slice(0, 4)) * 12 + Number(recurrence.anchorDate.slice(5, 7)) - 1;
    const lowerMonths = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
    const result: Occurrence[] = [];
    for (let months = Math.max(anchorMonths, lowerMonths);; months++) {
      const year = Math.floor(months / 12);
      const month = months % 12;
      if (Date.UTC(year, month, 1) > upper) break;
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      if (dayOfMonth > daysInMonth) continue;
      const date = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
      if (date >= from && date <= to) result.push({ id: occurrenceId(recurrence.seriesId, date), date });
    }
    return result;
  }
  const step = recurrence.frequency === "daily" ? 1 : 7;
  const offset = Math.max(0, Math.ceil((lower - anchor) / (step * day))) * step * day;
  const result: Occurrence[] = [];
  for (let current = anchor + offset; current <= upper; current += step * day) {
    const date = new Date(current).toISOString().slice(0, 10);
    result.push({ id: occurrenceId(recurrence.seriesId, date), date });
  }
  return result;
}

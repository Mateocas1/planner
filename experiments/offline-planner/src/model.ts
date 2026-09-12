export type Task = { id: string; title: string; deadline?: string };
export type WorkBlock = { id: string; start: string; end: string; taskId?: string };
export type Recurrence = {
  seriesId: string;
  frequency: "daily" | "weekly";
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

function requireInstant(instant: string): void {
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

export function createTask(id: string, title: string, deadline?: string): Task {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("task title is required");
  if (deadline !== undefined) requireDate(deadline);
  return { id, title: trimmed, ...(deadline === undefined ? {} : { deadline }) };
}

export function createWorkBlock(id: string, start: string, end: string, taskId?: string): WorkBlock {
  requireInstant(start);
  requireInstant(end);
  if (Date.parse(end) <= Date.parse(start)) throw new Error("work block duration must be positive");
  return { id, start, end, ...(taskId === undefined ? {} : { taskId }) };
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
  const step = recurrence.frequency === "daily" ? 1 : 7;
  const offset = Math.max(0, Math.ceil((lower - anchor) / (step * day))) * step * day;
  const result: Occurrence[] = [];
  for (let current = anchor + offset; current <= upper; current += step * day) {
    const date = new Date(current).toISOString().slice(0, 10);
    result.push({ id: occurrenceId(recurrence.seriesId, date), date });
  }
  return result;
}

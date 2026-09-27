import { useMemo, useState, type FormEvent } from "react";
import { addBlock, deleteBlock } from "../data/blocks.ts";
import type { BlockView, TaskView } from "../data/store.ts";

/**
 * The Calendar surface: a week time grid rendered in the stored profile
 * timezone (D3), with block creation, per-block delete and visible error
 * reporting. Every wall-clock part (day keys, columns, highlights, hour
 * ruler alignment, block positions and HH:MM labels) is derived from the
 * profile zone through Intl.DateTimeFormat — never from the browser's
 * getHours/getTimezoneOffset. Input is validated by the domain module (via
 * the data helpers), so rejected input never reaches Firestore. No offline
 * claim: writes go to Firestore and the store reflects what it reports.
 */

const minutesPerDay = 1440;
const dayMs = 86_400_000;
const hourHeight = 56; // px per hour; kept in sync with .calendar-hour in
// app.css. A block's height is always a percentage of the day, never a fixed
// pixel minimum, so its drawn height stays proportional to its duration.

/* D1: the grid frames the working day instead of all 24 hours, so the hours
   that carry content sit on screen instead of below the fold. The default
   window is 08:00-18:00 and only ever widens to take in a block that falls
   outside it, so no block becomes unreachable. This is a layout decision, not
   a control: there is nothing to scroll or toggle to see the rest of the day. */
const defaultStartHour = 8;
const defaultEndHour = 18;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

type WallParts = { year: number; month: number; day: number; hour: number; minute: number };

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a named IANA zone. */
function wallParts(date: Date, timeZone: string): WallParts {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Date key (YYYY-MM-DD) of an instant in the given zone. */
function dateKey(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Date key of a wall-UTC day value (the zone's own calendar day it
 * represents); reading it back through the zone would shift it by the
 * offset, so day columns key off the wall date directly. */
function wallDayKey(wallUtc: number): string {
  const date = new Date(wallUtc);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Epoch ms of an instant's wall clock in the zone, read as if UTC. Day
 * arithmetic on these values yields the zone's own calendar days. */
function wallAsUtc(date: Date, timeZone: string): number {
  const parts = wallParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/** Minutes since the zone's midnight for an instant. */
function wallMinutes(date: Date, timeZone: string): number {
  const parts = wallParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Wall-clock HH:MM of an instant in the given zone. */
function timeLabel(date: Date, timeZone: string): string {
  const parts = wallParts(date, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Monday of the zone's week containing a wall-UTC day value. */
function mondayOf(wallUtc: number): number {
  return wallUtc - ((new Date(wallUtc).getUTCDay() + 6) % 7) * dayMs;
}

/** The zone's offset at an instant, formatted +HH:MM / -HH:MM. Derived from
 * Intl, never from getTimezoneOffset(), which would be the browser's zone. */
function zoneOffset(stamp: number, timeZone: string): string {
  const minutes = Math.round((stamp - wallAsUtc(new Date(stamp), timeZone)) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Converts a datetime-local value into a zoned ISO instant interpreted in
 * the given zone. Two correction passes land the instant whose wall clock in
 * the zone equals the input, which also handles DST-transition walls. */
function toZonedInstant(value: string, timeZone: string): string {
  const guess = Date.parse(`${value}:00Z`);
  let stamp = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    stamp = guess - (guess - wallAsUtc(new Date(stamp), timeZone));
  }
  return `${value}:00${zoneOffset(stamp, timeZone)}`;
}

export function Calendar({ uid, blocks, tasks, loading, timeZone, profileError }: { uid: string; blocks: BlockView[]; tasks: TaskView[]; loading: boolean; timeZone: string | null; profileError: string | null }) {
  if (timeZone === null) {
    return (
      <section aria-labelledby="calendar-heading">
        <header className="page-head">
          <h2 id="calendar-heading">Calendar</h2>
        </header>
        {profileError ? <p role="alert">{profileError}</p> : <p role="status">Loading your planner timezone…</p>}
      </section>
    );
  }
  return <CalendarGrid uid={uid} blocks={blocks} tasks={tasks} loading={loading} timeZone={timeZone} />;
}

function CalendarGrid({ uid, blocks, tasks, loading, timeZone }: { uid: string; blocks: BlockView[]; tasks: TaskView[]; loading: boolean; timeZone: string }) {
  const [weekStart, setWeekStart] = useState<number | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Week navigation works on the profile zone's own calendar days, represented
  // as UTC midnights of wall dates; "today" is the zone's today.
  const weekStartWall = weekStart ?? mondayOf(wallAsUtc(new Date(), timeZone));
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => weekStartWall + index * dayMs), [weekStartWall]);
  const visibleKeys = useMemo(() => new Set(days.map(day => wallDayKey(day))), [days]);
  const weekBlocks = useMemo(
    () => blocks.filter(block => visibleKeys.has(dateKey(new Date(block.start), timeZone))),
    [blocks, visibleKeys, timeZone],
  );

  // D1/D2: every visible block resolved to the minutes it occupies inside its
  // own profile-zone day. A block ending on a later profile-zone day is
  // clipped at the column's midnight (the D3-known limitation).
  const laidOutBlocks = useMemo(
    () =>
      weekBlocks.map(block => {
        const startDate = new Date(block.start);
        const endDate = new Date(block.end);
        const key = dateKey(startDate, timeZone);
        const startMinutes = wallMinutes(startDate, timeZone);
        const endMinutes = dateKey(endDate, timeZone) > key ? minutesPerDay : wallMinutes(endDate, timeZone);
        return { block, key, startDate, endDate, startMinutes, endMinutes: Math.max(endMinutes, startMinutes) };
      }),
    [weekBlocks, timeZone],
  );

  // D1: the drawn window is the working day, widened -- never narrowed -- to
  // include every block the grid renders, so nothing drawn is off the range.
  const [rangeStart, rangeEnd] = useMemo(() => {
    let start = defaultStartHour * 60;
    let end = defaultEndHour * 60;
    for (const item of laidOutBlocks) {
      start = Math.min(start, Math.floor(item.startMinutes / 60) * 60);
      end = Math.max(end, Math.ceil(item.endMinutes / 60) * 60);
    }
    return [Math.max(0, start), Math.min(minutesPerDay, Math.max(end, start + 60))];
  }, [laidOutBlocks]);
  const rangeMinutes = rangeEnd - rangeStart;
  const hours = useMemo(
    () => Array.from({ length: rangeMinutes / 60 }, (_, index) => rangeStart / 60 + index),
    [rangeMinutes, rangeStart],
  );
  // The current day is the profile zone's own today, so the highlighted
  // column follows the planner timezone, not the browser's zone.
  const todayKey = dateKey(new Date(), timeZone);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await addBlock(uid, toZonedInstant(start, timeZone), toZonedInstant(end, timeZone), taskId === "" ? undefined : taskId);
      setStart("");
      setEnd("");
      setTaskId("");
    });
  };

  const utc = { timeZone: "UTC" } as const;
  const weekLabel = `${new Date(weekStartWall).toLocaleDateString("en-US", { ...utc, month: "short", day: "numeric" })} – ${new Date(weekStartWall + 6 * dayMs).toLocaleDateString("en-US", { ...utc, month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <section aria-labelledby="calendar-heading">
      <header className="page-head">
        <h2 id="calendar-heading">Calendar</h2>
      </header>
      <p className="calendar-tz">Times are shown in the planner timezone ({timeZone}).</p>
      <div className="calendar-toolbar">
        <button type="button" onClick={() => setWeekStart(previous => mondayOf((previous ?? weekStartWall) - 7 * dayMs))}>Previous week</button>
        <button type="button" onClick={() => setWeekStart(mondayOf(wallAsUtc(new Date(), timeZone)))}>Today</button>
        <button type="button" onClick={() => setWeekStart(previous => mondayOf((previous ?? weekStartWall) + 7 * dayMs))}>Next week</button>
        <span className="calendar-week-label">{weekLabel}</span>
      </div>
      <form className="block-form" onSubmit={onAdd}>
        <div className="block-field">
          <label htmlFor="block-start">Start</label>
          <input id="block-start" type="datetime-local" value={start} onChange={event => setStart(event.target.value)} />
        </div>
        <div className="block-field">
          <label htmlFor="block-end">End</label>
          <input id="block-end" type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} />
        </div>
        <div className="block-field">
          <label htmlFor="block-task">Task</label>
          <select id="block-task" value={taskId} onChange={event => setTaskId(event.target.value)}>
            <option value="">No task</option>
            {tasks.map(task => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={busy}>Add block</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!loading && weekBlocks.length === 0 && <p className="empty-note" role="status">No work blocks this week.</p>}
      <div className="calendar-grid">
        <div className="calendar-ruler" aria-hidden="true">
          <div className="calendar-ruler-head" />
          {hours.map(hour => (
            <div key={hour} className="calendar-hour" style={{ height: hourHeight }}>{pad(hour)}:00</div>
          ))}
        </div>
        {days.map(day => {
          const key = wallDayKey(day);
          return (
            <div
              key={key}
              className={`calendar-day${key === todayKey ? " calendar-day-today" : ""}`}
              data-date={key}
              {...(key === todayKey ? { "data-today": "true" } : {})}
            >
              <div className="calendar-day-head">
                <span className="calendar-day-number">{new Date(day).toLocaleDateString("en-US", { ...utc, day: "numeric" })}</span>
                <span className="calendar-day-weekday">{new Date(day).toLocaleDateString("en-US", { ...utc, weekday: "short" })}</span>
              </div>
              <div className="calendar-day-body" style={{ height: (rangeMinutes / 60) * hourHeight }}>
                {laidOutBlocks.filter(item => item.key === key).map(({ block, startDate, endDate, startMinutes, endMinutes }) => {
                  // Clamped into the drawn window, which by construction
                  // already contains every block (D1).
                  const from = Math.max(rangeStart, Math.min(startMinutes, rangeEnd));
                  const to = Math.max(from, Math.min(endMinutes, rangeEnd));
                  const task = tasks.find(candidate => candidate.id === block.taskId);
                  return (
                    <div
                      key={block.id}
                      className={`calendar-block${block.pending ? " calendar-block-pending" : ""}`}
                      data-start={block.start}
                      data-end={block.end}
                      style={{
                        top: `${((from - rangeStart) / rangeMinutes) * 100}%`,
                        height: `${((to - from) / rangeMinutes) * 100}%`,
                      }}
                    >
                      <span className="block-time">{timeLabel(startDate, timeZone)}–{timeLabel(endDate, timeZone)}</span>
                      {task && <span className="block-task">{task.title}</span>}
                      <button
                        type="button"
                        className="block-delete"
                        disabled={busy}
                        aria-label={`Delete block ${key} ${timeLabel(startDate, timeZone)}`}
                        onClick={() => void run(() => deleteBlock(uid, block.id))}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

import { useMemo, useState, type FormEvent } from "react";
import { addBlock, deleteBlock } from "../data/blocks.ts";
import type { TaskView } from "../data/store.ts";
import type { WorkBlock } from "../domain/model.ts";

/**
 * The Calendar surface: a week time grid rendered in the browser's local
 * timezone (the profile timezone is increment I6), with block creation,
 * per-block delete and visible error reporting. Input is validated by the
 * domain module (via the data helpers), so rejected input never reaches
 * Firestore. No offline claim: writes go to Firestore and the store reflects
 * what it reports.
 */

const minutesPerDay = 1440;
const hourHeight = 40; // px per hour; kept in sync with .calendar-hour in app.css

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local date key (YYYY-MM-DD) in the browser's timezone. */
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mondayOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Converts a datetime-local value into a zoned ISO instant at the browser's offset. */
function toZonedInstant(value: string): string {
  const offset = -new Date(value).getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${value}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function timeLabel(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Calendar({ uid, blocks, tasks, loading }: { uid: string; blocks: WorkBlock[]; tasks: TaskView[]; loading: boolean }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const visibleKeys = useMemo(() => new Set(days.map(dateKey)), [days]);
  const weekBlocks = blocks.filter(block => visibleKeys.has(dateKey(new Date(block.start))));

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
      await addBlock(uid, toZonedInstant(start), toZonedInstant(end), taskId === "" ? undefined : taskId);
      setStart("");
      setEnd("");
      setTaskId("");
    });
  };

  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${addDays(weekStart, 6).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <section aria-labelledby="calendar-heading">
      <h2 id="calendar-heading">Calendar</h2>
      <p className="calendar-tz">Times are shown in your local timezone ({timeZone}).</p>
      <div className="calendar-toolbar">
        <button type="button" onClick={() => setWeekStart(previous => addDays(previous, -7))}>Previous week</button>
        <button type="button" onClick={() => setWeekStart(mondayOf(new Date()))}>Today</button>
        <button type="button" onClick={() => setWeekStart(previous => addDays(previous, 7))}>Next week</button>
        <span className="calendar-week-label">{weekLabel}</span>
      </div>
      <form className="block-form" onSubmit={onAdd}>
        <label htmlFor="block-start">Start</label>
        <input id="block-start" type="datetime-local" value={start} onChange={event => setStart(event.target.value)} />
        <label htmlFor="block-end">End</label>
        <input id="block-end" type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} />
        <label htmlFor="block-task">Task</label>
        <select id="block-task" value={taskId} onChange={event => setTaskId(event.target.value)}>
          <option value="">No task</option>
          {tasks.map(task => (
            <option key={task.id} value={task.id}>{task.title}</option>
          ))}
        </select>
        <button type="submit" disabled={busy}>Add block</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!loading && weekBlocks.length === 0 && <p role="status">No work blocks this week.</p>}
      <div className="calendar-grid">
        <div className="calendar-ruler" aria-hidden="true">
          <div className="calendar-ruler-head" />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="calendar-hour" style={{ height: hourHeight }}>{pad(hour)}:00</div>
          ))}
        </div>
        {days.map(day => {
          const key = dateKey(day);
          return (
            <div key={key} className="calendar-day" data-date={key}>
              <div className="calendar-day-head">
                {day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="calendar-day-body" style={{ height: hourHeight * 24 }}>
                {blocks.filter(block => dateKey(new Date(block.start)) === key).map(block => {
                  const startDate = new Date(block.start);
                  const endDate = new Date(block.end);
                  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
                  const nextMidnight = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1);
                  const endMinutes = endDate >= nextMidnight ? minutesPerDay : endDate.getHours() * 60 + endDate.getMinutes();
                  const task = tasks.find(candidate => candidate.id === block.taskId);
                  return (
                    <div
                      key={block.id}
                      className="calendar-block"
                      data-start={block.start}
                      data-end={block.end}
                      style={{
                        top: `${(startMinutes / minutesPerDay) * 100}%`,
                        height: `${((endMinutes - startMinutes) / minutesPerDay) * 100}%`,
                      }}
                    >
                      <span className="block-time">{timeLabel(startDate)}–{timeLabel(endDate)}</span>
                      {task && <span className="block-task">{task.title}</span>}
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Delete block ${key} ${timeLabel(startDate)}`}
                        onClick={() => void run(() => deleteBlock(uid, block.id))}
                      >
                        Delete
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

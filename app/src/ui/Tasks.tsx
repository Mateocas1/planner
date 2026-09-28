import { useState, type FormEvent } from "react";
import { MAX_OCCURRENCE_WINDOW_DAYS, expandOccurrences, type Occurrence, type Recurrence } from "../domain/model.ts";
import { useProfileTimeZone } from "../data/profile.ts";
import { addSeries, completeOccurrence, deleteSeries, renameSeries, setSeriesAnchor, setSeriesFrequency, type Frequency } from "../data/series.ts";
import type { SeriesView, TaskView } from "../data/store.ts";
import { addTask, deleteTask, renameTask, setTaskCompleted, setTaskDeadline } from "../data/tasks.ts";
import { SeriesDetails, TaskDetails, type SeriesOccurrenceView } from "./TaskDetails.tsx";
import { formatDateKey, isPastDateKey } from "./format.ts";

/** Local YYYY-MM-DD key for an instant in a named IANA zone. */
function dateKeyIn(zone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The next uncompleted occurrence of a series, derived per D1: occurrences
 * are never persisted, so the row expands the series from the planner's
 * today (the profile timezone) and skips completed occurrence IDs. The
 * horizon keeps the expansion inside the domain's bounded window.
 */
function nextOccurrence(series: SeriesView, completions: Record<string, string>, today: string): Occurrence | null {
  try {
    const from = series.anchorDate > today ? series.anchorDate : today;
    const recurrence: Recurrence = { seriesId: series.id, frequency: series.frequency, anchorDate: series.anchorDate };
    const occurrences = expandOccurrences(recurrence, from, addDays(from, MAX_OCCURRENCE_WINDOW_DAYS - 1));
    return occurrences.find(occurrence => !(occurrence.id in completions)) ?? null;
  } catch {
    return null;
  }
}

/** How many upcoming occurrences the series details panel offers. */
const PANEL_OCCURRENCE_COUNT = 3;

/**
 * The next few occurrences of a series, derived per D1: occurrences are
 * never persisted, so the panel expands the series from the planner's today
 * (the profile timezone) and marks each one with its completion state.
 */
function upcomingOccurrences(series: SeriesView, completions: Record<string, string>, today: string): SeriesOccurrenceView[] {
  try {
    const from = series.anchorDate > today ? series.anchorDate : today;
    const recurrence: Recurrence = { seriesId: series.id, frequency: series.frequency, anchorDate: series.anchorDate };
    const occurrences = expandOccurrences(recurrence, from, addDays(from, MAX_OCCURRENCE_WINDOW_DAYS - 1));
    return occurrences.slice(0, PANEL_OCCURRENCE_COUNT).map(occurrence => ({
      id: occurrence.id,
      date: occurrence.date,
      completed: occurrence.id in completions,
    }));
  } catch {
    return [];
  }
}

/**
 * The Tasks surface. Rows are compact — completion checkbox, title, deadline —
 * and every mutating action lives in the details panel for the selected row
 * (task or series). Series and completion records are threaded in by the
 * shell's single store subscription, like tasks and blocks. Input is
 * validated by the domain module (via the data helpers), so rejected input
 * never reaches Firestore; thrown errors are displayed. No offline claim:
 * writes go to Firestore and the store reflects what it reports.
 */
export function Tasks({
  uid,
  tasks,
  series,
  completions,
  loading,
}: {
  uid: string;
  tasks: TaskView[];
  series: SeriesView[];
  completions: Record<string, string>;
  loading: boolean;
}) {
  const profile = useProfileTimeZone(uid);
  // C2: creation is revealed on demand. The form is never permanently on the
  // surface: a quiet "+ New task" row opens it, Enter in the title creates the
  // task (the form's native submit), and a successful write collapses it
  // again. The deadline and repeat controls stay inside the revealed row, so
  // the series capability is not lost with the always-visible form.
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [repeat, setRepeat] = useState<Frequency | "off">("off");
  const [start, setStart] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  // Rows whose completion the user just performed in this session: the wash
  // class is applied only to these, so it never plays on mount for rows that
  // were already completed. The class is removed on animationend.
  const [washIds, setWashIds] = useState<ReadonlySet<string>>(() => new Set<string>());

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

  /** Completes or reopens a task; completing it queues the one-shot wash. */
  function completeTask(taskId: string, completed: boolean) {
    void run(async () => {
      await setTaskCompleted(uid, taskId, completed);
      setWashIds(previous => {
        const next = new Set(previous);
        if (completed) next.add(taskId);
        else next.delete(taskId);
        return next;
      });
    });
  }

  /** Retires the wash class once its animation has actually run. */
  const endTaskWash = (taskId: string, event: React.AnimationEvent) => {
    if (event.animationName !== "task-wash") return;
    setWashIds(previous => {
      if (!previous.has(taskId)) return previous;
      const next = new Set(previous);
      next.delete(taskId);
      return next;
    });
  };

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (repeat === "off") {
        await addTask(uid, title, deadline === "" ? undefined : deadline);
      } else {
        await addSeries(uid, title, repeat, start, deadline === "" ? undefined : deadline);
      }
      setTitle("");
      setDeadline("");
      setRepeat("off");
      setStart("");
      setCreating(false);
    });
  };

  /** Dismisses the revealed creation row and clears whatever was typed. */
  function closeCreate() {
    setCreating(false);
    setTitle("");
    setDeadline("");
    setRepeat("off");
    setStart("");
    setError(null);
  }

  const selected = tasks.find(task => task.id === selectedId);
  const selectedSeries = series.find(entry => entry.id === selectedSeriesId);
  const open = tasks.filter(task => !task.completed);
  const completed = tasks.filter(task => task.completed);
  const today = dateKeyIn(profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  const group = (label: string, items: TaskView[]) => (
    <section className="task-group">
      <h3 className="section-heading task-group-heading">
        {label} <span className="heading-count">({items.length})</span>
      </h3>
      <ul className="task-list">
        {items.map(task => (
          <li
            key={task.id}
            className={`task${task.completed ? " completed" : ""}${washIds.has(task.id) ? " task-wash" : ""}`}
            data-pending={task.pending ? "true" : "false"}
            onAnimationEnd={event => endTaskWash(task.id, event)}
          >
            <input
              type="checkbox"
              className="task-check"
              checked={task.completed}
              disabled={busy}
              aria-label={`${task.completed ? "Reopen" : "Complete"}: ${task.title}`}
              onChange={() => completeTask(task.id, !task.completed)}
            />
            <button
              type="button"
              className="task-open"
              onClick={() => {
                setSelectedId(task.id);
                setSelectedSeriesId(null);
                setError(null);
              }}
            >
              <span className="task-title">{task.title}</span>
            </button>
            {task.deadline && (
              /* C1: an unfinished deadline before today is the overdue state,
                 marked with the existing danger token -- never a new colour */
              <span
                className={`task-deadline${!task.completed && isPastDateKey(task.deadline, today) ? " task-deadline-overdue" : ""}`}
              >
                due {formatDateKey(task.deadline, today)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <section aria-labelledby="tasks-heading">
      <header className="page-head">
        <h2 id="tasks-heading">Tasks</h2>
      </header>
      {creating ? (
        <form
          className="task-form"
          onSubmit={onAdd}
          onKeyDown={event => {
            if (event.key === "Escape") closeCreate();
          }}
        >
          <div className="task-field task-field-grow">
            <label htmlFor="task-title">Task title</label>
            <input
              id="task-title"
              type="text"
              autoFocus
              value={title}
              onChange={event => setTitle(event.target.value)}
            />
          </div>
          <div className="task-field">
            <label htmlFor="task-deadline">Deadline</label>
            <input
              id="task-deadline"
              type="date"
              value={deadline}
              onChange={event => setDeadline(event.target.value)}
            />
          </div>
          <div className="task-field">
            <label htmlFor="task-repeat">Repeat</label>
            <select
              id="task-repeat"
              value={repeat}
              onChange={event => setRepeat(event.target.value as Frequency | "off")}
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {repeat !== "off" && (
            <div className="task-field">
              <label htmlFor="task-start">Start date</label>
              <input
                id="task-start"
                type="date"
                value={start}
                onChange={event => setStart(event.target.value)}
              />
            </div>
          )}
          <button type="submit" disabled={busy}>
            Add task
          </button>
          <button type="button" className="task-cancel" onClick={closeCreate}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="new-task" onClick={() => setCreating(true)}>
          <span aria-hidden="true">+</span>New task
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {!loading && tasks.length === 0 && series.length === 0 ? (
        <p className="empty-note" role="status">No tasks yet. Add your first one above.</p>
      ) : (
        <>
          {series.length > 0 && (
            <section className="task-group">
              <h3 className="section-heading task-group-heading">
                Repeating <span className="heading-count">({series.length})</span>
              </h3>
              <ul className="task-list">
                {series.map(seriesRow => {
                  const next = nextOccurrence(seriesRow, completions, today);
                  return (
                    <li key={seriesRow.id} className="task series-row" data-next-occurrence={next?.date ?? ""}>
                      <input
                        type="checkbox"
                        className="task-check"
                        checked={false}
                        disabled={busy || next === null}
                        aria-label={next === null ? `Complete: ${seriesRow.title}` : `Complete: ${seriesRow.title} on ${next.date}`}
                        onChange={() => {
                          if (next) void run(() => completeOccurrence(uid, seriesRow.id, next.date));
                        }}
                      />
                      <button
                        type="button"
                        className="task-open"
                        onClick={() => {
                          setSelectedSeriesId(seriesRow.id);
                          setSelectedId(null);
                          setError(null);
                        }}
                      >
                        <span className="task-title">{seriesRow.title}</span>
                      </button>
                      <span className="series-frequency">{seriesRow.frequency}</span>
                      {next && <span className="task-deadline">next {formatDateKey(next.date, today)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {open.length > 0 && group("Open", open)}
          {completed.length > 0 && group("Completed", completed)}
        </>
      )}
      {selectedSeries && (
        <SeriesDetails
          key={selectedSeries.id}
          series={selectedSeries}
          occurrences={upcomingOccurrences(selectedSeries, completions, today)}
          today={today}
          busy={busy}
          hasHistory={Object.keys(completions).some(id => id.startsWith(`${selectedSeries.id}:`))}
          onClose={() => setSelectedSeriesId(null)}
          onRename={next => {
            void run(() => renameSeries(uid, selectedSeries.id, next));
          }}
          onFrequencyChange={frequency => {
            void run(() => setSeriesFrequency(uid, selectedSeries.id, frequency, selectedSeries.anchorDate));
          }}
          onAnchorChange={anchorDate => {
            void run(() => setSeriesAnchor(uid, selectedSeries.id, selectedSeries.frequency, anchorDate));
          }}
          onCompleteOccurrence={date => {
            void run(() => completeOccurrence(uid, selectedSeries.id, date));
          }}
          onDelete={() => {
            void run(() => deleteSeries(uid, selectedSeries.id));
          }}
        />
      )}
      {selected && (
        <TaskDetails
          key={selected.id}
          task={selected}
          busy={busy}
          onClose={() => setSelectedId(null)}
          onRename={next => {
            void run(async () => {
              await renameTask(uid, selected.id, next);
            });
          }}
          onDeadlineChange={next => {
            void run(async () => {
              await setTaskDeadline(uid, selected.id, selected.title, next === "" ? undefined : next);
            });
          }}
          onToggleCompleted={() => {
            completeTask(selected.id, !selected.completed);
          }}
          onDelete={() => {
            void run(() => deleteTask(uid, selected.id));
          }}
        />
      )}
    </section>
  );
}

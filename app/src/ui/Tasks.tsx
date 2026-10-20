import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { MAX_OCCURRENCE_WINDOW_DAYS, expandOccurrences, type Occurrence, type Recurrence } from "../domain/model.ts";
import { completeOccurrence, deleteSeries, renameSeries, restoreSeries, setSeriesAnchor, setSeriesFrequency } from "../data/series.ts";
import type { SeriesView, TaskView } from "../data/store.ts";
import { deleteTask, renameTask, restoreTask, setTaskCompleted, setTaskDeadline } from "../data/tasks.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { DragGrip } from "./drag.tsx";
import { RepeatIcon } from "./icons.tsx";
import { spring } from "./motion.ts";
import { morphClose, morphOpen } from "./morph.ts";
import { SeriesDetails, TaskDetails, type SeriesOccurrenceView } from "./TaskDetails.tsx";
import { type UndoableDelete } from "./UndoToast.tsx";
import { settle } from "./write.ts";

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The series' occurrences from the planner's today (D1: never persisted). */
function occurrencesFrom(series: SeriesView, today: string): Occurrence[] {
  try {
    const from = series.anchorDate > today ? series.anchorDate : today;
    const recurrence: Recurrence = { seriesId: series.id, frequency: series.frequency, anchorDate: series.anchorDate };
    return expandOccurrences(recurrence, from, addDays(from, MAX_OCCURRENCE_WINDOW_DAYS - 1));
  } catch {
    return [];
  }
}

/** The next uncompleted occurrence of a series, or null. */
export function nextOccurrence(series: SeriesView, completions: Record<string, string>, today: string): Occurrence | null {
  return occurrencesFrom(series, today).find(occurrence => !(occurrence.id in completions)) ?? null;
}

/** How many upcoming occurrences the series sheet offers. */
const SHEET_OCCURRENCE_COUNT = 3;

function upcomingOccurrences(series: SeriesView, completions: Record<string, string>, today: string): SeriesOccurrenceView[] {
  return occurrencesFrom(series, today).slice(0, SHEET_OCCURRENCE_COUNT).map(occurrence => ({
    id: occurrence.id,
    date: occurrence.date,
    completed: occurrence.id in completions,
  }));
}

const frequencyLabel: Record<SeriesView["frequency"], string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** How long a just-toggled row stays in place before it travels to its new
 * group: long enough for the check to read, short enough to stay a beat and not
 * a wait. The circle's pop peaks at 70 % of its --dur-state (about 140 ms, see
 * check-pop in app.css), so the glyph is already landing as the row leaves.
 * Reduced motion drops the beat entirely and swaps groups at once. */
const settleMs = 160;

/**
 * The Tasks surface: inset grouped lists (Repeating, Open, Completed) of
 * compact rows -- a round check, the title and its deadline. Selecting a row
 * opens its details sheet, which holds every other action. Creation lives in
 * the shell's New task sheet. Completing a task is the product's signature
 * moment: the check pops, the title is struck through, and a beat later the
 * row travels to Completed.
 */
export function Tasks({
  uid,
  tasks,
  series,
  completions,
  loading,
  today,
  onDeleted,
  openTaskId = null,
  onOpenTaskHandled,
}: {
  uid: string;
  tasks: TaskView[];
  series: SeriesView[];
  completions: Record<string, string>;
  loading: boolean;
  today: string;
  onDeleted: (item: UndoableDelete) => void;
  /** A task the shell asked this surface to reveal, e.g. one the command
   * palette found. Null when nothing is pending. */
  openTaskId?: string | null;
  onOpenTaskHandled?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `origin` is the row a panel grows out of and returns to. A panel the shell
  // asked for (the command palette) has no row of its own, so it is null and
  // the morph is skipped: there is nothing to fly from or back to.
  const [selected, setSelected] = useState<{ kind: "task" | "series"; id: string; origin: HTMLElement | null } | null>(null);
  // Rows whose completion the user just performed and that have landed in their
  // new group: the wash starts there, once, and never on mount for rows that were
  // already completed.
  const [washIds, setWashIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Rows whose check is mid-pop: the glyph acknowledgment belongs to the row
  // where it was pressed, so it is dropped the instant the row travels and never
  // replays on the node that lands in the new group.
  const [popIds, setPopIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Rows held in their old group for a beat after a toggle (see settleMs).
  const [settling, setSettling] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const timers = useRef(new Map<string, number>());
  // A row's own node is replaced when it changes group, so its focus is restored
  // once it lands. The id waits here until the row is in its final group.
  const restoreFocus = useRef<string | null>(null);
  const reduced = useReducedMotion();
  const travel = reduced ? 0 : settleMs;

  useEffect(() => () => timers.current.forEach(id => window.clearTimeout(id)), []);

  // Give focus back to the check that travelled: same control, new group.
  useEffect(() => {
    const id = restoreFocus.current;
    if (id === null || settling.has(id) || busy) return;
    // Only a row that lost the caret to the node swap gets it back: replacing
    // the row's node drops focus to <body>. Anything else holding focus (a
    // panel opened mid-travel, a creation sheet, another row's check) is where
    // the user deliberately is, and nothing here may take it away.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const check = document.querySelector<HTMLInputElement>(`li.task[data-task-id="${CSS.escape(id)}"] input.task-check`);
    if (!check || check.disabled) return;
    restoreFocus.current = null;
    check.focus({ preventScroll: true });
  }, [settling, busy]);
  /* A request from the shell (the command palette) opens one task's details.
     It waits for the store to deliver the task, then clears itself; a request
     for a task that is not there is dropped once loading has finished.
     No row opened this panel, so there is no origin to morph from: the sheet
     takes its own entrance. Borrowing the row would mean starting a view
     transition in the frame the view itself is still animating in. */
  useEffect(() => {
    if (!openTaskId) return;
    const task = tasks.find(entry => entry.id === openTaskId);
    if (!task) {
      if (!loading) onOpenTaskHandled?.();
      return;
    }
    setSelected({ kind: "task", id: task.id, origin: null });
    onOpenTaskHandled?.();
    // Tasks read through `tasks` only; re-running on every render would reopen
    // a panel the user just closed while the request is still pending.
  }, [openTaskId, tasks, loading, onOpenTaskHandled]);

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

  function completeTask(task: TaskView, completed: boolean) {
    const row = document.activeElement instanceof Element ? document.activeElement.closest("li.task") : null;
    if (row !== null && row.getAttribute("data-task-id") === task.id) restoreFocus.current = task.id;
    // Where to show the row for the beat: the group it is in right now, so a
    // rapid second toggle re-arms the beat instead of making the row jump
    // twice, and the row only ever travels once to its final group.
    const shown = settling.get(task.id) ?? task.completed;
    setSettling(previous => new Map(previous).set(task.id, shown));
    window.clearTimeout(timers.current.get(task.id));
    timers.current.set(
      task.id,
      window.setTimeout(() => {
        setSettling(previous => {
          const next = new Map(previous);
          next.delete(task.id);
          return next;
        });
        // the check has landed; only now does the row leave its group, and the
        // wash starts in the same render, on the node that arrives, so it plays
        // once for the completion instead of restarting on the node that travels
        setWashIds(previous => {
          const next = new Set(previous);
          if (completed) next.add(task.id);
          else next.delete(task.id);
          return next;
        });
        setPopIds(previous => {
          if (!previous.has(task.id)) return previous;
          const next = new Set(previous);
          next.delete(task.id);
          return next;
        });
      }, travel),
    );
    setPopIds(previous => {
      const next = new Set(previous);
      if (completed) next.add(task.id);
      else next.delete(task.id);
      return next;
    });
    void run(() => setTaskCompleted(uid, task.id, completed));
  }

  const endTaskWash = (taskId: string, event: React.AnimationEvent) => {
    if (event.animationName !== "task-wash") return;
    setWashIds(previous => {
      if (!previous.has(taskId)) return previous;
      const next = new Set(previous);
      next.delete(taskId);
      return next;
    });
  };

  const selectedTask = selected?.kind === "task" ? tasks.find(task => task.id === selected.id) : undefined;
  const selectedSeries = selected?.kind === "series" ? series.find(entry => entry.id === selected.id) : undefined;
  // grouping follows the settled state, so a toggled row waits a beat in place
  const groupDone = (task: TaskView) => settling.get(task.id) ?? task.completed;
  const open = tasks
    .filter(task => !groupDone(task))
    .sort((left, right) => (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999"));
  const completed = tasks.filter(groupDone);
  const overdue = tasks.filter(task => !task.completed && task.deadline !== undefined && isPastDateKey(task.deadline, today)).length;

  const taskRow = (task: TaskView) => (
    // layout="position": only the box moves, so no title is ever scaled on the
    // way; layoutId lets the arriving node continue from the departed one, and
    // Motion retargets mid-flight, so a second toggle never stacks a second
    // travel. snappy, not smooth: a row crossing two groups is a list reflow,
    // not a surface entrance, and it must land under 300 ms.
    <motion.li
      key={task.id}
      layout={reduced ? false : "position"}
      layoutId={reduced ? undefined : `task-${task.id}`}
      transition={spring.snappy}
      className={`row task${task.completed ? " completed" : ""}${washIds.has(task.id) ? " task-wash" : ""}${popIds.has(task.id) ? " task-pop" : ""}`}
      data-task-id={task.id}
      data-pending={task.pending ? "true" : "false"}
      onAnimationEnd={event => endTaskWash(task.id, event)}
    >
      <input
        type="checkbox"
        className="check task-check"
        checked={task.completed}
        disabled={busy}
        aria-label={`${task.completed ? "Reopen" : "Complete"}: ${task.title}`}
        onChange={() => completeTask(task, !task.completed)}
      />
      <button
        type="button"
        className="row-main task-open"
        onClick={event => {
          setError(null);
          const row = event.currentTarget.closest("li") ?? event.currentTarget;
          // The row grows into the panel; with no view transition (or reduced
          // motion) this is a plain state update and Sheet keeps its own flight.
          morphOpen(() => setSelected({ kind: "task", id: task.id, origin: row }), row);
        }}
      >
        {/* A truncated title still gives the full text on a phone, where there
            is no hover: the title attribute is the only affordance (audit F10). */}
        <span className="task-title" title={task.title}>{task.title}</span>
        {task.deadline && (
          <span
            className={`row-meta task-deadline${!task.completed && isPastDateKey(task.deadline, today) ? " task-deadline-overdue" : ""}${!task.completed && task.deadline === today ? " task-deadline-today" : ""}`}
          >
            due {formatDateKey(task.deadline, today)}
          </span>
        )}
      </button>
      <DragGrip task={task} />
    </motion.li>
  );

  const group = (label: string, items: TaskView[]) => (
    <section className="list-section task-group">
      <h3 className="section-title">
        {label} <span className="heading-count">{items.length}</span>
      </h3>
      <ul className="group task-list">{items.map(taskRow)}</ul>
    </section>
  );

  const empty = !loading && tasks.length === 0 && series.length === 0;

  return (
    <section className="view" aria-labelledby="tasks-heading">
      <header className="page-head">
        <div>
          <h2 id="tasks-heading" className="large-title">Tasks</h2>
          {!empty && (
            <p className="subtitle">
              {tasks.length - completed.length} open{overdue > 0 ? `, ${overdue} overdue` : ""}
            </p>
          )}
        </div>
      </header>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {empty ? (
        <div className="empty-state" role="status">
          <p className="empty-title">No tasks yet.</p>
          <p>Add your first one with New task. Give it a deadline, or make it repeat.</p>
        </div>
      ) : (
        <LayoutGroup>
          <div className="stack task-lists">
            {series.length > 0 && (
              <section className="list-section task-group">
                <h3 className="section-title">
                  Repeating <span className="heading-count">{series.length}</span>
                </h3>
                <ul className="group task-list">
                  {series.map(seriesRow => {
                    const next = nextOccurrence(seriesRow, completions, today);
                    return (
                      <li key={seriesRow.id} className="row task series-row" data-next-occurrence={next?.date ?? ""}>
                        <input
                          type="checkbox"
                          className="check task-check"
                          checked={false}
                          disabled={busy || next === null}
                          aria-label={next === null ? `Complete: ${seriesRow.title}` : `Complete: ${seriesRow.title} on ${next.date}`}
                          onChange={() => {
                            if (next) void run(() => completeOccurrence(uid, seriesRow.id, next.date));
                          }}
                        />
                        <button
                          type="button"
                          className="row-main task-open"
                          onClick={event => {
                            setError(null);
                            const row = event.currentTarget.closest("li") ?? event.currentTarget;
                            morphOpen(() => setSelected({ kind: "series", id: seriesRow.id, origin: row }), row);
                          }}
                        >
                          <span className="task-title" title={seriesRow.title}>{seriesRow.title}</span>
                          <span className="row-meta">
                            <span className="series-frequency">
                              <RepeatIcon className="meta-icon" />
                              {frequencyLabel[seriesRow.frequency] ?? seriesRow.frequency}
                            </span>
                            {next && <span className={`task-deadline${next.date === today ? " task-deadline-today" : ""}`}>next {formatDateKey(next.date, today)}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {open.length > 0 && group("Open", open)}
            {completed.length > 0 && group("Completed", completed)}
          </div>
        </LayoutGroup>
      )}
      <AnimatePresence>
        {selectedSeries && selected && (
          <SeriesDetails
            key={selectedSeries.id}
            series={selectedSeries}
            origin={selected.origin}
            shared
            occurrences={upcomingOccurrences(selectedSeries, completions, today)}
            today={today}
            busy={busy}
            hasHistory={Object.keys(completions).some(id => id.startsWith(`${selectedSeries.id}:`))}
            onClose={() => morphClose(() => setSelected(null), selected.origin)}
            onRename={next => void run(() => renameSeries(uid, selectedSeries.id, next))}
            onFrequencyChange={frequency => void run(() => setSeriesFrequency(uid, selectedSeries.id, frequency, selectedSeries.anchorDate))}
            onAnchorChange={anchorDate => void run(() => setSeriesAnchor(uid, selectedSeries.id, selectedSeries.frequency, anchorDate))}
            onCompleteOccurrence={date => void run(() => completeOccurrence(uid, selectedSeries.id, date))}
            onDelete={() => {
              // Capture the definition before the sheet closes: undo rewrites it
              // under the same id, so its completion history stays attached.
              const deleted = selectedSeries;
              setSelected(null);
              void settle(deleteSeries(uid, deleted.id))
                .then(() => onDeleted({ message: "Series deleted", restore: () => restoreSeries(uid, deleted) }))
                .catch(() => undefined);
            }}
          />
        )}
        {selectedTask && selected && (
          <TaskDetails
            key={selectedTask.id}
            task={selectedTask}
            origin={selected.origin}
            shared
            busy={busy}
            onClose={() => morphClose(() => setSelected(null), selected.origin)}
            onRename={next => void run(() => renameTask(uid, selectedTask.id, next))}
            onDeadlineChange={next =>
              void run(() => setTaskDeadline(uid, selectedTask.id, selectedTask.title, next === "" ? undefined : next))
            }
            onToggleCompleted={() => completeTask(selectedTask, !selectedTask.completed)}
            onDelete={() => {
              // The row's exact fields (title, completion, deadline) travel with
              // the offer: undo rewrites them under the same document id.
              const deleted = selectedTask;
              setSelected(null);
              void settle(deleteTask(uid, deleted.id))
                .then(() => onDeleted({ message: "Task deleted", restore: () => restoreTask(uid, deleted) }))
                .catch(() => undefined);
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

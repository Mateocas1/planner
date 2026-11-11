import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { MAX_OCCURRENCE_WINDOW_DAYS, expandOccurrences, type Occurrence, type Recurrence } from "../domain/model.ts";
import { completeOccurrence, deleteSeries, renameSeries, restoreSeries, setSeriesAnchor, setSeriesEstimate, setSeriesFrequency } from "../data/series.ts";
import type { BlockView, SeriesView, TaskView } from "../data/store.ts";
import { deleteTask, renameTask, restoreTaskWithBlocks, setTaskCompleted, setTaskDeadline, setTaskEstimate } from "../data/tasks.ts";
import { linkedBlocks } from "../data/blocks.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { DragGrip } from "./drag.tsx";
import { completedSamples } from "./BiasHint.tsx";
import { t } from "../i18n/index.ts";
import { PlusIcon, RepeatIcon } from "./icons.tsx";
import { spring } from "./motion.ts";
import { morphClose, morphOpen } from "./morph.ts";
import { SeriesDetails, TaskDetails, type SeriesOccurrenceView } from "./TaskDetails.tsx";
import { rovingTabIndex, tomorrowKey } from "./shortcuts.ts";
import { type UndoableDelete } from "./UndoToast.tsx";
import { useRowCursor, useSurfaceShortcuts } from "./useRowCursor.ts";
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

/** The row the caret is on, as the keyboard's actions read it: the cursor is
 * real focus, so the row under it is the row to act on. */
function focusedRow(): { kind: "task" | "series"; id: string } | null {
  const active = document.activeElement;
  if (active === null) return null;
  const series = active.closest<HTMLElement>("[data-series-id]");
  if (series !== null) return { kind: "series", id: series.dataset.seriesId ?? "" };
  const task = active.closest<HTMLElement>("[data-task-id]");
  return task === null ? null : { kind: "task", id: task.dataset.taskId ?? "" };
}

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
  blocks,
  series,
  completions,
  loading,
  today,
  onDeleted,
  openTaskId = null,
  onOpenTaskHandled,
  onNewTask,
}: {
  uid: string;
  tasks: TaskView[];
  /** Every work block in the live store: deleting a task also deletes its
   * task-linked blocks, and undo restores the snapshots captured here. */
  blocks: BlockView[];
  series: SeriesView[];
  completions: Record<string, string>;
  loading: boolean;
  today: string;
  onDeleted: (item: UndoableDelete) => void;
  /** A task the shell asked this surface to reveal, e.g. one the command
   * palette found. Null when nothing is pending. */
  openTaskId?: string | null;
  onOpenTaskHandled?: () => void;
  /** Opens the create sheet, the path the header's New task takes. */
  onNewTask: (origin: HTMLElement | null) => void;
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
  // The keyboard's cursor: real DOM focus on a row's own control, with the
  // list's single tab stop following it. The scope is the list itself, so only
  // this surface answers while it is mounted.
  const listRef = useRef<HTMLDivElement>(null);
  const { activeId, onRowFocus } = useRowCursor(listRef);
  const reduced = useReducedMotion();
  const travel = reduced ? 0 : settleMs;

  /* The estimate lesson's history: the details sheet offers a learned
     pace for the task it shows, exactly as the creation sheet does, so both
     surfaces read one sample list (finished tasks with a recorded pace). */
  const biasSamples = useMemo(() => completedSamples(tasks), [tasks]);

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
      setError(cause instanceof Error ? cause.message : t("tasks.error.generic"));
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
  // One tab stop for the whole list: the row the cursor is on (see
  // ui/shortcuts.ts). The order is the order the rows are rendered in.
  const rowOrder = [...series.map(entry => entry.id), ...open.map(task => task.id), ...completed.map(task => task.id)];

  /* The row actions the shell publishes. Only this surface can perform
     them: it owns the row's write and the offer that takes it back. */
  useSurfaceShortcuts(action => {
    const row = focusedRow();
    if (row === null) return;
    if (action === "complete") {
      if (row.kind === "task") {
        const task = tasks.find(entry => entry.id === row.id);
        if (task !== undefined) completeTask(task, !task.completed);
        return;
      }
      // A repeating task completes the occurrence that is due next, exactly as
      // its own check does.
      const entry = series.find(item => item.id === row.id);
      const next = entry === undefined ? null : nextOccurrence(entry, completions, today);
      if (entry !== undefined && next !== null) void run(() => completeOccurrence(uid, entry.id, next.date));
      return;
    }
    if (action !== "tomorrow" || row.kind !== "task") return;
    const task = tasks.find(entry => entry.id === row.id);
    if (task === undefined) return;
    // `t` is "move to tomorrow": a task that is due today, overdue or undated
    // lands on tomorrow, and one that is already later moves a day ahead -- never
    // earlier, so a press can always be undone by reading the toast.
    const deadline = task.deadline === undefined || task.deadline <= today ? tomorrowKey(today) : tomorrowKey(task.deadline);
    void run(() => setTaskDeadline(uid, task.id, task.title, deadline)).then(() =>
      onDeleted({
        message: t("home.undo.deadlineMoved", { date: formatDateKey(deadline, today) }),
        restore: () => setTaskDeadline(uid, task.id, task.title, task.deadline),
      }),
    );
  });

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
        aria-label={t(task.completed ? "tasks.reopen" : "tasks.complete", { title: task.title })}
        onChange={() => completeTask(task, !task.completed)}
      />
      <button
        type="button"
        className="row-main task-open"
        data-row-cursor={task.id}
        tabIndex={rovingTabIndex(activeId, task.id, rowOrder)}
        onFocus={() => onRowFocus(task.id)}
        onClick={event => {
          setError(null);
          const row = event.currentTarget.closest("li") ?? event.currentTarget;
          // The row grows into the panel; with no view transition (or reduced
          // motion) this is a plain state update and Sheet keeps its own flight.
          morphOpen(() => setSelected({ kind: "task", id: task.id, origin: row }), row);
        }}
      >
        {/* A truncated title still gives the full text on a phone, where there
            is no hover: the title attribute is the only affordance. */}
        <span className="task-title" title={task.title}>{task.title}</span>
        {task.deadline && (
          <span
            className={`row-meta task-deadline${!task.completed && isPastDateKey(task.deadline, today) ? " task-deadline-overdue" : ""}${!task.completed && task.deadline === today ? " task-deadline-today" : ""}`}
          >
            {t("tasks.due", { date: formatDateKey(task.deadline, today) })}
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
          <h2 id="tasks-heading" className="large-title">{t("tasks.title")}</h2>
          {!empty && (
            <p className="subtitle">
              {overdue > 0
                ? t("tasks.summary.openOverdue", { open: tasks.length - completed.length, overdue })
                : t("tasks.summary.open", { open: tasks.length - completed.length })}
            </p>
          )}
        </div>
      </header>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {empty ? (
        <div className="empty-state" role="status">
          <p className="empty-title">{t("tasks.empty.title")}</p>
          <p>{t("tasks.empty.body")}</p>
          <button type="button" className="button button-accent empty-action" onClick={event => onNewTask(event.currentTarget)}>
            <PlusIcon />{t("today.addFirstTask")}
          </button>
        </div>
      ) : (
        <LayoutGroup>
          <div ref={listRef} className="stack task-lists">
            {series.length > 0 && (
              <section className="list-section task-group">
                <h3 className="section-title">
                  {t("tasks.group.repeating")} <span className="heading-count">{series.length}</span>
                </h3>
                <ul className="group task-list">
                  {series.map(seriesRow => {
                    const next = nextOccurrence(seriesRow, completions, today);
                    return (
                      <li
                        key={seriesRow.id}
                        className="row task series-row"
                        data-series-id={seriesRow.id}
                        data-next-occurrence={next?.date ?? ""}
                      >
                        <input
                          type="checkbox"
                          className="check task-check"
                          checked={false}
                          disabled={busy || next === null}
                          aria-label={next === null ? t("tasks.complete", { title: seriesRow.title }) : t("tasks.completeOn", { title: seriesRow.title, date: next.date })}
                          onChange={() => {
                            if (next) void run(() => completeOccurrence(uid, seriesRow.id, next.date));
                          }}
                        />
                        <button
                          type="button"
                          className="row-main task-open"
                          data-row-cursor={seriesRow.id}
                          tabIndex={rovingTabIndex(activeId, seriesRow.id, rowOrder)}
                          onFocus={() => onRowFocus(seriesRow.id)}
                          onClick={event => {
                            setError(null);
                            const row = event.currentTarget.closest("li") ?? event.currentTarget;
                            morphOpen(() => setSelected({ kind: "series", id: seriesRow.id, origin: row }), row);
                          }}
                        >
                          <span className="task-title" title={seriesRow.title}>{seriesRow.title}</span>
                          <span className="row-meta has-icon">
                            <span className="series-frequency">
                              <RepeatIcon className="meta-icon" />
                              <span className="row-meta-text">{t(`tasks.frequency.${seriesRow.frequency}`)}</span>
                            </span>
                            {next && <span className={`task-deadline${next.date === today ? " task-deadline-today" : ""}`}>{t("tasks.next", { date: formatDateKey(next.date, today) })}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {open.length > 0 && group(t("tasks.group.open"), open)}
            {completed.length > 0 && group(t("tasks.group.completed"), completed)}
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
            onEstimateChange={next => void run(() => setSeriesEstimate(uid, selectedSeries.id, next))}
            onFrequencyChange={frequency => void run(() => setSeriesFrequency(uid, selectedSeries.id, frequency, selectedSeries.anchorDate))}
            onAnchorChange={anchorDate => void run(() => setSeriesAnchor(uid, selectedSeries.id, selectedSeries.frequency, anchorDate))}
            onCompleteOccurrence={date => void run(() => completeOccurrence(uid, selectedSeries.id, date))}
            onDelete={() => {
              // Capture the definition before the sheet closes: undo rewrites it
              // under the same id, so its completion history stays attached.
              const deleted = selectedSeries;
              setSelected(null);
              void settle(deleteSeries(uid, deleted.id))
                .then(() => onDeleted({ message: t("tasks.seriesDeleted"), restore: () => restoreSeries(uid, deleted) }))
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
            today={today}
            busy={busy}
            biasSamples={biasSamples}
            onClose={() => morphClose(() => setSelected(null), selected.origin)}
            onRename={next => void run(() => renameTask(uid, selectedTask.id, next))}
            onDeadlineChange={next =>
              void run(() => setTaskDeadline(uid, selectedTask.id, selectedTask.title, next === "" ? undefined : next))
            }
            onToggleCompleted={() => completeTask(selectedTask, !selectedTask.completed)}
            onEstimateChange={next => void run(() => setTaskEstimate(uid, selectedTask.id, next))}
            onDelete={() => {
              // The row's exact fields (title, completion, deadline) travel with
              // the offer: undo rewrites them under the same document id. The
              // task's work blocks are resolved from Firestore at delete time
              // (offline the cache serves the query; review finding 2), so a
              // block another device created after this page rendered still
              // dies with the task — and the query's result is the undo
              // payload.
              const deleted = selectedTask;
              setSelected(null);
              void linkedBlocks(uid, deleted.id)
                .then(deletedBlocks =>
                  settle(deleteTask(uid, deleted.id, deletedBlocks)).then(() => {
                    onDeleted({ message: t("tasks.deleted"), restore: () => restoreTaskWithBlocks(uid, deleted, deletedBlocks) });
                  }),
                )
                .catch((cause: unknown) =>
                  // The batch guard and the rules must be seen: the view's own
                  // error line, not a silent swallow (review finding 3).
                  setError(cause instanceof Error ? cause.message : t("tasks.error.generic")),
                );
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

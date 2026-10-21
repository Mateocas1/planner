import { useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { completeOccurrence } from "../data/series.ts";
import { setBlockTimes } from "../data/blocks.ts";
import type { BlockView, SeriesView, TaskView } from "../data/store.ts";
import { deleteTask, renameTask, restoreTask, setTaskCompleted, setTaskDeadline, setTaskEstimate } from "../data/tasks.ts";
import { WeekRadar } from "./CapacityBar.tsx";
import { completedSamples } from "./BiasHint.tsx";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { RepeatIcon } from "./icons.tsx";
import { phoneQuery, useMediaQuery, useNow } from "./motion.ts";
import { morphClose, morphOpen } from "./morph.ts";
import { PageTurn } from "./PageTurn.tsx";
import { nextOccurrence } from "./Tasks.tsx";
import { TaskDetails } from "./TaskDetails.tsx";
import { MorningBrief } from "./MorningBrief.tsx";
import { PlanMyDay } from "./PlanMyDay.tsx";
import { blockTomorrow, rovingTabIndex, tomorrowKey } from "./shortcuts.ts";
import { bannerVisible } from "./shutdownRitual.ts";
import { dateKey, dayMs, formatDuration, formatWall, keyToWallUtc, timeLabel, wallMinutes } from "./time.ts";
import type { UndoableDelete } from "./UndoToast.tsx";
import { useRowCursor, useSurfaceShortcuts } from "./useRowCursor.ts";
import type { WorkWindow } from "../planning/window.ts";
import { settle } from "./write.ts";

/**
 * Today: the surface that answers "what do I do now, and what comes next?"
 * (DESIGN.md §1). Everything is read in the profile timezone (D3).
 *
 *  - Now: the block running at this minute with its progress, what follows,
 *    and a way to finish the task it belongs to. When nothing is running it
 *    says when the next block starts, or that the day is open.
 *  - This week: how full each day of the planner week already is, and which
 *    deadlines no longer fit (F1), so "Friday is impossible" is visible on
 *    Monday, while something can still be moved.
 *  - Due today: open tasks due today or already overdue, plus repeating
 *    tasks whose next occurrence is today; each can be completed in place.
 *  - Coming up: deadlines in the next seven days.
 *  - Schedule: today's blocks with the free time between them and the now
 *    marker, so the gaps are visible as time that can still be planned.
 *
 * Every row on the page is a row-cursor stop (F6c): `j`/`k` walk them in the
 * order they are painted, and `x`, `t` and Enter act on the focused row with
 * the writes Tasks and Calendar use.
 */
export function Home(props: HomeProps) {
  const { timeZone, loading, profileError } = props;
  // The page's hooks run only once the zone and the data are in, so the
  // placeholder is a plain return with no state of its own.
  if (timeZone === null || loading) {
    return (
      <section className="view" aria-labelledby="home-heading">
        <header className="page-head">
          <h2 id="home-heading" className="large-title">Today</h2>
        </header>
        {profileError ? <p className="inline-error" role="alert">{profileError}</p> : <p className="subtitle" role="status">Loading your planner…</p>}
      </section>
    );
  }
  return <TodayPage {...props} timeZone={timeZone} />;
}

type HomeProps = {
  uid: string;
  loading: boolean;
  tasks: TaskView[];
  blocks: BlockView[];
  series: SeriesView[];
  completions: Record<string, string>;
  timeZone: string | null;
  /** The profile's one working window, read by the morning brief (W1). */
  workWindow: WorkWindow;
  /** Minutes after midnight in the profile zone: when the day is meant to close (F3). */
  shutdownTime: number;
  /** The profile zone's day the ritual was last closed, if it was (F3c). */
  lastShutdown?: string;
  profileError: string | null;
  onOpenCalendar: () => void;
  /** Opens the full-screen glance surface on the current block (F5). */
  onOpenNow: () => void;
  /** Opens the shutdown ritual, from the banner or from a turned page (F3c). */
  onCloseDay: (origin: HTMLElement | null) => void;
  /** Carries the day to tomorrow when the page is turned (F3). Defaults to
   *  opening the ritual: the page turn is the ritual's own first page. */
  onTurnDay?: () => boolean | void | Promise<boolean | void>;
  /** The shell's undo offer, for the moves the keyboard makes here (F6c). */
  onOfferUndo?: (item: UndoableDelete) => void;
};

function TodayPage({
  uid,
  tasks,
  blocks,
  series,
  completions,
  timeZone,
  workWindow,
  shutdownTime,
  lastShutdown,
  onOpenCalendar,
  onOpenNow,
  onCloseDay,
  onTurnDay,
  onOfferUndo,
}: HomeProps & { timeZone: string }) {
  const now = useNow();
  const phone = useMediaQuery(phoneQuery);
  const today = dateKey(now, timeZone);
  const todayUtc = keyToWallUtc(today);
  const weekAhead = formatWallKey(todayUtc + 7 * dayMs);
  const titleOf = (taskId: string | undefined) =>
    taskId === undefined ? undefined : tasks.find(task => task.id === taskId);

  const todayBlocks = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === today)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const nowMs = now.getTime();
  const current = todayBlocks.find(block => Date.parse(block.start) <= nowMs && nowMs < Date.parse(block.end));
  const next = todayBlocks.find(block => Date.parse(block.start) > nowMs);
  const blocksLeft = todayBlocks.filter(block => Date.parse(block.start) > nowMs).length;
  const blockName = (block: BlockView) => titleOf(block.taskId)?.title ?? "Work block";

  const dueTasks = tasks
    .filter(task => !task.completed && task.deadline !== undefined && task.deadline <= today)
    .sort((left, right) => left.deadline!.localeCompare(right.deadline!));
  const dueSeries = series
    .map(entry => ({ entry, next: nextOccurrence(entry, completions, today) }))
    .filter(item => item.next?.date === today);
  const upcoming = tasks
    .filter(task => !task.completed && task.deadline !== undefined && task.deadline > today && task.deadline <= weekAhead)
    .sort((left, right) => left.deadline!.localeCompare(right.deadline!));

  const empty = tasks.length === 0 && blocks.length === 0 && series.length === 0;
  const closing = bannerVisible({ today, wallMinutes: wallMinutes(now, timeZone), shutdownTime, lastShutdown });
  const complete = (task: TaskView) => void settle(setTaskCompleted(uid, task.id, true)).catch(() => undefined);

  /* The row cursor (F6c). `j`/`k` walk the rows below in the order they are
     painted; the shell publishes x, t and Enter, and this page performs them
     with the writes Tasks and Calendar use, so a row means the same thing on
     every page. A move offers the shell's undo, as those pages do. */
  const scope = useRef<HTMLElement>(null);
  const { activeId, onRowFocus } = useRowCursor(scope);
  const [selected, setSelected] = useState<{ id: string; origin: HTMLElement | null } | null>(null);
  const biasSamples = useMemo(() => completedSamples(tasks), [tasks]);
  const openTasks = [...dueTasks, ...upcoming];
  const rowOrder = [
    ...dueTasks.map(task => task.id),
    ...dueSeries.map(item => item.entry.id),
    ...upcoming.map(task => task.id),
    ...todayBlocks.map(block => block.id),
  ];

  const openTask = (task: TaskView, row: HTMLElement) => morphOpen(() => setSelected({ id: task.id, origin: row }), row);

  const moveTaskTomorrow = (task: TaskView) => {
    // `t` is "move to tomorrow": a task due today, overdue or undated lands on
    // tomorrow, and a later one moves a day ahead, never earlier (as on Tasks).
    const deadline = task.deadline === undefined || task.deadline <= today ? tomorrowKey(today) : tomorrowKey(task.deadline);
    void settle(setTaskDeadline(uid, task.id, task.title, deadline))
      .then(() =>
        onOfferUndo?.({
          message: `Deadline moved to ${formatDateKey(deadline, today)}`,
          restore: () => setTaskDeadline(uid, task.id, task.title, task.deadline),
        }),
      )
      .catch(() => undefined);
  };

  const moveBlockTomorrow = (block: BlockView) => {
    const next = blockTomorrow(block, timeZone);
    const day = formatDateKey(dateKey(new Date(next.start), timeZone), today);
    void settle(setBlockTimes(uid, block.id, next.start, next.end))
      .then(() =>
        onOfferUndo?.({
          message: `Block moved to ${day}`,
          restore: () => settle(setBlockTimes(uid, block.id, block.start, block.end)),
        }),
      )
      .catch(() => undefined);
  };

  useSurfaceShortcuts(action => {
    const id = focusedRowId();
    if (id === null) return;
    if (action === "complete") {
      const task = openTasks.find(entry => entry.id === id);
      if (task !== undefined) return complete(task);
      // A repeating row completes the occurrence that is due next, as its check does.
      const occurrence = dueSeries.find(item => item.entry.id === id);
      if (occurrence !== undefined && occurrence.next !== null) {
        void settle(completeOccurrence(uid, occurrence.entry.id, occurrence.next.date)).catch(() => undefined);
      }
      return;
    }
    if (action !== "tomorrow") return;
    const task = openTasks.find(entry => entry.id === id);
    if (task !== undefined) return moveTaskTomorrow(task);
    const block = todayBlocks.find(entry => entry.id === id);
    if (block !== undefined) moveBlockTomorrow(block);
  });

  const selectedTask = selected === null ? undefined : tasks.find(task => task.id === selected.id);

  return (
    <PageTurn
      onTurn={
        onTurnDay ??
        (() => {
          // The turn opens the ritual rather than rolling on its own: what the
          // day left behind is shown before anything is written, and the
          // ritual's own page turn is the commit (F3, criteria 1-5).
          onCloseDay(null);
          return false;
        })
      }
    >
    <section className="view" aria-labelledby="home-heading" ref={scope}>
      <header className="page-head">
        <div>
          <h2 id="home-heading" className="large-title">Today</h2>
          <p className="subtitle">
            {formatWall(todayUtc, { weekday: "long", month: "long", day: "numeric" })}
            {!empty && ` · ${blocksLeft === 0 ? "no blocks left" : `${blocksLeft} ${blocksLeft === 1 ? "block" : "blocks"} left`}`}
          </p>
        </div>
      </header>

      {closing && (
        <section className="shutdown-banner" aria-labelledby="shutdown-banner-text">
          <p id="shutdown-banner-text" className="shutdown-banner-text">Time to close the day.</p>
          {/* Criterion 8: a fine pointer gets a visible action. A thumb turns the
              page instead, which is the gesture the sheet teaches. */}
          {!phone && (
            <button type="button" className="button" onClick={event => onCloseDay(event.currentTarget)}>
              Close day
            </button>
          )}
        </section>
      )}

      {empty ? (
        <div className="empty-state" role="status">
          <p className="empty-title">No tasks and no work blocks yet. Your planner is empty.</p>
          <p>Add a task with New task, then set time aside for it in the calendar.</p>
        </div>
      ) : (
        <div className="today-grid">
          <div className="stack">
            <NowCard
              current={current}
              next={next}
              now={now}
              timeZone={timeZone}
              name={blockName}
              task={current ? titleOf(current.taskId) : undefined}
              onComplete={complete}
              onOpenNow={onOpenNow}
            />

            {/* The first Home of a day says what the day holds (F3, criterion
                7); the Plan my day card directly under it is where the brief's
                action lives. */}
            <MorningBrief blocks={blocks} timeZone={timeZone} workWindow={workWindow} now={now} />

            {/* The brief's plan button (F4): the same proposal and the same
                batch as the Calendar tray, with its own undo because Today
                does not own the shell's offer. */}
            <PlanMyDay
              uid={uid}
              tasks={tasks}
              blocks={blocks}
              timeZone={timeZone}
              now={now}
              variant="brief"
            />

            <WeekRadar
              uid={uid}
              now={now}
              timeZone={timeZone}
              tasks={tasks}
              blocks={blocks}
              series={series}
              completions={completions}
            />

            <section className="list-section" aria-labelledby="due-heading">
              <div className="section-head">
                <h3 id="due-heading" className="section-title">Due today</h3>
                {dueTasks.length + dueSeries.length > 0 && <span className="section-meta">{dueTasks.length + dueSeries.length} left</span>}
              </div>
              {dueTasks.length + dueSeries.length === 0 ? (
                <p className="group group-empty">Nothing due today.</p>
              ) : (
                <ul className="group">
                  {dueTasks.map(task => (
                    <li key={task.id} className="row" data-pending={task.pending ? "true" : "false"}>
                      <input type="checkbox" className="check" checked={false} aria-label={`Complete: ${task.title}`} onChange={() => complete(task)} />
                      <button
                        type="button"
                        className="row-main"
                        data-row-cursor={task.id}
                        tabIndex={rovingTabIndex(activeId, task.id, rowOrder)}
                        onFocus={() => onRowFocus(task.id)}
                        onClick={event => openTask(task, event.currentTarget.closest("li") ?? event.currentTarget)}
                      >
                        <span className="row-title" title={task.title}>{task.title}</span>
                        <span className={`row-meta ${isPastDateKey(task.deadline!, today) ? "is-overdue" : "is-today"}`}>
                          {formatDateKey(task.deadline!, today)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {dueSeries.map(({ entry, next: occurrence }) => (
                    <li key={entry.id} className="row">
                      <input
                        type="checkbox"
                        className="check"
                        checked={false}
                        aria-label={`Complete: ${entry.title} on ${occurrence!.date}`}
                        onChange={() => void settle(completeOccurrence(uid, entry.id, occurrence!.date)).catch(() => undefined)}
                      />
                      <button
                        type="button"
                        className="row-main"
                        data-row-cursor={entry.id}
                        tabIndex={rovingTabIndex(activeId, entry.id, rowOrder)}
                        onFocus={() => onRowFocus(entry.id)}
                      >
                        <span className="row-title" title={entry.title}>{entry.title}</span>
                        <span className="row-meta is-today"><RepeatIcon className="meta-icon" />{entry.frequency === "daily" ? "Daily" : entry.frequency === "weekly" ? "Weekly" : "Monthly"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="list-section" aria-labelledby="upcoming-heading">
              <div className="section-head">
                <h3 id="upcoming-heading" className="section-title">Coming up</h3>
                <span className="section-meta">Next 7 days</span>
              </div>
              {upcoming.length === 0 ? (
                <p className="group group-empty">No deadlines this week.</p>
              ) : (
                <ul className="group">
                  {upcoming.map(task => (
                    <li key={task.id} className="row">
                      <input type="checkbox" className="check" checked={false} aria-label={`Complete: ${task.title}`} onChange={() => complete(task)} />
                      <button
                        type="button"
                        className="row-main"
                        data-row-cursor={task.id}
                        tabIndex={rovingTabIndex(activeId, task.id, rowOrder)}
                        onFocus={() => onRowFocus(task.id)}
                        onClick={event => openTask(task, event.currentTarget.closest("li") ?? event.currentTarget)}
                      >
                        <span className="row-title" title={task.title}>{task.title}</span>
                        <span className="row-meta">{formatDateKey(task.deadline!, today)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="list-section" aria-labelledby="schedule-heading">
            <div className="section-head">
              <h3 id="schedule-heading" className="section-title">Schedule</h3>
              <button type="button" className="link-button" onClick={onOpenCalendar}>Open calendar</button>
            </div>
            <Agenda blocks={todayBlocks} now={now} timeZone={timeZone} name={blockName} activeId={activeId} order={rowOrder} onRowFocus={onRowFocus} />
          </section>
        </div>
      )}
      <AnimatePresence>
        {selectedTask && selected && (
          <TaskDetails
            key={selectedTask.id}
            task={selectedTask}
            origin={selected.origin}
            shared
            busy={false}
            biasSamples={biasSamples}
            onClose={() => morphClose(() => setSelected(null), selected.origin)}
            onRename={next => void settle(renameTask(uid, selectedTask.id, next)).catch(() => undefined)}
            onDeadlineChange={next =>
              void settle(setTaskDeadline(uid, selectedTask.id, selectedTask.title, next === "" ? undefined : next)).catch(() => undefined)
            }
            onToggleCompleted={() => void settle(setTaskCompleted(uid, selectedTask.id, !selectedTask.completed)).catch(() => undefined)}
            onEstimateChange={next => void settle(setTaskEstimate(uid, selectedTask.id, next)).catch(() => undefined)}
            onDelete={() => {
              // The row's exact fields travel with the offer, as on Tasks: undo
              // rewrites them under the same document id.
              const deleted = selectedTask;
              setSelected(null);
              void settle(deleteTask(uid, deleted.id))
                .then(() => onOfferUndo?.({ message: "Task deleted", restore: () => restoreTask(uid, deleted) }))
                .catch(() => undefined);
            }}
          />
        )}
      </AnimatePresence>
    </section>
    </PageTurn>
  );
}

/** The row-cursor control the caret is on, by its marker (F6c). */
function focusedRowId(): string | null {
  const active = document.activeElement;
  return active === null ? null : active.closest<HTMLElement>("[data-row-cursor]")?.dataset.rowCursor ?? null;
}

function formatWallKey(wallUtc: number): string {
  return new Date(wallUtc).toISOString().slice(0, 10);
}

function NowCard({
  current,
  next,
  now,
  timeZone,
  name,
  task,
  onComplete,
  onOpenNow,
}: {
  current: BlockView | undefined;
  next: BlockView | undefined;
  now: Date;
  timeZone: string;
  name: (block: BlockView) => string;
  task: TaskView | undefined;
  onComplete: (task: TaskView) => void;
  onOpenNow: () => void;
}) {
  const range = (block: BlockView) => `${timeLabel(new Date(block.start), timeZone)} – ${timeLabel(new Date(block.end), timeZone)}`;

  if (current) {
    const start = Date.parse(current.start);
    const end = Date.parse(current.end);
    const elapsed = (now.getTime() - start) / 60_000;
    const total = (end - start) / 60_000;
    return (
      <article className="card now-card" aria-labelledby="now-title">
        <p className={`now-label${current.taskId ? " for-task" : ""}`}><span className="now-dot" aria-hidden="true" />Now</p>
        <h3 id="now-title" className="now-title">{name(current)}</h3>
        <p className="now-when">{range(current)}</p>
        <div className={`progress${current.taskId ? " for-task" : ""}`} aria-hidden="true">
          <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, elapsed / total))})` }} />
        </div>
        <div className="progress-row">
          <span>{formatDuration(elapsed)} in</span>
          <span>{formatDuration(total - elapsed)} left</span>
        </div>
        <div className="now-foot">
          {next && (
            <p className="now-next">
              Next <b>{name(next)}</b> at {timeLabel(new Date(next.start), timeZone)}
            </p>
          )}
          {task && !task.completed && (
            <button type="button" className="button" onClick={() => onComplete(task)}>
              Mark task done
            </button>
          )}
          <button type="button" className="link-button" onClick={onOpenNow}>Full screen</button>
        </div>
      </article>
    );
  }
  if (next) {
    const minutes = (Date.parse(next.start) - now.getTime()) / 60_000;
    return (
      <article className="card now-card" aria-labelledby="now-title">
        <p className="now-label is-free">Free now</p>
        <h3 id="now-title" className="now-title">{name(next)}</h3>
        <p className="now-when">Starts at {timeLabel(new Date(next.start), timeZone)}, in {formatDuration(minutes)}</p>
        <button type="button" className="link-button" onClick={onOpenNow}>Full screen</button>
      </article>
    );
  }
  return (
    <article className="card now-card" aria-labelledby="now-title">
      <p className="now-label is-free">Nothing scheduled</p>
      <h3 id="now-title" className="now-title">The rest of today is open</h3>
      <p className="now-when">Plan a work block from the calendar when you are ready.</p>
      <button type="button" className="link-button" onClick={onOpenNow}>Full screen</button>
    </article>
  );
}

/** Today's blocks in order, with the free gaps between upcoming ones and the
 * now marker placed where the current minute falls. */
function Agenda({
  blocks,
  now,
  timeZone,
  name,
  activeId,
  order,
  onRowFocus,
}: {
  blocks: BlockView[];
  now: Date;
  timeZone: string;
  name: (block: BlockView) => string;
  /** The row cursor's position and the page's row order (F6c). */
  activeId: string | null;
  order: readonly string[];
  onRowFocus: (id: string) => void;
}) {
  if (blocks.length === 0) return <p className="group group-empty">No work blocks today.</p>;
  const nowMs = now.getTime();
  const items: React.ReactNode[] = [];
  let placedNow = false;
  let cursor: number | null = null;
  const nowRow = (
    <li key="now" className="agenda-now" aria-label={`Now, ${timeLabel(now, timeZone)}`}>
      <time>{timeLabel(now, timeZone)}</time>
      <span className="agenda-now-line" aria-hidden="true" />
    </li>
  );
  for (const block of blocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    if (!placedNow && start > nowMs) {
      items.push(nowRow);
      placedNow = true;
    }
    if (cursor !== null && start > nowMs) {
      const gap = (start - Math.max(cursor, nowMs)) / 60_000;
      if (gap >= 30) items.push(<li key={`gap-${block.id}`} className="agenda-gap">Free for {formatDuration(gap)}</li>);
    }
    items.push(
      <li key={block.id} className={`agenda-item${end <= nowMs ? " is-past" : ""}`}>
        <time>{timeLabel(new Date(block.start), timeZone)}</time>
        <button
          type="button"
          className={`event ${block.taskId ? "cat-task" : "cat-focus"}${block.pending ? " is-pending" : ""}`}
          style={{ display: "block", width: "100%", textAlign: "start" }}
          data-row-cursor={block.id}
          tabIndex={rovingTabIndex(activeId, block.id, order)}
          onFocus={() => onRowFocus(block.id)}
        >
          <b>{name(block)}</b>
          <span>{timeLabel(new Date(block.start), timeZone)} – {timeLabel(new Date(block.end), timeZone)}</span>
        </button>
      </li>,
    );
    cursor = Math.max(cursor ?? 0, end);
  }
  if (!placedNow) items.push(nowRow);
  return <ol className="card agenda">{items}</ol>;
}

import { completeOccurrence } from "../data/series.ts";
import type { BlockView, SeriesView, TaskView } from "../data/store.ts";
import { setTaskCompleted } from "../data/tasks.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { RepeatIcon } from "./icons.tsx";
import { useNow } from "./motion.ts";
import { nextOccurrence } from "./Tasks.tsx";
import { dateKey, dayMs, formatDuration, formatWall, keyToWallUtc, timeLabel } from "./time.ts";
import { settle } from "./write.ts";

/**
 * Today: the surface that answers "what do I do now, and what comes next?"
 * (DESIGN.md §1). Everything is read in the profile timezone (D3).
 *
 *  - Now: the block running at this minute with its progress, what follows,
 *    and a way to finish the task it belongs to. When nothing is running it
 *    says when the next block starts, or that the day is open.
 *  - Due today: open tasks due today or already overdue, plus repeating
 *    tasks whose next occurrence is today; each can be completed in place.
 *  - Coming up: deadlines in the next seven days.
 *  - Schedule: today's blocks with the free time between them and the now
 *    marker, so the gaps are visible as time that can still be planned.
 */
export function Home({
  uid,
  loading,
  tasks,
  blocks,
  series,
  completions,
  timeZone,
  profileError,
  onOpenCalendar,
}: {
  uid: string;
  loading: boolean;
  tasks: TaskView[];
  blocks: BlockView[];
  series: SeriesView[];
  completions: Record<string, string>;
  timeZone: string | null;
  profileError: string | null;
  onOpenCalendar: () => void;
}) {
  const now = useNow();

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
  const complete = (task: TaskView) => void settle(setTaskCompleted(uid, task.id, true)).catch(() => undefined);

  return (
    <section className="view" aria-labelledby="home-heading">
      <header className="page-head">
        <div>
          <h2 id="home-heading" className="large-title">Today</h2>
          <p className="subtitle">
            {formatWall(todayUtc, { weekday: "long", month: "long", day: "numeric" })}
            {!empty && ` · ${blocksLeft === 0 ? "no blocks left" : `${blocksLeft} ${blocksLeft === 1 ? "block" : "blocks"} left`}`}
          </p>
        </div>
      </header>

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
                      <span className="row-main">
                        <span className="row-title" title={task.title}>{task.title}</span>
                        <span className={`row-meta ${isPastDateKey(task.deadline!, today) ? "is-overdue" : "is-today"}`}>
                          {formatDateKey(task.deadline!, today)}
                        </span>
                      </span>
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
                      <span className="row-main">
                        <span className="row-title" title={entry.title}>{entry.title}</span>
                        <span className="row-meta is-today"><RepeatIcon className="meta-icon" />{entry.frequency === "daily" ? "Daily" : entry.frequency === "weekly" ? "Weekly" : "Monthly"}</span>
                      </span>
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
                      <span className="row-main">
                        <span className="row-title" title={task.title}>{task.title}</span>
                        <span className="row-meta">{formatDateKey(task.deadline!, today)}</span>
                      </span>
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
            <Agenda blocks={todayBlocks} now={now} timeZone={timeZone} name={blockName} />
          </section>
        </div>
      )}
    </section>
  );
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
}: {
  current: BlockView | undefined;
  next: BlockView | undefined;
  now: Date;
  timeZone: string;
  name: (block: BlockView) => string;
  task: TaskView | undefined;
  onComplete: (task: TaskView) => void;
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
        {(next || (task && !task.completed)) && (
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
          </div>
        )}
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
      </article>
    );
  }
  return (
    <article className="card now-card" aria-labelledby="now-title">
      <p className="now-label is-free">Nothing scheduled</p>
      <h3 id="now-title" className="now-title">The rest of today is open</h3>
      <p className="now-when">Plan a work block from the calendar when you are ready.</p>
    </article>
  );
}

/** Today's blocks in order, with the free gaps between upcoming ones and the
 * now marker placed where the current minute falls. */
function Agenda({ blocks, now, timeZone, name }: { blocks: BlockView[]; now: Date; timeZone: string; name: (block: BlockView) => string }) {
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
        <div className={`event ${block.taskId ? "cat-task" : "cat-focus"}${block.pending ? " is-pending" : ""}`}>
          <b>{name(block)}</b>
          <span>{timeLabel(new Date(block.start), timeZone)} – {timeLabel(new Date(block.end), timeZone)}</span>
        </div>
      </li>,
    );
    cursor = Math.max(cursor ?? 0, end);
  }
  if (!placedNow) items.push(nowRow);
  return <ol className="card agenda">{items}</ol>;
}

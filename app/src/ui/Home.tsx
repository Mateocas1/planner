import type { BlockView, SeriesView, TaskView } from "../data/store.ts";

/**
 * The Home surface: a row of stat cards, each one a real fact the planner
 * holds — no derived deltas or invented percentages, because the store keeps
 * no history. "Today" and "this week" are the profile timezone's calendar
 * days (D3), never the browser's.
 *
 * Two sibling sections sit below the cards, both a shared heading over one
 * card of list rows (D2). "Today" lists the open tasks due today and the work
 * blocks starting today. "This week" groups the week's work blocks by their
 * profile-zone day, showing each block's time range and the linked task when
 * one exists (D1). Every row is real store state; a day with no blocks is
 * omitted rather than padded with placeholder rows.
 *
 * When every fact is zero the surface stays calm: the card row is replaced by
 * a single empty sentence and each section says plainly that its day or week
 * is clear.
 */

const dayMs = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

type WallDate = { year: number; month: number; day: number };

/** Wall-clock date parts of an instant in a named IANA zone. */
function wallDate(date: Date, timeZone: string): WallDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Date key (YYYY-MM-DD) of an instant in the given zone. */
function dateKey(date: Date, timeZone: string): string {
  const parts = wallDate(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Date key of a zone wall date read as UTC midnight (a day counter). */
function wallDayKey(wallUtc: number): string {
  const date = new Date(wallUtc);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Wall-clock HH:MM of an instant in the given zone. */
function wallTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("hour").padStart(2, "0")}:${get("minute")}`;
}

/** Weekday name of a wall-UTC day counter (read as UTC, never through a zone). */
function weekdayName(wallUtc: number): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(wallUtc));
}

type WeekDay = { key: string; label: string; blocks: BlockView[] };

export function Home({ loading, tasks, blocks, series, timeZone, profileError }: {
  loading: boolean;
  tasks: TaskView[];
  blocks: BlockView[];
  series: SeriesView[];
  timeZone: string | null;
  profileError: string | null;
}) {
  if (timeZone === null || loading) {
    return (
      <section className="home" aria-labelledby="home-heading">
        <header className="page-head">
          <h2 id="home-heading">Home</h2>
        </header>
        {profileError ? <p role="alert">{profileError}</p> : <p role="status">Loading your planner…</p>}
      </section>
    );
  }

  const now = wallDate(new Date(), timeZone);
  const today = `${now.year}-${pad(now.month)}-${pad(now.day)}`;
  const todayUtc = Date.UTC(now.year, now.month - 1, now.day);
  const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * dayMs;

  const open = tasks.filter(task => !task.completed).length;
  const completed = tasks.length - open;
  const dueToday = tasks.filter(task => !task.completed && task.deadline === today);

  // The profile week's work blocks, Monday first, each day carrying only the
  // blocks that fall on it in the profile zone. A day with no blocks is
  // dropped so the digest never shows a placeholder row.
  const weekDays: WeekDay[] = Array.from({ length: 7 }, (_, index) => {
    const utc = mondayUtc + index * dayMs;
    const key = wallDayKey(utc);
    return {
      key,
      label: weekdayName(utc),
      blocks: blocks
        .filter(block => dateKey(new Date(block.start), timeZone) === key)
        .sort((left, right) => Date.parse(left.start) - Date.parse(right.start)),
    };
  }).filter(day => day.blocks.length > 0);
  const weekBlocks = weekDays.reduce((total, day) => total + day.blocks.length, 0);

  const cards = [
    { key: "open", label: "Open tasks", value: open, note: "not completed" },
    { key: "completed", label: "Completed", value: completed, note: "marked done" },
    { key: "due", label: "Due today", value: dueToday.length, note: "deadline today" },
    { key: "week", label: "Work blocks", value: weekBlocks, note: "this week" },
    { key: "series", label: "Repeating", value: series.length, note: "series defined" },
  ];

  // Today's blocks in the profile zone, earliest first. An unlinked block
  // carries no title; it shows its time only, never a placeholder.
  const todayBlocks = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === today)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));

  const titleOf = (taskId: string | undefined) =>
    taskId === undefined ? null : tasks.find(task => task.id === taskId)?.title ?? null;

  const blockTime = (block: BlockView) =>
    `${wallTime(new Date(block.start), timeZone)}–${wallTime(new Date(block.end), timeZone)}`;

  const empty = cards.every(card => card.value === 0);

  return (
    <section className="home" aria-labelledby="home-heading">
      <header className="page-head">
        <h2 id="home-heading">Home</h2>
      </header>

      {empty ? (
        <p className="empty-note" role="status">No tasks and no work blocks yet. Your planner is empty.</p>
      ) : (
        <ul className="stat-cards">
          {cards.map(card => (
            <li key={card.key} className="stat-card" data-stat={card.key}>
              <span className="stat-card-label">{card.label}</span>
              <span className="stat-card-value">{card.value}</span>
              <span className="stat-card-note">{card.note}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="home-section" aria-labelledby="home-today-heading">
        <h3 id="home-today-heading" className="section-heading">Today</h3>
        <div className="card">
          <div className="card-group">
            <h4 className="card-group-heading">Tasks due</h4>
            {dueToday.length === 0 ? (
              <p className="card-empty">Nothing due today.</p>
            ) : (
              <ul className="card-rows">
                {dueToday.map(task => (
                  <li key={task.id} className="card-row">
                    <span className="card-row-title">{task.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card-group">
            <h4 className="card-group-heading">Work blocks</h4>
            {todayBlocks.length === 0 ? (
              <p className="card-empty">No work blocks today.</p>
            ) : (
              <ul className="card-rows">
                {todayBlocks.map(block => {
                  const title = titleOf(block.taskId);
                  return (
                    <li key={block.id} className="card-row">
                      <span className="card-row-time">{blockTime(block)}</span>
                      {title !== null && <span className="card-row-title">{title}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="home-section" aria-labelledby="home-week-heading">
        <h3 id="home-week-heading" className="section-heading">This week</h3>
        <div className="card">
          {weekDays.length === 0 ? (
            <p className="card-empty">No work blocks this week.</p>
          ) : (
            /* the day groups flow into two balanced columns on a wide
               viewport; the reading order stays Monday to Sunday */
            <div className="week-digest">
              {weekDays.map(day => (
                <div key={day.key} className="card-group">
                  <h4 className="card-group-heading">{day.label}</h4>
                  <ul className="card-rows">
                    {day.blocks.map(block => {
                      const title = titleOf(block.taskId);
                      return (
                        <li key={block.id} className="card-row">
                          <span className="card-row-time">{blockTime(block)}</span>
                          {title !== null && <span className="card-row-title">{title}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

import type { BlockView, SeriesView, TaskView } from "../data/store.ts";

/**
 * The Home surface: a row of stat cards, each one a real fact the planner
 * holds — no derived deltas or invented percentages, because the store keeps
 * no history. "Today" and "this week" are the profile timezone's calendar
 * days (D3), never the browser's. When every fact is zero the surface stays
 * calm: the card row is replaced by the single empty sentence, so an empty
 * planner does not read as a dashboard of five zeroes.
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
      <section aria-labelledby="home-heading">
        <h2 id="home-heading">Home</h2>
        {profileError ? <p role="alert">{profileError}</p> : <p role="status">Loading your planner…</p>}
      </section>
    );
  }

  const now = wallDate(new Date(), timeZone);
  const today = `${now.year}-${pad(now.month)}-${pad(now.day)}`;
  const todayUtc = Date.UTC(now.year, now.month - 1, now.day);
  const mondayUtc = todayUtc - ((new Date(todayUtc).getUTCDay() + 6) % 7) * dayMs;
  const weekKeys = new Set(Array.from({ length: 7 }, (_, index) => wallDayKey(mondayUtc + index * dayMs)));

  const open = tasks.filter(task => !task.completed).length;
  const completed = tasks.length - open;
  const dueToday = tasks.filter(task => !task.completed && task.deadline === today).length;
  const weekBlocks = blocks.filter(block => weekKeys.has(dateKey(new Date(block.start), timeZone))).length;
  const seriesCount = series.length;

  const cards = [
    { key: "open", label: "Open tasks", value: open, note: "not completed" },
    { key: "completed", label: "Completed", value: completed, note: "marked done" },
    { key: "due", label: "Due today", value: dueToday, note: "deadline today" },
    { key: "week", label: "Work blocks", value: weekBlocks, note: "this week" },
    { key: "series", label: "Repeating", value: seriesCount, note: "series defined" },
  ];

  if (cards.every(card => card.value === 0)) {
    return (
      <section aria-labelledby="home-heading">
        <h2 id="home-heading">Home</h2>
        <p role="status">No tasks and no work blocks yet. Your planner is empty.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="home-heading">
      <h2 id="home-heading">Home</h2>
      <ul className="stat-cards">
        {cards.map(card => (
          <li key={card.key} className="stat-card" data-stat={card.key}>
            <span className="stat-card-label">{card.label}</span>
            <span className="stat-card-value">{card.value}</span>
            <span className="stat-card-note">{card.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

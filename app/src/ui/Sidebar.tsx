import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { View } from "../App.tsx";
import type { BlockView } from "../data/store.ts";
import { CalendarIcon, ChevronLeft, ChevronRight, CloudIcon, CloudOffIcon, TasksIcon, TodayIcon } from "./icons.tsx";
import { spring } from "./motion.ts";
import { dateKey, dayMs, formatWall, keyToWallUtc, mondayOf, wallDayKey } from "./time.ts";

export const views: { id: View; label: string; Icon: typeof TodayIcon }[] = [
  { id: "home", label: "Today", Icon: TodayIcon },
  { id: "tasks", label: "Tasks", Icon: TasksIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarIcon },
];

/** Whether the browser reports a network connection; follows changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** Sync status in the product's own words: what is safe, and where. */
export function SyncStatus({ pending }: { pending: number }) {
  const online = useOnline();
  const offline = !online;
  const text = offline
    ? "Offline · changes are kept on this device"
    : pending > 0
      ? `Syncing ${pending} ${pending === 1 ? "change" : "changes"}…`
      : "Synced · works offline";
  return (
    <p className={`sync${offline ? " is-offline" : pending > 0 ? " is-pending" : ""}`} role="status">
      {offline ? <CloudOffIcon /> : <CloudIcon />}
      <span>{text}</span>
    </p>
  );
}

/**
 * The desktop sidebar: a quiet glass material holding the month, the view
 * navigation (nav "Main", the name the browser tests address) with a pill that
 * slides to the active view, the sync status and the account.
 */
export function Sidebar({
  email,
  view,
  openCount,
  pending,
  blocks,
  timeZone,
  selectedDay,
  onNavigate,
  onPickDay,
  onSignOut,
}: {
  email: string;
  view: View;
  openCount: number;
  pending: number;
  blocks: BlockView[];
  timeZone: string | null;
  selectedDay: string | null;
  onNavigate: (view: View) => void;
  onPickDay: (key: string) => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="sidebar glass glass-chrome">
      {timeZone && <MiniMonth blocks={blocks} timeZone={timeZone} selectedDay={selectedDay} onPickDay={onPickDay} />}
      <nav aria-label="Main" className="side-nav">
        {views.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            aria-current={view === id ? "page" : undefined}
            data-sheen={view === id ? "" : undefined}
            onClick={() => onNavigate(id)}
          >
            {view === id && <motion.span layoutId="nav-pill" className="nav-pill glass-lens" transition={spring.snappy} aria-hidden="true" />}
            <Icon className="nav-icon" />
            <span className="nav-label">{label}</span>
            {id === "tasks" && openCount > 0 && (
              <span className="nav-count">
                {openCount}
                <span className="sr-only"> open</span>
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <SyncStatus pending={pending} />
        <div className="account">
          <span className="who" title={email}>Signed in as {email}</span>
          <button type="button" className="link-button" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}

/** The month in the sidebar: dots mark days with blocks, today is marked in
 * the now colour, the calendar's selected day is filled. A day opens in the
 * calendar. */
function MiniMonth({
  blocks,
  timeZone,
  selectedDay,
  onPickDay,
}: {
  blocks: BlockView[];
  timeZone: string;
  selectedDay: string | null;
  onPickDay: (key: string) => void;
}) {
  const todayKey = dateKey(new Date(), timeZone);
  const selected = selectedDay ?? todayKey;
  const [month, setMonth] = useState(() => selected.slice(0, 7));

  // follow the calendar when it moves to another month
  useEffect(() => setMonth(selected.slice(0, 7)), [selected]);

  const first = keyToWallUtc(`${month}-01`);
  const start = mondayOf(first);
  const blockDays = new Set(blocks.map(block => dateKey(new Date(block.start), timeZone)));
  const shift = (delta: number) => {
    const date = new Date(first);
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(wallDayKey(date.getTime()).slice(0, 7));
  };

  return (
    <section className="mini-month" aria-label="Month">
      <div className="mini-head">
        <p className="mini-title">
          {formatWall(first, { month: "long" })} <span>{formatWall(first, { year: "numeric" })}</span>
        </p>
        <div className="mini-nav">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></button>
          <button type="button" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></button>
        </div>
      </div>
      <div className="mini-grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((letter, index) => (
          <span key={index} className="mini-dow" aria-hidden="true">{letter}</span>
        ))}
        {Array.from({ length: 42 }, (_, index) => {
          const utc = start + index * dayMs;
          const key = wallDayKey(utc);
          const classes = [
            "mini-day",
            key.slice(0, 7) !== month && "is-out",
            key === todayKey && "is-today",
            key === selected && "is-selected",
            blockDays.has(key) && "has-blocks",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={key}
              type="button"
              className={classes}
              aria-label={formatWall(utc, { weekday: "long", month: "long", day: "numeric" })}
              aria-pressed={key === selected}
              onClick={() => onPickDay(key)}
            >
              {formatWall(utc, { day: "numeric" })}
            </button>
          );
        })}
      </div>
    </section>
  );
}

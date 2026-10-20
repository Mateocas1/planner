import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "motion/react";
import type { View } from "../App.tsx";
import type { BlockView, TaskView } from "../data/store.ts";
import { setTaskCompleted } from "../data/tasks.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { CalendarIcon, ChevronLeft, ChevronRight, TasksIcon, TodayIcon } from "./icons.tsx";
import { spring, useNow } from "./motion.ts";
import { SyncStatus } from "./SyncStatus.tsx";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme.ts";
import { dateKey, dayMs, formatDuration, formatWall, keyToWallUtc, mondayOf, timeLabel, wallDayKey } from "./time.ts";
import { settle } from "./write.ts";
// The sidebar's own content (value roadmap §3) ships its styles beside it, so
// this unit never edits the shared sheet it would collide with.
import "./Sidebar.css";

export const views: { id: View; label: string; Icon: typeof TodayIcon }[] = [
  { id: "home", label: "Today", Icon: TodayIcon },
  { id: "tasks", label: "Tasks", Icon: TasksIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarIcon },
];

/**
 * The desktop sidebar: a quiet glass material holding the month, the view
 * navigation (nav "Main", the name the browser tests address) with a pill that
 * slides to the active view, the two blocks that answer "what comes next"
 * (value roadmap §3), and one dense footer row with the sync line, the account
 * and the theme control.
 *
 * The content blocks exist only here: the sidebar is visible on Tasks and
 * Calendar, where Home's now-card and due list are not. Everything they show is
 * derived from data the store already holds, in the profile timezone (D3).
 */
export function Sidebar({
  email,
  uid,
  view,
  openCount,
  pending,
  tasks,
  blocks,
  timeZone,
  selectedDay,
  onNavigate,
  onPickDay,
  onOpenTask,
  onSignOut,
  onImport,
}: {
  email: string;
  uid: string;
  view: View;
  openCount: number;
  pending: number;
  tasks: TaskView[];
  blocks: BlockView[];
  timeZone: string | null;
  selectedDay: string | null;
  onNavigate: (view: View) => void;
  onPickDay: (key: string) => void;
  onOpenTask: (taskId: string) => void;
  onSignOut: () => void;
  /** Opens the Google Calendar import; the pressed control is its origin. */
  onImport: (origin: HTMLElement) => void;
}) {
  return (
    <aside className="sidebar glass glass-regular">
      {timeZone && <MiniMonth blocks={blocks} timeZone={timeZone} selectedDay={selectedDay} onPickDay={onPickDay} />}
      <nav aria-label="Main" className="side-nav">
        {views.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            aria-current={view === id ? "page" : undefined}
            {...(id === "calendar" ? { "data-drop-nav": "calendar" } : {})}
            data-sheen={view === id ? "" : undefined}
            onClick={() => onNavigate(id)}
          >
            {view === id && <motion.span layoutId="nav-pill" className="nav-pill" transition={spring.snappy} aria-hidden="true" />}
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
      {timeZone && (
        <>
          <UpNext blocks={blocks} tasks={tasks} timeZone={timeZone} />
          <DueSoon uid={uid} tasks={tasks} timeZone={timeZone} onOpenTask={onOpenTask} />
        </>
      )}
      <div className="side-foot">
        <SyncStatus pending={pending} />
        <div className="side-foot-row">
          {/* The address is what the row is for: "Signed in as" stays in the
              accessible name only, so the email itself gets the width. */}
          <span className="who" title={email}><span className="sr-only">Signed in as </span>{email}</span>
          <ThemeSwitch />
        </div>
        {/* Two links on one row: the import entry is a footer action like Sign
            out, and it costs no height there, which is what keeps the chrome
            inside a short window. The sidebar's stylesheet belongs to the
            sidebar-fill unit, so this row is laid out inline. */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", whiteSpace: "nowrap" }}>
          <button type="button" className="link-button side-signout" onClick={event => onImport(event.currentTarget)}>
            Import from Google Calendar
          </button>
          <button type="button" className="link-button side-signout" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}

/* ---------- the two content blocks ---------- */

/** The block's own name: the task it belongs to, or the product's word for an
 * unlinked block (`Calendar.tsx` uses the same wording). */
function blockTitle(block: BlockView, tasks: TaskView[]): string {
  return tasks.find(task => task.id === block.taskId)?.title ?? "Work block";
}

/** "14:00 – 15:00" in the profile zone. */
function blockRange(block: BlockView, timeZone: string): string {
  return `${timeLabel(new Date(block.start), timeZone)} – ${timeLabel(new Date(block.end), timeZone)}`;
}

/**
 * Up next: the block running at this minute, then the next one still to start
 * today. Two rows at most -- this is a hint about what comes next, not a
 * second agenda. Nothing to add a timer to here: the focus timer is its own
 * unit (value roadmap §5 row 5).
 */
function UpNext({ blocks, tasks, timeZone }: { blocks: BlockView[]; tasks: TaskView[]; timeZone: string }) {
  const now = useNow();
  const nowMs = now.getTime();
  const today = dateKey(now, timeZone);
  const todayBlocks = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === today)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const current = todayBlocks.find(block => Date.parse(block.start) <= nowMs && nowMs < Date.parse(block.end));
  const next = todayBlocks.find(block => Date.parse(block.start) > nowMs);
  const rows = [
    ...(current ? [{ block: current, running: true }] : []),
    ...(next ? [{ block: next, running: false }] : []),
  ];

  return (
    <section className="side-block side-up-next" aria-labelledby="side-up-next-heading">
      <h3 id="side-up-next-heading" className="side-label">Up next</h3>
      {rows.length === 0 ? (
        <p className="side-empty">Nothing else today.</p>
      ) : (
        <ul className="side-card">
          {rows.map(({ block, running }) => (
            <li key={block.id} className={`side-row${running ? " is-now" : ""}`}>
              <p className="side-row-title" title={blockTitle(block, tasks)}>{blockTitle(block, tasks)}</p>
              <p className="side-row-meta">
                {running ? "now" : `in ${formatDuration((Date.parse(block.start) - nowMs) / 60_000)}`}
                {" · "}
                {blockRange(block, timeZone)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Due soon: the next five open deadlines, overdue first, capped so the block
 * never becomes a second task list. Each row can be completed in place and
 * opens the task's own panel on the Tasks surface.
 */
function DueSoon({
  uid,
  tasks,
  timeZone,
  onOpenTask,
}: {
  uid: string;
  tasks: TaskView[];
  timeZone: string;
  onOpenTask: (taskId: string) => void;
}) {
  const now = useNow();
  const today = dateKey(now, timeZone);
  const weekAhead = wallDayKey(keyToWallUtc(today) + 7 * dayMs);
  const due = tasks
    .filter(task => !task.completed && task.deadline !== undefined && task.deadline <= weekAhead)
    .sort((left, right) => left.deadline!.localeCompare(right.deadline!) || left.title.localeCompare(right.title))
    .slice(0, 5);
  const complete = (task: TaskView) => void settle(setTaskCompleted(uid, task.id, true)).catch(() => undefined);

  return (
    <section className="side-block side-due" aria-labelledby="side-due-heading">
      <h3 id="side-due-heading" className="side-label">Due soon</h3>
      {due.length === 0 ? (
        <p className="side-empty">Nothing due this week.</p>
      ) : (
        <ul className="side-card">
          {due.map(task => {
            const overdue = isPastDateKey(task.deadline!, today);
            return (
              <li key={task.id} className="side-due-row" data-pending={task.pending ? "true" : "false"}>
                <input
                  type="checkbox"
                  className="check"
                  checked={false}
                  aria-label={`Complete: ${task.title}`}
                  onChange={() => complete(task)}
                />
                <button type="button" className="side-due-open" onClick={() => onOpenTask(task.id)}>
                  <span className="side-due-title" title={task.title}>{task.title}</span>
                  <span className={`side-due-meta${overdue ? " is-overdue" : ""}`}>
                    {overdue ? `Overdue · ${formatDateKey(task.deadline!, today)}` : formatDateKey(task.deadline!, today)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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

/* ---------- theme ---------- */

/**
 * The three values of the theme switch, in the order the control shows them.
 * System is the default: the page follows the OS until the user picks one.
 */
const themeOptions: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * The theme icons. They live here, beside the control that uses them, because
 * the sidebar footer row that will host this switch is the next unit (value
 * roadmap §4); when the control moves into its own module, these move with it.
 * Same stroke family as ui/icons.tsx, drawn on the same 24 px grid.
 */
type ThemeIconProps = { className?: string };

const themeIconBase = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function MonitorIcon({ className }: ThemeIconProps) {
  return (
    <svg {...themeIconBase} strokeWidth={1.7} className={className}>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2.5" />
      <path d="M9 21h6M12 17v4" />
    </svg>
  );
}

function SunIcon({ className }: ThemeIconProps) {
  return (
    <svg {...themeIconBase} strokeWidth={1.7} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  );
}

function MoonIcon({ className }: ThemeIconProps) {
  return (
    <svg {...themeIconBase} strokeWidth={1.7} className={className}>
      <path d="M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.6 8.6 0 1 0 11.3 11.3Z" />
    </svg>
  );
}

/** The icon for one theme value: monitor, sun or moon. */
export function ThemeIcon({ preference, className }: { preference: ThemePreference; className?: string }) {
  if (preference === "light") return <SunIcon className={className} />;
  if (preference === "dark") return <MoonIcon className={className} />;
  return <MonitorIcon className={className} />;
}

/**
 * System / Light / Dark as a native radiogroup: one tab stop (the checked
 * radio), arrow keys move the selection and therefore the theme, exactly like a
 * native radio set. The switch itself is the same paint the inline script does at
 * load, so the page flips without a transition (see app.css).
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const preference = useThemePreference();
  const groupRef = useRef<HTMLDivElement>(null);

  function choose(next: ThemePreference) {
    setThemePreference(next);
    /* Keyboard selection takes focus with it; a click already has it. */
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
    buttons?.[themeOptions.findIndex(option => option.id === next)]?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = themeOptions.findIndex(option => option.id === preference);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % themeOptions.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + themeOptions.length) % themeOptions.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = themeOptions.length - 1;
    if (next === null) return;
    event.preventDefault();
    choose(themeOptions[next].id);
  }

  return (
    <div
      ref={groupRef}
      className={`theme-switch${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
    >
      {themeOptions.map(option => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={preference === option.id}
          tabIndex={preference === option.id ? 0 : -1}
          onClick={() => choose(option.id)}
        >
          <ThemeIcon preference={option.id} />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "motion/react";
import type { View } from "../App.tsx";
import type { BlockView } from "../data/store.ts";
import { CalendarIcon, ChevronLeft, ChevronRight, TasksIcon, TodayIcon } from "./icons.tsx";
import { spring } from "./motion.ts";
import { SyncStatus } from "./SyncStatus.tsx";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme.ts";
import { dateKey, dayMs, formatWall, keyToWallUtc, mondayOf, wallDayKey } from "./time.ts";

export const views: { id: View; label: string; Icon: typeof TodayIcon }[] = [
  { id: "home", label: "Today", Icon: TodayIcon },
  { id: "tasks", label: "Tasks", Icon: TasksIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarIcon },
];

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
      <div className="side-foot">
        <ThemeSwitch />
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

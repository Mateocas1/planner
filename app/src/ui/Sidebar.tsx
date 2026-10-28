import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { View } from "../App.tsx";
import type { BlockView, TaskView } from "../data/store.ts";
import { setTaskCompleted } from "../data/tasks.ts";
import { t } from "../i18n/index.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { currentAndNext } from "../domain/upNext.ts";
import { FocusStartButton, FocusWidget } from "./FocusWidget.tsx";
import { CalendarIcon, ChevronLeft, ChevronRight, ICON_STROKE, TasksIcon, TodayIcon } from "./icons.tsx";
import { shiftDay, shiftMonth, weekEdges } from "./monthGrid.ts";
import { spring, useNow } from "./motion.ts";
import { SettingsIcon } from "./Settings.tsx";
import { SyncStatus } from "./SyncStatus.tsx";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme.ts";
import { dateKey, dayMs, formatDuration, formatWall, keyToWallUtc, mondayOf, timeLabel, wallDayKey } from "./time.ts";
import type { FocusControls } from "./useFocusTimer.ts";
import { settle } from "./write.ts";
// The sidebar's own content (value roadmap §3) ships its styles beside it, so
// this unit never edits the shared sheet it would collide with.
import "./Sidebar.css";

export const views: { id: View; label: string; Icon: typeof TodayIcon }[] = [
  { id: "home", get label() { return t("shell.title.home"); }, Icon: TodayIcon },
  { id: "tasks", get label() { return t("shell.title.tasks"); }, Icon: TasksIcon },
  { id: "calendar", get label() { return t("shell.title.calendar"); }, Icon: CalendarIcon },
];

/** The weekly review's rail icon: the cycle the ritual closes, drawn on the
 *  icons' shared 24 px stroke grid (it is deliberately not one of the three
 *  view icons). */
export function WeeklyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v3h-3" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The desktop sidebar: a quiet glass material holding the month, the view
 * navigation (nav "Main", the name the browser tests address) with a pill that
 * slides to the active view, the two blocks that answer "what comes next"
 * (value roadmap §3), and the dense footer: the sync line, the account with Day
 * settings and the theme control, and the two footer actions.
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
  focus,
  onNavigate,
  onPickDay,
  onOpenTask,
  onSignOut,
  onImport,
  onOpenSettings,
  onOpenWeeklyReview,
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
  /** The focus timer lives in this chrome: the widget and the ▶ on each row. */
  focus: FocusControls;
  onNavigate: (view: View) => void;
  onPickDay: (key: string) => void;
  onOpenTask: (taskId: string) => void;
  onSignOut: () => void;
  /** Opens the Google Calendar import; the pressed control is its origin. */
  onImport: (origin: HTMLElement) => void;
  /** Opens the Settings view (Ronda 2, S1); it is a view now, so it takes no
   * origin — the shell navigates, nothing flies out of this row. */
  onOpenSettings: () => void;
  /** Opens the weekly review by hand (S3): the sidebar's own entry point. */
  onOpenWeeklyReview: () => void;
}) {
  return (
    <aside className="sidebar glass glass-regular">
      {timeZone && <MiniMonth blocks={blocks} timeZone={timeZone} selectedDay={selectedDay} onPickDay={onPickDay} />}
      <nav aria-label={t("app.mainNav")} className="side-nav">
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
                <span className="sr-only">{t("sidebar.openCount")}</span>
              </span>
            )}
          </button>
        ))}
      </nav>
      {/* The weekly review's own entry (S3): the same nav-item anatomy, but not
          one of the three views — it opens a ritual, not a destination, so it
          carries no pill and no count, and marks itself current while the
          flow is on screen. */}
      <button
        type="button"
        className="nav-item"
        aria-current={view === "weekly" ? "page" : undefined}
        onClick={onOpenWeeklyReview}
      >
        <WeeklyIcon className="nav-icon" />
        <span className="nav-label">{t("sidebar.weeklyReview")}</span>
      </button>
      {/* The one region that gives way when the window is short (R5-10): the
          month, the navigation and the footer keep their size, so a long Due
          soon list scrolls here instead of squeezing the nav items. */}
      {timeZone ? (
        <div className="side-scroll">
          <UpNext blocks={blocks} tasks={tasks} timeZone={timeZone} focus={focus} />
          <DueSoon uid={uid} tasks={tasks} timeZone={timeZone} onOpenTask={onOpenTask} />
        </div>
      ) : (
        <div className="side-scroll" />
      )}
      <div className="side-foot">
        <SyncStatus pending={pending} />
        <div className="side-foot-row">
          {/* The address is what the row is for: "Signed in as" stays in the
              accessible name only, so the email itself gets the width. It takes
              the line for itself when the column cannot hold it beside the
              controls, which is every desktop width. */}
          <span className="who" title={email}><span className="sr-only">{t("sidebar.signedInPrefix")}</span>{email}</span>
          {/* Settings, one press from the account whose preferences they are.
              The row is the account row, so the entry lives in it. While the
              view is open the gear carries the nav's current marker. */}
          <button
            type="button"
            className="icon-button side-settings"
            aria-label={t("app.settings")}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => onOpenSettings()}
          >
            <SettingsIcon />
          </button>
          <ThemeSwitch />
        </div>
        {/* Two footer actions as small button rows (R5-22). The import label is
            the short one the column can hold; the full name stays the
            accessible name and the tooltip, so the command is still called
            "Import from Google Calendar". Sign out is last and neutral. */}
        <div className="side-foot-actions">
          <button
            type="button"
            className="button small"
            aria-label={t("app.importGoogle")}
            title={t("app.importGoogle")}
            onClick={event => onImport(event.currentTarget)}
          >
            {t("sidebar.importShort")}
          </button>
          <button type="button" className="button small" onClick={onSignOut}>{t("app.signOut")}</button>
        </div>
      </div>
    </aside>
  );
}

/* ---------- the two content blocks ---------- */

/** The block's own name: the task it belongs to, or the product's word for an
 * unlinked block (`Calendar.tsx` uses the same wording). */
function blockTitle(block: BlockView, tasks: TaskView[]): string {
  return tasks.find(task => task.id === block.taskId)?.title ?? t("sidebar.workBlock");
}

/** "14:00 – 15:00" in the profile zone. */
function blockRange(block: BlockView, timeZone: string): string {
  return `${timeLabel(new Date(block.start), timeZone)} – ${timeLabel(new Date(block.end), timeZone)}`;
}

/**
 * Up next: the block running at this minute, then the next one still to start
 * today, and -- while a block is being focused on -- the live timer in place of
 * that block's row. Two rows at most: this is a hint about what comes next, not
 * a second agenda. The ▶ on a row starts the focus timer (value roadmap §5 row
 * 5); a block that already ended has nothing left to count down to, so it has no
 * ▶ at all.
 */
function UpNext({
  blocks,
  tasks,
  timeZone,
  focus,
}: {
  blocks: BlockView[];
  tasks: TaskView[];
  timeZone: string;
  focus: FocusControls;
}) {
  const now = useNow();
  const nowMs = now.getTime();
  /* What is running is a question about this instant, not about this date, and
     both questions have one answer for the whole app: domain/upNext.ts (the
     tray line and Now mode read the same pair). */
  const { current, next } = currentAndNext(blocks, nowMs, timeZone);
  const rows = [
    ...(current ? [{ block: current, running: true }] : []),
    ...(next ? [{ block: next, running: false }] : []),
  ].filter(row => row.block.id !== focus.session?.blockId);

  return (
    <section className="side-block side-up-next" aria-labelledby="side-up-next-heading">
      <h3 id="side-up-next-heading" className="side-label">{t("sidebar.upNext")}</h3>
      {/* The card takes the focused block's row: the countdown already names it. */}
      <AnimatePresence initial={false}>
        {focus.session && <FocusWidget key="focus" focus={focus} />}
      </AnimatePresence>
      {rows.length === 0 ? (
        <p className="side-empty">{t("sidebar.nothingElse")}</p>
      ) : (
        <ul className="side-card">
          {rows.map(({ block, running }) => {
            const title = blockTitle(block, tasks);
            const endAt = Date.parse(block.end);
            return (
              <li key={block.id} className={`side-row${running ? " is-now" : ""}`}>
                <div className="side-row-body">
                  <p className="side-row-title" title={title}>{title}</p>
                  <p className="side-row-meta">
                    {running ? t("sidebar.now") : t("sidebar.in", { duration: formatDuration((Date.parse(block.start) - nowMs) / 60_000) })}
                    {" · "}
                    {blockRange(block, timeZone)}
                  </p>
                </div>
                {endAt > nowMs && (
                  <FocusStartButton
                    label={title}
                    onClick={() => focus.start({ blockId: block.id, ...(block.taskId === undefined ? {} : { taskId: block.taskId }), endAt })}
                  />
                )}
              </li>
            );
          })}
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
      <h3 id="side-due-heading" className="side-label">{t("sidebar.dueSoon")}</h3>
      {due.length === 0 ? (
        <p className="side-empty">{t("sidebar.nothingDue")}</p>
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
                  aria-label={t("sidebar.complete", { title: task.title })}
                  onChange={() => complete(task)}
                />
                <button type="button" className="side-due-open" onClick={() => onOpenTask(task.id)}>
                  <span className="side-due-title" title={task.title}>{task.title}</span>
                  <span className={`side-due-meta${overdue ? " is-overdue" : ""}`}>
                    {overdue ? t("sidebar.overdue", { date: formatDateKey(task.deadline!, today) }) : formatDateKey(task.deadline!, today)}
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
  const [focusKey, setFocusKey] = useState(selected);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);

  // follow the calendar when it moves to another month
  useEffect(() => {
    setMonth(selected.slice(0, 7));
    setFocusKey(selected);
  }, [selected]);

  const first = keyToWallUtc(`${month}-01`);
  const start = mondayOf(first);
  const days = Array.from({ length: 42 }, (_, index) => wallDayKey(start + index * dayMs));
  // One tab stop for the whole grid (roving tabindex): the day last moved to,
  // else the selected day, else today, else the first of the month.
  const visible = (key: string) => days.includes(key);
  const activeKey = visible(focusKey) ? focusKey : visible(selected) ? selected : visible(todayKey) ? todayKey : `${month}-01`;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-mini-date="${activeKey}"]`)?.focus();
  });

  const moveTo = (key: string) => {
    pendingFocus.current = true;
    setFocusKey(key);
    if (key.slice(0, 7) !== month) setMonth(key.slice(0, 7));
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const key = (event.target as HTMLElement).closest<HTMLElement>("[data-mini-date]")?.dataset.miniDate;
    if (!key) return;
    let next: string | null = null;
    switch (event.key) {
      case "ArrowLeft": next = shiftDay(key, -1); break;
      case "ArrowRight": next = shiftDay(key, 1); break;
      case "ArrowUp": next = shiftDay(key, -7); break;
      case "ArrowDown": next = shiftDay(key, 7); break;
      case "Home": next = weekEdges(key, 1).first; break;
      case "End": next = weekEdges(key, 1).last; break;
      case "PageUp": next = shiftMonth(key, -1); break;
      case "PageDown": next = shiftMonth(key, 1); break;
      default: return; // Enter and Space are the button's own click
    }
    event.preventDefault();
    moveTo(next);
  };
  const blockDays = new Set(blocks.map(block => dateKey(new Date(block.start), timeZone)));
  const shift = (delta: number) => {
    const date = new Date(first);
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(wallDayKey(date.getTime()).slice(0, 7));
  };

  return (
    <section className="mini-month" aria-label={t("sidebar.month")}>
      <div className="mini-head">
        <p className="mini-title">
          {formatWall(first, { month: "long" })} <span>{formatWall(first, { year: "numeric" })}</span>
        </p>
        <div className="mini-nav">
          <button type="button" aria-label={t("sidebar.previousMonth")} onClick={() => shift(-1)}><ChevronLeft /></button>
          <button type="button" aria-label={t("sidebar.nextMonth")} onClick={() => shift(1)}><ChevronRight /></button>
        </div>
      </div>
      <div ref={gridRef} className="mini-grid" onKeyDown={onGridKeyDown}>
        {Array.from({ length: 7 }, (_, index) => formatWall(keyToWallUtc("2024-01-01") + index * dayMs, { weekday: "narrow" })).map((letter, index) => (
          <span key={index} className="mini-dow" aria-hidden="true">{letter}</span>
        ))}
        {days.map(key => {
          const utc = keyToWallUtc(key);
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
              data-mini-date={key}
              tabIndex={key === activeKey ? 0 : -1}
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
const themeOptions: { id: ThemePreference; labelKey: "sidebar.theme.system" | "sidebar.theme.light" | "sidebar.theme.dark" }[] = [
  { id: "system", labelKey: "sidebar.theme.system" },
  { id: "light", labelKey: "sidebar.theme.light" },
  { id: "dark", labelKey: "sidebar.theme.dark" },
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
    <svg {...themeIconBase} strokeWidth={ICON_STROKE} className={className}>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2.5" />
      <path d="M9 21h6M12 17v4" />
    </svg>
  );
}

function SunIcon({ className }: ThemeIconProps) {
  return (
    <svg {...themeIconBase} strokeWidth={ICON_STROKE} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  );
}

function MoonIcon({ className }: ThemeIconProps) {
  return (
    <svg {...themeIconBase} strokeWidth={ICON_STROKE} className={className}>
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
      aria-label={t("sidebar.theme")}
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
          <span className="sr-only">{t(option.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

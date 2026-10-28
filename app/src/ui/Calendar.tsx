import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { addBlock, deleteBlock, restoreBlock, setBlockTimes } from "../data/blocks.ts";
import type { BlockView, TaskView } from "../data/store.ts";
import { defaultWorkWindow, freeSlots } from "../planning/window.ts";
import { useCalendarDropTarget, useTaskDrag, DragGrip } from "./drag.tsx";
import { draggedEdge, dropLengthMinutes, dropStart, instantForEdge, movedEdge, stepMinutes } from "./grid.ts";
import "./Calendar.css";
import { DayLoad, useDayLoads } from "./CapacityBar.tsx";
import type { Holiday } from "../domain/holidays.ts";
import { formatDateKey, isPastDateKey } from "./format.ts";
import { HolidayChips, HolidaySheet, visibleHolidays } from "./Holidays.tsx";
import { ChevronLeft, ChevronRight, CloseIcon, FlagIcon, PlusIcon } from "./icons.tsx";
import { easeOut, narrowQuery, phoneQuery, spring, useMediaQuery, useNow } from "./motion.ts";
import { Sheet } from "./Sheet.tsx";
import { PlanMyDay } from "./PlanMyDay.tsx";
import { type UndoableDelete } from "./UndoToast.tsx";
import {
  dateKey,
  dayMs,
  formatDuration,
  formatWall,
  keyToWallUtc,
  localValue,
  minutesPerDay,
  mondayOf,
  pad,
  timeLabel,
  toZonedInstant,
  wallDayKey,
  wallMinutes,
} from "./time.ts";
import { blockTomorrow, rovingTabIndex } from "./shortcuts.ts";
import { useRowCursor, useSurfaceShortcuts } from "./useRowCursor.ts";
import { Select } from "./Select.tsx";
import { DateTimeField } from "./DateTimeField.tsx";
import { dateFieldLabels } from "./DateField.labels.ts";
import { t, useLocale } from "../i18n/index.ts";
import { settle } from "./write.ts";

/**
 * The Calendar surface (DESIGN.md §3, Calendar), rendered in the stored
 * profile timezone (D3): every day key, column, highlight, block position and
 * HH:MM label comes from the profile zone through Intl, never from the
 * browser's clock or offset.
 *
 * Week (desktop default) or Day; a phone always shows Day under a week strip.
 * Task deadlines sit in a Due row above the hour grid, apart from work blocks.
 * The grid covers the whole day and scrolls inside its card, opening near the
 * current time. Blocks open a details sheet; an empty slot or New block opens
 * the creation sheet. The Unscheduled panel lists open tasks with no block
 * ahead and plans one into the next free hour of the day in view.
 */

/** px per hour; kept in sync with --hour in app.css. */
const hourHeight = 52;
const planLength = 60;

type Range = "week" | "day";
type Laid = { block: BlockView; key: string; startMinutes: number; endMinutes: number; column: number; columns: number };

/** A minute of the day as the grid writes it (midnight reads as 00:00). */
function minutesLabel(minutes: number): string {
  const whole = ((Math.round(minutes) % minutesPerDay) + minutesPerDay) % minutesPerDay;
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

export function Calendar({
  uid,
  blocks,
  tasks,
  holidays,
  loading,
  timeZone,
  profileError,
  day,
  onDayChange,
  onDeleted,
}: {
  uid: string;
  blocks: BlockView[];
  tasks: TaskView[];
  holidays: Holiday[];
  loading: boolean;
  timeZone: string | null;
  profileError: string | null;
  day: string | null;
  onDayChange: (key: string | null) => void;
  onDeleted: (item: UndoableDelete) => void;
}) {
  if (timeZone === null) {
    return (
      <section className="view" aria-labelledby="calendar-heading">
        <header className="page-head">
          <h2 id="calendar-heading" className="large-title">Calendar</h2>
        </header>
        {profileError ? <p className="inline-error" role="alert">{profileError}</p> : <p className="subtitle" role="status">Loading your planner timezone…</p>}
      </section>
    );
  }
  return (
    <CalendarView
      uid={uid}
      blocks={blocks}
      tasks={tasks}
      holidays={holidays}
      loading={loading}
      timeZone={timeZone}
      day={day}
      onDayChange={onDayChange}
      onDeleted={onDeleted}
    />
  );
}

function CalendarView({
  uid,
  blocks,
  tasks,
  holidays,
  loading,
  timeZone,
  day,
  onDayChange,
  onDeleted,
}: {
  uid: string;
  blocks: BlockView[];
  tasks: TaskView[];
  holidays: Holiday[];
  loading: boolean;
  timeZone: string;
  day: string | null;
  onDayChange: (key: string | null) => void;
  onDeleted: (item: UndoableDelete) => void;
}) {
  const now = useNow();
  const phone = useMediaQuery(phoneQuery);
  // The shell is a phone; the grid needs a second, wider line: below 1000 px a
  // seven-column week is 55 px a column even though the shell is a desktop's.
  const narrow = useMediaQuery(narrowQuery);
  const reduced = useReducedMotion();
  const [range, setRange] = useState<Range>("week");
  const [direction, setDirection] = useState(0);
  const [creating, setCreating] = useState<{ start: string; end: string; origin: HTMLElement | null; draft: { key: string; minutes: number } | null } | null>(null);
  const [openBlock, setOpenBlock] = useState<{ id: string; origin: HTMLElement } | null>(null);
  const [openHoliday, setOpenHoliday] = useState<{ id: string; origin: HTMLElement } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // Direct manipulation: the resize in flight (raw pointer position, snapped on
  // release) and the last thing the grid changed, announced politely.
  const [resize, setResize] = useState<{ id: string; edge: "start" | "end"; key: string; start: number; end: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const drag = useTaskDrag();
  const drop = drag?.carrying?.drop ?? null;
  const draftRef = useRef<HTMLDivElement>(null);
  const newBlockRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The keyboard's cursor (F6) over the blocks in view: real DOM focus on the
  // block itself, and one tab stop for the whole grid (see ui/shortcuts.ts).
  const { activeId, onRowFocus } = useRowCursor(scrollRef);

  const todayKey = dateKey(now, timeZone);
  const selectedKey = day ?? todayKey;
  const selectedUtc = keyToWallUtc(selectedKey);
  const isDay = narrow || range === "day";
  const weekUtc = useMemo(() => Array.from({ length: 7 }, (_, index) => mondayOf(selectedUtc) + index * dayMs), [selectedUtc]);
  const days = isDay ? [selectedUtc] : weekUtc;
  const dayKeys = days.map(wallDayKey);
  /* The booked share of each day in view, for the header underline (F1): the
     same capacity math the Today radar uses, so the two never disagree. */
  const dayLoads = useDayLoads({ uid, now, timeZone, blocks, days: dayKeys });
  const visibleKeys = new Set(dayKeys);
  const rangeKey = `${isDay ? "d" : "w"}-${dayKeys[0]}`;

  const laid = useMemo(() => layoutBlocks(blocks, timeZone), [blocks, timeZone]);
  const visible = laid.filter(item => visibleKeys.has(item.key));
  // The tab stop's order is the order the grid paints the blocks in.
  const blockOrder = visible.map(item => item.block.id);

  /* `t` and `b` on the calendar (F6). A block moves one wall-clock day in the
     profile zone -- the same hours tomorrow, 23 or 25 hours away across a DST
     change -- and the move is offered back through the shell's undo toast, like
     every other write this surface makes. */
  useSurfaceShortcuts(action => {
    if (action === "newBlock") {
      openCreate(null, null, newBlockRef.current);
      return;
    }
    if (action !== "tomorrow") return;
    const active = document.activeElement;
    const id = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
    const block = blocks.find(entry => entry.id === id);
    if (block === undefined) return;
    const next = blockTomorrow(block, timeZone);
    const day = formatDateKey(dateKey(new Date(next.start), timeZone), todayKey);
    setPlanError(null);
    void settle(setBlockTimes(uid, block.id, next.start, next.end))
      .then(() => {
        announce(`Block moved to ${day}.`);
        onDeleted({ message: `Block moved to ${day}`, restore: () => settle(setBlockTimes(uid, block.id, block.start, block.end)) });
      })
      .catch(fail);
  });
  const taskOf = (id: string | undefined) => (id === undefined ? undefined : tasks.find(task => task.id === id));
  const nowMinutes = wallMinutes(now, timeZone);
  const showsToday = visibleKeys.has(todayKey);

  // Open the grid a third of the way above the current time when today is in
  // view, otherwise at the start of the working morning.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const target = showsToday ? (nowMinutes / 60) * hourHeight - scroller.clientHeight / 3 : 7.5 * hourHeight;
    scroller.scrollTop = Math.max(0, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  const step = (sign: number) => {
    setDirection(sign);
    onDayChange(wallDayKey(selectedUtc + sign * (isDay ? 1 : 7) * dayMs));
  };
  const goToday = () => {
    setDirection(Math.sign(keyToWallUtc(todayKey) - selectedUtc));
    onDayChange(null);
  };
  const pick = (key: string) => {
    setDirection(Math.sign(keyToWallUtc(key) - selectedUtc));
    onDayChange(key === todayKey ? null : key);
  };

  const openCreate = (key: string | null, minutes: number | null, origin: HTMLElement | null) => {
    const startMinutes = minutes ?? null;
    setCreating({
      start: key !== null && startMinutes !== null ? localValue(key, startMinutes) : "",
      end: key !== null && startMinutes !== null ? localValue(key, Math.min(minutesPerDay - 1, startMinutes + 60)) : "",
      origin,
      draft: key !== null && startMinutes !== null ? { key, minutes: startMinutes } : null,
    });
  };

  /** An empty slot is a creation gesture: the clicked half hour prefills the
   * new block, a dashed draft marks where it will land, and the sheet grows
   * out of that draft. A click on a block is not an empty-slot click. */
  function onSlotClick(key: string, event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".calendar-block")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = ((event.clientY - rect.top) / hourHeight) * 60;
    const snapped = Math.max(0, Math.min(minutesPerDay - stepMinutes, Math.round(minutes / stepMinutes) * stepMinutes));
    openCreate(key, snapped, null);
  }

  // The draft is rendered before the sheet measures its origin.
  useLayoutEffect(() => {
    if (creating?.draft && creating.origin === null && draftRef.current) {
      setCreating(previous => (previous ? { ...previous, origin: draftRef.current } : previous));
    }
  }, [creating]);

  // Unscheduled: open tasks with no block from now on.
  const nowMs = now.getTime();
  const unscheduled = tasks.filter(task => !task.completed && !blocks.some(block => block.taskId === task.id && Date.parse(block.end) > nowMs));
  const planDayKey = selectedKey < todayKey ? todayKey : selectedKey;
  const free = freeSlots(laid.filter(item => item.key === planDayKey), defaultWorkWindow, planDayKey === todayKey ? nowMinutes : null);
  const freeMinutes = free.reduce((total, [start, end]) => total + (end - start), 0);

  async function plan(task: TaskView) {
    setPlanError(null);
    const slot = free.find(([start, end]) => end - start >= planLength);
    if (!slot) {
      setPlanError(`No free hour left on ${formatDateKey(planDayKey, todayKey)}.`);
      return;
    }
    try {
      await settle(
        addBlock(
          uid,
          toZonedInstant(localValue(planDayKey, slot[0]), timeZone),
          toZonedInstant(localValue(planDayKey, slot[0] + planLength), timeZone),
          task.id,
        ),
      );
      if (planDayKey !== selectedKey || isDay) pick(planDayKey);
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTo({ top: Math.max(0, (slot[0] / 60) * hourHeight - scroller.clientHeight / 3), behavior: reduced ? "auto" : "smooth" });
    } catch (cause) {
      setPlanError(cause instanceof Error ? cause.message : "The block could not be planned.");
    }
  }

  const fail = (cause: unknown) => {
    setPlanError(cause instanceof Error ? cause.message : "The block could not be saved.");
  };

  /** Persists a block's edges in the profile zone. The local cache applies the
   * write at once, so the grid keeps its position without waiting for the
   * server; a rejected pair never reaches Firestore (the data helper validates
   * before writing). */
  function saveTimes(item: Laid, startMinutes: number, endMinutes: number): Promise<void> {
    return settle(
      setBlockTimes(
        uid,
        item.block.id,
        instantForEdge(item.key, startMinutes, timeZone),
        instantForEdge(item.key, endMinutes, timeZone),
      ),
    );
  }

  /** The block's stored edges as minutes of its own day, or null when it ends
   * on another day: the layout clips such a block at midnight, so resizing it
   * would persist the clip as the block's real end. */
  function storedEdges(item: Laid): { start: number; end: number } | null {
    const end = wallMinutes(new Date(item.block.end), timeZone);
    return dateKey(new Date(item.block.end), timeZone) === item.key ? { start: item.startMinutes, end } : null;
  }

  /** Where a carried task would land under the pointer. */
  function resolveDrop(x: number, y: number) {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const day = under?.closest<HTMLElement>("[data-date]");
    const body = day?.querySelector<HTMLElement>(".calendar-day-body");
    const key = day?.dataset.date;
    if (!body || !key) return null;
    const rect = body.getBoundingClientRect();
    return { key, minutes: dropStart(((y - rect.top) / hourHeight) * 60) };
  }

  /** A dropped task becomes a block on the snapped slot, linked to the task so
   * the grid and the details sheet show its title. */
  function commitDrop(task: TaskView, slot: { key: string; minutes: number }) {
    setPlanError(null);
    void settle(
      addBlock(
        uid,
        instantForEdge(slot.key, slot.minutes, timeZone),
        instantForEdge(slot.key, slot.minutes + dropLengthMinutes, timeZone),
        task.id,
      ),
    )
      .then(() => announce(`Planned ${task.title} at ${minutesLabel(slot.minutes)} on ${formatDateKey(slot.key, todayKey)}.`))
      .catch(fail);
  }

  useCalendarDropTarget({ resolve: resolveDrop, commit: commitDrop });

  function announce(text: string) {
    setAnnouncement(text);
  }

  /** Dragging an edge: the block follows the pointer exactly (no lag, no text
   * scaling), Escape reverts, and the release snaps to the grid's step and
   * persists through the data layer. A release moves `top` and `height`, so it
   * is a snap rather than an animation: the product animates transform,
   * opacity, filter and clip-path on live DOM, and a resize is none of those. */
  function beginResize(item: Laid, edge: "start" | "end", event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const base = storedEdges(item);
    if (!base) return;
    event.preventDefault();
    event.stopPropagation();
    const originY = event.clientY;
    let delta = 0;
    // The click that follows this gesture belongs to the resize: it must not
    // open the block's details, and a release over empty grid must not open the
    // creation sheet. Capture on the window runs before React's own listeners,
    // and the timer removes the listener after the click has been dispatched.
    const swallow = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    // Mark the block as resizing from the press, not from the first move: the
    // press-scale rule must not shrink the block while its edge is grabbed.
    setResize({ id: item.block.id, edge, key: item.key, ...base });

    const move = (moveEvent: PointerEvent) => {
      delta = ((moveEvent.clientY - originY) / hourHeight) * 60;
      setResize({ id: item.block.id, edge, key: item.key, ...draggedEdge(edge, delta, base.start, base.end) });
    };

    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      setResize(null);
      if (!commit) return;
      const snapped = movedEdge(edge, delta, base.start, base.end);
      if (snapped.start === base.start && snapped.end === base.end) return;
      void saveTimes(item, snapped.start, snapped.end)
        .then(() => announce(`Block is now ${minutesLabel(snapped.start)}–${minutesLabel(snapped.end)}.`))
        .catch(fail);
    };

    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      end(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  /** The keyboard path: Shift+ArrowDown grows the block by one grid step and
   * Shift+ArrowUp shrinks it, with the start held still and the end never
   * crossing one step past it. Focus stays on the block, so a run of presses is
   * a run of resizes. */
  function resizeByKeyboard(item: Laid, direction: 1 | -1) {
    const base = storedEdges(item);
    if (!base) return;
    // A block already at (or below) one step has nothing left to give; without
    // this, snapping a legacy short block up would grow it instead.
    if (direction < 0 && base.end - base.start <= stepMinutes) return;
    const snapped = movedEdge("end", direction * stepMinutes, base.start, base.end);
    if (snapped.end === base.end) return;
    setPlanError(null);
    void saveTimes(item, snapped.start, snapped.end)
      .then(() => announce(`Block is now ${minutesLabel(snapped.start)}–${minutesLabel(snapped.end)}.`))
      .catch(fail);
  }

  const selectedHoliday = openHoliday ? holidays.find(holiday => holiday.id === openHoliday.id) : undefined;
  const selectedBlock = openBlock ? blocks.find(block => block.id === openBlock.id) : undefined;
  const monthUtc = selectedUtc;

  return (
    <section className="view calendar" aria-labelledby="calendar-heading">
      <header className="page-head">
        <div>
          <h2 id="calendar-heading" className="large-title">
            <span className="sr-only">Calendar, </span>
            {isDay && !phone ? (
              <>
                {formatWall(selectedUtc, { weekday: "long" })} <span className="soft">{formatWall(selectedUtc, { month: "long", day: "numeric" })}</span>
              </>
            ) : (
              <>
                {formatWall(monthUtc, { month: "long" })} <span className="soft">{formatWall(monthUtc, { year: "numeric" })}</span>
              </>
            )}
          </h2>
          <p className="subtitle">
            <span>Times in {timeZone}</span>
            {!loading && visible.length === 0 && (
              <span role="status"> · {isDay ? "No work blocks on this day." : "No work blocks this week."}</span>
            )}
          </p>
        </div>
        <div className="toolbar" role="group" aria-label="Calendar navigation">
          {!phone && (
            <div className="segmented" role="group" aria-label="Range">
              {(["day", "week"] as const).map(option => (
                <button key={option} type="button" aria-pressed={range === option} onClick={() => setRange(option)}>
                  {option === "day" ? "Day" : "Week"}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="button icon" aria-label={isDay ? "Previous day" : "Previous week"} onClick={() => step(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="button" onClick={goToday}>Today</button>
          <button type="button" className="button icon" aria-label={isDay ? "Next day" : "Next week"} onClick={() => step(1)}>
            <ChevronRight />
          </button>
          <button ref={newBlockRef} type="button" className="button button-accent" onClick={() => openCreate(null, null, newBlockRef.current)}>
            <PlusIcon />New block
          </button>
        </div>
      </header>

      {phone && (
        <div className="week-strip" role="group" aria-label="Week">
          {weekUtc.map(utc => {
            const key = wallDayKey(utc);
            const count = laid.filter(item => item.key === key).length;
            return (
              <button
                key={key}
                type="button"
                className={`strip-day${key === todayKey ? " is-today" : ""}${key === selectedKey ? " is-selected" : ""}`}
                aria-pressed={key === selectedKey}
                aria-label={formatWall(utc, { weekday: "long", month: "long", day: "numeric" })}
                onClick={() => pick(key)}
              >
                <span className="strip-weekday">{formatWall(utc, { weekday: "narrow" })}</span>
                <span className="strip-date">{formatWall(utc, { day: "numeric" })}</span>
                <span className="strip-dots" aria-hidden="true">
                  {Array.from({ length: Math.min(3, count) }, (_, index) => <i key={index} />)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="calendar-layout">
        <div className="card cal" style={{ "--n": days.length } as React.CSSProperties}>
          {!phone && (
            /* The header states each day's load, so it is no longer decorative:
               the weekday and the number stay out of the accessibility tree (the
               underline's own name reads them back with the minutes), and the
               underline itself carries "5 h booked, 8 h free". */
            <div className="cal-head">
              <div />
              {days.map(utc => {
                const key = wallDayKey(utc);
                const weekday = new Date(utc).getUTCDay();
                const load = dayLoads.get(key);
                return (
                  <div key={key} className={`day-head${key === todayKey ? " is-today" : ""}${weekday % 6 === 0 ? " is-weekend" : ""}`}>
                    <span aria-hidden="true">{formatWall(utc, { weekday: "short" })}</span>
                    <span className="day-num" aria-hidden="true">{formatWall(utc, { day: "numeric" })}</span>
                    {load && <DayLoad day={load} />}
                  </div>
                );
              })}
            </div>
          )}
          <div className="cal-due">
            <div className="cal-due-label">Due</div>
            {dayKeys.map(key => {
              const due = tasks.filter(task => !task.completed && task.deadline === key);
              return (
                <div key={key} className="due-cell">
                  <HolidayChips holidays={visibleHolidays(holidays, key)} onOpen={(holiday, origin) => setOpenHoliday({ id: holiday.id, origin })} />
                  {due.map(task => (
                    <span key={task.id} className={`due-chip${isPastDateKey(key, todayKey) ? " is-overdue" : ""}`} title={task.title}>
                      <FlagIcon className="meta-icon" />
                      <span>{task.title}</span>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="cal-scroll" ref={scrollRef}>
            <AnimatePresence initial={false} mode="popLayout">
              {/* The slide is one transform string, never the `x` shorthand:
                  the shorthand writes the transform through Motion's own build
                  path on the main thread, and this body is the heaviest subtree
                  in the app. Reduced motion keeps the fade and drops the 24 px
                  travel, so nothing moves and nothing is scaled. */}
              <motion.div
                key={rangeKey}
                className="cal-body"
                initial={reduced ? { opacity: 0 } : { opacity: 0, transform: `translateX(${direction * 24}px)` }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "translateX(0px)" }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={reduced ? { duration: 0.15 } : spring.smooth}
              >
                <div className="gutter" aria-hidden="true">
                  {Array.from({ length: 23 }, (_, index) => index + 1)
                    .filter(hour => !(showsToday && Math.abs(hour * 60 - nowMinutes) < 14))
                    .map(hour => (
                      <span key={hour} style={{ top: hour * hourHeight }}>{pad(hour)}:00</span>
                    ))}
                  {showsToday && (
                    <span className="gutter-now" style={{ top: (nowMinutes / 60) * hourHeight }}>{timeLabel(now, timeZone)}</span>
                  )}
                </div>
                {days.map(utc => {
                  const key = wallDayKey(utc);
                  const weekday = new Date(utc).getUTCDay();
                  return (
                    <div
                      key={key}
                      className={`calendar-day${key === todayKey ? " calendar-day-today" : ""}${weekday % 6 === 0 ? " is-weekend" : ""}`}
                      data-date={key}
                      {...(key === todayKey ? { "data-today": "true" } : {})}
                    >
                      <div className="calendar-day-body" onClick={event => onSlotClick(key, event)}>
                        {visible.filter(item => item.key === key).map(item => {
                          const task = taskOf(item.block.taskId);
                          const live = resize?.id === item.block.id ? resize : null;
                          const startMinutes = live ? live.start : item.startMinutes;
                          const endMinutes = live ? live.end : item.endMinutes;
                          const height = Math.max(20, ((endMinutes - startMinutes) / 60) * hourHeight - 2);
                          const width = 100 / item.columns;
                          const past = Date.parse(item.block.end) <= nowMs;
                          // A block that ends on another day is clipped at midnight
                          // in this column; resizing it would persist the clip, so it
                          // is not resizable here (the known D3 limitation).
                          const resizable = dateKey(new Date(item.block.end), timeZone) === item.key;
                          const range = live
                            ? `${minutesLabel(startMinutes)}–${minutesLabel(endMinutes)}`
                            : `${timeLabel(new Date(item.block.start), timeZone)}–${timeLabel(new Date(item.block.end), timeZone)}`;
                          return (
                            <button
                              key={item.block.id}
                              type="button"
                              className={`calendar-block ${task ? "cat-task" : "cat-focus"}${item.block.pending ? " calendar-block-pending" : ""}${height < 40 ? " is-short" : ""}${past ? " is-past" : ""}`}
                              data-block={item.block.id}
                              data-row-cursor={item.block.id}
                              tabIndex={rovingTabIndex(activeId, item.block.id, blockOrder)}
                              onFocus={() => onRowFocus(item.block.id)}
                              data-start={item.block.start}
                              data-end={item.block.end}
                              data-resizing={live ? live.edge : undefined}
                              aria-keyshortcuts={resizable ? "Shift+ArrowUp Shift+ArrowDown" : undefined}
                              style={{
                                top: (startMinutes / 60) * hourHeight + 1,
                                height,
                                left: `calc(${item.column * width}% + 3px)`,
                                width: `calc(${width}% - 6px)`,
                              }}
                              onClick={event => setOpenBlock({ id: item.block.id, origin: event.currentTarget })}
                              onKeyDown={event => {
                                if (!resizable || !event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                                event.preventDefault();
                                resizeByKeyboard(item, event.key === "ArrowDown" ? 1 : -1);
                              }}
                            >
                              <b>{task ? task.title : item.block.title ?? "Work block"}</b>
                              <span>{range}</span>
                              {resizable && (
                                <>
                                  <span
                                    className="block-handle block-handle-start"
                                    aria-hidden="true"
                                    data-edge="start"
                                    onPointerDown={event => beginResize(item, "start", event)}
                                  />
                                  <span
                                    className="block-handle block-handle-end"
                                    aria-hidden="true"
                                    data-edge="end"
                                    onPointerDown={event => beginResize(item, "end", event)}
                                  />
                                </>
                              )}
                            </button>
                          );
                        })}
                        {creating?.draft?.key === key && (
                          <div
                            ref={draftRef}
                            className="calendar-draft"
                            aria-hidden="true"
                            style={{ top: (creating.draft.minutes / 60) * hourHeight + 1, height: hourHeight - 2 }}
                          />
                        )}
                        {drop !== null && drop.key === key && (
                          <div
                            className="calendar-draft calendar-drop"
                            data-drop-preview="true"
                            aria-hidden="true"
                            style={{
                              top: (drop.minutes / 60) * hourHeight + 1,
                              height: (dropLengthMinutes / 60) * hourHeight - 2,
                            }}
                          />
                        )}
                        {showsToday && (
                          <div className={`now-line${key === todayKey ? "" : " is-faint"}`} style={{ top: (nowMinutes / 60) * hourHeight }} aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <aside className="card tray" aria-labelledby="tray-heading">
          <div>
            <h3 id="tray-heading" className="tray-title">Unscheduled</h3>
            <p className="tray-note">
              Open tasks with no work block ahead. Plan sets aside an hour in the next free slot {planDayKey === todayKey ? "today" : `on ${formatDateKey(planDayKey, todayKey)}`}.
            </p>
          </div>
          {/* Plan my day (F4): the day's open tasks proposed as blocks and
              applied as one batch. The tray's own undo is the shell's, so the
              app never shows two offers at once. */}
          <PlanMyDay
            uid={uid}
            tasks={tasks}
            blocks={blocks}
            timeZone={timeZone}
            now={now}
            onOfferUndo={onDeleted}
          />
          {unscheduled.length === 0 ? (
            <p className="tray-note">Every open task has time set aside.</p>
          ) : (
            <ul className="tray-list">
              <AnimatePresence initial={false}>
                {unscheduled.map(task => (
                  <motion.li
                    key={task.id}
                    layout="position"
                    className="tray-item"
                    exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.16, ease: easeOut } }}
                    /* A neighbour that moves up after a plan follows the same 250 ms
                       snappy spring the task rows travel with, so a reflow reads as
                       the same gesture wherever it happens. */
                    transition={spring.snappy}
                  >
                    <div>
                      <b>{task.title}</b>
                      {task.deadline && (
                        <span className={isPastDateKey(task.deadline, todayKey) ? "is-overdue" : ""}>due {formatDateKey(task.deadline, todayKey)}</span>
                      )}
                    </div>
                    <DragGrip task={task} />
                    <button type="button" className="button small" onClick={() => void plan(task)}>Plan</button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
          {planError && <p className="inline-error" role="alert">{planError}</p>}
          <p className="tray-sum">
            <span>Free {planDayKey === todayKey ? "for the rest of today" : `on ${formatDateKey(planDayKey, todayKey)}`}</span>
            <b>{formatDuration(freeMinutes)}</b>
          </p>
        </aside>
      </div>

      <AnimatePresence>
        {creating && (creating.origin || !creating.draft) && (
          <BlockForm
            key="create"
            uid={uid}
            tasks={tasks}
            timeZone={timeZone}
            todayKey={todayKey}
            initialStart={creating.start}
            initialEnd={creating.end}
            origin={creating.origin}
            onClose={() => setCreating(null)}
          />
        )}
        {selectedHoliday && openHoliday && selectedHoliday.hidden !== true && (
          <HolidaySheet
            key={selectedHoliday.id}
            uid={uid}
            holiday={selectedHoliday}
            todayKey={todayKey}
            origin={openHoliday.origin}
            onClose={() => setOpenHoliday(null)}
            onOfferUndo={onDeleted}
          />
        )}
        {selectedBlock && openBlock && (
          <BlockDetails
            key={selectedBlock.id}
            block={selectedBlock}
            task={taskOf(selectedBlock.taskId)}
            timeZone={timeZone}
            todayKey={todayKey}
            origin={openBlock.origin}
            onClose={() => setOpenBlock(null)}
            onDelete={() => {
              const deleted = selectedBlock;
              setOpenBlock(null);
              void settle(deleteBlock(uid, deleted.id))
                .then(() => onDeleted({ message: "Block deleted", restore: () => restoreBlock(uid, deleted) }))
                .catch(() => undefined);
            }}
          />
        )}
      </AnimatePresence>
      <p className="sr-only" role="status" data-calendar-status="">{announcement}</p>
    </section>
  );
}

/** Every block resolved to the minutes it occupies inside its own profile-zone
 * day, with overlapping blocks sharing the column width. A block ending on a
 * later day is clipped at the column's midnight (the known D3 limitation). */
function layoutBlocks(blocks: BlockView[], timeZone: string): Laid[] {
  const byDay = new Map<string, Laid[]>();
  for (const block of blocks) {
    const startDate = new Date(block.start);
    const endDate = new Date(block.end);
    const key = dateKey(startDate, timeZone);
    const startMinutes = wallMinutes(startDate, timeZone);
    const endMinutes = dateKey(endDate, timeZone) > key ? minutesPerDay : wallMinutes(endDate, timeZone);
    const item: Laid = { block, key, startMinutes, endMinutes: Math.max(endMinutes, startMinutes + 15), column: 0, columns: 1 };
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }
  const out: Laid[] = [];
  for (const items of byDay.values()) {
    items.sort((left, right) => left.startMinutes - right.startMinutes);
    let cluster: Laid[] = [];
    let clusterEnd = -1;
    const flush = () => {
      const columnEnds: number[] = [];
      for (const item of cluster) {
        let column = columnEnds.findIndex(end => end <= item.startMinutes);
        if (column < 0) {
          column = columnEnds.length;
          columnEnds.push(0);
        }
        columnEnds[column] = item.endMinutes;
        item.column = column;
      }
      for (const item of cluster) item.columns = columnEnds.length;
      out.push(...cluster);
      cluster = [];
    };
    for (const item of items) {
      if (cluster.length > 0 && item.startMinutes >= clusterEnd) flush();
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMinutes);
    }
    if (cluster.length > 0) flush();
  }
  return out;
}

/** freeSlots was extracted to ../planning/window.ts (W1) so the capacity radar
 * (F1a) and plan-my-day (F4a) can reuse the same logic. The import above
 * carries the implementation; the parity tests in window.test.ts pin the old
 * output fixture by fixture to guarantee the Plan feature is unchanged. */

/** The creation sheet: Start, End and an optional task. Rejected input never
 * reaches Firestore (the data helper validates first) and the reason is shown
 * in the sheet; accepted input closes it without waiting for the server. */
function BlockForm({
  uid,
  tasks,
  timeZone,
  todayKey,
  initialStart,
  initialEnd,
  origin,
  onClose,
}: {
  uid: string;
  tasks: TaskView[];
  timeZone: string;
  todayKey: string;
  initialStart: string;
  initialEnd: string;
  origin: HTMLElement | null;
  onClose: () => void;
}) {
  useLocale();
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [taskId, setTaskId] = useState("");
  const taskOptions = useMemo(
    () => [{ value: "", label: "No task" }, ...tasks.filter(task => !task.completed).map(task => ({ value: task.id, label: task.title }))],
    [tasks],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStart(initialStart);
    setEnd(initialEnd);
  }, [initialStart, initialEnd]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await settle(addBlock(uid, toZonedInstant(start, timeZone), toZonedInstant(end, timeZone), taskId === "" ? undefined : taskId));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label="New block" className="block-sheet" origin={origin} onClose={onClose}>
      <form className="sheet-form" onSubmit={event => void onSubmit(event)}>
        <header className="sheet-head">
          <span className="sheet-kind">New work block</span>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="form-group">
          <div className="form-row">
            <label htmlFor="block-start">Start</label>
            <DateTimeField id="block-start" timeId="block-start-time" value={start} onChange={setStart} today={todayKey} dateLabels={dateFieldLabels} timeLabel={t("block.startTime")} />
          </div>
          <div className="form-row">
            <label htmlFor="block-end">End</label>
            <DateTimeField id="block-end" timeId="block-end-time" value={end} onChange={setEnd} today={todayKey} dateLabels={dateFieldLabels} timeLabel={t("block.endTime")} />
          </div>
          <div className="form-row">
            <label htmlFor="block-task">Task</label>
            <Select id="block-task" label="Task" value={taskId} options={taskOptions} onChange={setTaskId} />
          </div>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <p className="sheet-note">Times are in {timeZone}.</p>
        <button type="submit" className="button-primary" disabled={busy}>Add block</button>
      </form>
    </Sheet>
  );
}

function BlockDetails({
  block,
  task,
  timeZone,
  todayKey,
  origin,
  onClose,
  onDelete,
}: {
  block: BlockView;
  task: TaskView | undefined;
  timeZone: string;
  todayKey: string;
  origin: HTMLElement;
  onClose: () => void;
  onDelete: () => void;
}) {
  const start = new Date(block.start);
  const end = new Date(block.end);
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  return (
    <Sheet label="Block details" className="block-sheet" origin={origin} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-kind">Work block</span>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <h3 className="sheet-title as-heading">{task ? task.title : "Work block"}</h3>
      <dl className="form-group">
        <div className="form-row">
          <dt>Day</dt>
          <dd>{formatDateKey(dateKey(start, timeZone), todayKey)}</dd>
        </div>
        <div className="form-row">
          <dt>Time</dt>
          <dd className="tnum">{timeLabel(start, timeZone)} – {timeLabel(end, timeZone)} · {formatDuration(minutes)}</dd>
        </div>
        <div className="form-row">
          <dt>For task</dt>
          <dd>{task ? task.title : "None"}</dd>
        </div>
        {block.pending && (
          <div className="form-row">
            <dt>Sync</dt>
            <dd>Saved on this device, waiting to sync</dd>
          </div>
        )}
      </dl>
      <button type="button" className="button-danger" onClick={onDelete}>Delete block</button>
    </Sheet>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useProfileTimeZone } from "../data/profile.ts";
import type { BlockView, SeriesView, TaskView } from "../data/store.ts";
import { estimateNote } from "../domain/model.ts";
import { capacity, dayCapacity, overcommitNote, type DayCapacity } from "../planning/capacity.ts";
import { t } from "../i18n/index.ts";
import type { WorkWindow } from "../planning/window.ts";
import { formatDuration, formatWall, keyToWallUtc } from "./time.ts";
import "./CapacityBar.css";

/**
 * The overcommit radar (distinctive roadmap F1): how full the week already is,
 * in the two places a person looks at it.
 *
 *  - `WeekRadar` is the Today section: one segment per day of the current
 *    planner week, each carrying the booked share of the working window, the
 *    days that are packed, the deadlines that no longer fit, and the sentences
 *    that keep the arithmetic honest (an assumed hour, a repeating task nobody
 *    estimated).
 *  - `useDayLoads` + `DayLoad` are the Calendar header underline: the same
 *    booked share, drawn under the day it belongs to, with the booked and free
 *    minutes in its accessible name.
 *
 * The numbers are not computed here. `planning/capacity.ts` owns the whole
 * question (union of blocks, midnight split, the assumed 60 minutes, earliest
 * deadline first); this module only decides what a day is called and how the
 * bar looks, so the radar and the plan-my-day button can never disagree about
 * what "free" means.
 *
 * Nothing here writes: the radar is a reading of the planner, never a change
 * to it.
 */

/** One line under the week row: a warning with a deadline, or a disclosure. */
type RadarNote = { key: string; text: string; kind: "over" | "hint" };

/** `Tue` -- the short weekday of a profile-zone date key, read from the key. */
function dayName(date: string): string {
  return formatWall(keyToWallUtc(date), { weekday: "short" });
}

/** `Tue 27` -- the weekday and the day of the month, as the column header shows
 * them, so a screen reader hears which day the minutes belong to. */
function dayHeading(date: string): string {
  return `${dayName(date)} ${formatWall(keyToWallUtc(date), { day: "numeric" })}`;
}

/** The accessible name of one week segment: `Tue, 38% booked`, and the word
 * `Packed` when the day is, because colour is never the only signal. */
function segmentLabel(day: DayCapacity): string {
  return t(day.packed ? "radar.segmentPacked" : "radar.segment", { day: dayName(day.date), percent: day.percentBooked });
}

/** The accessible name of one Calendar header underline, in minutes: the booked
 * share and what is left, which is what the bar draws. */
function loadLabel(day: DayCapacity): string {
  return t(day.packed ? "radar.loadPacked" : "radar.load", {
    day: dayHeading(day.date),
    booked: formatDuration(day.bookedMinutes),
    free: formatDuration(day.freeMinutes),
  });
}

function repeatingNote(count: number): string {
  return t("radar.repeating", { count });
}

function assumedNote(count: number): string {
  return t("radar.assumed", { note: estimateNote(undefined), count });
}

/**
 * True one frame after the first paint, and false before it.
 *
 * A bar has to animate when its value changes, not when it appears: without
 * this flag a card that mounts with a full Tuesday would draw that Tuesday
 * growing from zero, which reads as "something just happened" when nothing did.
 * The first paint is therefore made in the final position, and only the value
 * changes after it are given the transition.
 */
function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return armed;
}

/**
 * The load bar: a fixed track with the booked share filled from the left.
 *
 * The fill is `transform: scaleX()` and never a width, so a week of changing
 * numbers never re-lays-out the row. A transition retargets from the current
 * value, so two blocks added in a row extend the bar without restarting it, and
 * `prefers-reduced-motion` drops the travel and keeps the colour.
 */
export function CapacityBar({ percent, packed = false, className }: { percent: number; packed?: boolean; className?: string }) {
  const armed = useArmed();
  const share = Math.min(100, Math.max(0, percent)) / 100;
  return (
    <span className={`capacity-bar${packed ? " is-packed" : ""}${armed ? " is-armed" : ""}${className ? ` ${className}` : ""}`} aria-hidden="true">
      <i className="capacity-bar-fill" style={{ transform: `scaleX(${share})` }} />
    </span>
  );
}

/**
 * The working window the radar measures against: one window for all seven days
 * (roadmap §5.4), read from the profile Day settings so a person who works
 * 09:00-17:00 sees their own week and not the 08:00-21:00 default.
 *
 * It subscribes to the profile document a second time, next to App's own
 * subscription, because the surfaces that draw the radar receive their props
 * from App and this unit does not own that file. Once `workWindow` is threaded
 * through as a prop (one line per surface) this hook is the only thing to
 * delete.
 */
export function usePlannerWindow(uid: string): WorkWindow {
  return useProfileTimeZone(uid).workWindow;
}

/**
 * One visible Calendar column's load, keyed by date, computed once for the week
 * on screen. `days` is the list the header draws, in order.
 */
export function useDayLoads({
  uid,
  now,
  timeZone,
  blocks,
  days,
}: {
  uid: string;
  now: Date;
  timeZone: string;
  blocks: readonly BlockView[];
  days: readonly string[];
}): Map<string, DayCapacity> {
  const workWindow = usePlannerWindow(uid);
  const signature = days.join("|");
  return useMemo(() => {
    const input = { now, timeZone, workWindow, blocks };
    return new Map(days.map(key => [key, dayCapacity(input, key)]));
    // Only the fields `dayCapacity` reads may invalidate this: the blocks, the
    // window, the zone, and the day list. `now` matters solely for today's
    // remaining free time, which the header does not show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, blocks, timeZone, workWindow]);
}

/** The 3 px underline under one Calendar day header, with its minutes in the
 * accessible name and its colour carrying the packed state. */
export function DayLoad({ day }: { day: DayCapacity }) {
  return (
    <span className="day-load" role="img" aria-label={loadLabel(day)}>
      <CapacityBar percent={day.percentBooked} packed={day.packed} className="capacity-bar-underline" />
    </span>
  );
}

/**
 * The Today "This week" section: seven segments, then the sentences the numbers
 * cannot say on their own.
 *
 * The section hides itself when the planner holds nothing at all (criterion 8):
 * an empty radar is not information, it is furniture. With data but no
 * estimates it stays, measures the booked time it can see, and asks for the
 * estimates instead of inventing a load from the assumed hour.
 */
export function WeekRadar({
  uid,
  now,
  timeZone,
  tasks,
  blocks,
  series,
  completions,
}: {
  uid: string;
  now: Date;
  timeZone: string;
  tasks: readonly TaskView[];
  blocks: readonly BlockView[];
  series: readonly SeriesView[];
  completions: Record<string, string>;
}) {
  const workWindow = usePlannerWindow(uid);
  const radar = useMemo(
    () => capacity({ now, timeZone, workWindow, tasks, blocks, series, completions }),
    [now, timeZone, workWindow, tasks, blocks, series, completions],
  );
  if (radar.hints.empty) return null;

  // An estimate the person stored, as opposed to the hour the radar assumes for
  // every task that has none. With no stored estimates anywhere the shortfall
  // arithmetic would be entirely about assumed work, so the radar asks for the
  // estimates instead of warning about numbers it made up.
  const estimated = tasks.some(task => !task.completed && task.estimate !== undefined) || series.some(entry => entry.estimate !== undefined);
  const notes: RadarNote[] = [];
  if (estimated) {
    for (const row of radar.overcommit) notes.push({ key: `over-${row.deadline}`, text: overcommitNote(row), kind: "over" });
  } else {
    notes.push({ key: "no-estimates", text: t("radar.noEstimates"), kind: "hint" });
  }
  if (radar.hints.unestimatedSeriesCount > 0) {
    notes.push({ key: "unestimated-series", text: repeatingNote(radar.hints.unestimatedSeriesCount), kind: "hint" });
  }
  if (estimated && radar.hints.assumedEstimateCount > 0) {
    notes.push({ key: "assumed", text: assumedNote(radar.hints.assumedEstimateCount), kind: "hint" });
  }

  return (
    <section className="list-section radar" aria-labelledby="radar-heading">
      <div className="section-head">
        <h3 id="radar-heading" className="section-title">{t("radar.title")}</h3>
        <span className="section-meta">{t("radar.perDay", { duration: formatDuration(radar.today.windowMinutes) })}</span>
      </div>
      <ol className="radar-week" aria-label={t("radar.weekLabel")}>
        {radar.week.days.map(day => (
          <li key={day.date} className="radar-day">
            <div className="radar-day-box" role="img" aria-label={segmentLabel(day)}>
              <span className="radar-day-name" aria-hidden="true">{dayName(day.date)}</span>
              <CapacityBar percent={day.percentBooked} packed={day.packed} />
              <span className={`radar-day-value${day.packed ? " is-packed" : ""}`} aria-hidden="true">
                {day.packed ? t("radar.packed") : `${day.percentBooked}%`}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {notes.length > 0 && (
        <ul className="radar-notes">
          {notes.map(note => (
            <li key={note.key} className={`radar-note${note.kind === "over" ? " is-over" : ""}`}>{note.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

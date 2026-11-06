/**
 * The geometry and the motion plan of the day-replay stage (day-replay plan
 * §2, §3, §6): pure data, so the component only maps it onto elements and
 * every number the user sees move is asserted in `dayReplayLayout.test.ts`.
 *
 * A bar is the planned block *bending* into what happened. It is laid out once,
 * at the widest it will ever be, and the keyframes only move it (`translateX`
 * in percent of its own width) and trim it (`clip-path: inset(...)`), never
 * `scaleX`, so the rounded ends are never distorted. Its resting style is the
 * final frame, and every animation fills `backwards` only: whatever the
 * animation does not hold (reduced motion, a skipped replay, a failed
 * `animate`) is already the complete, correct picture.
 *
 * No DOM, no React, no Firebase. Wall-clock labels go through `ui/time.ts`.
 */

import { t } from "../i18n/index.ts";
import { dateKey, formatDuration as minutesText, timeLabel, toZonedInstant } from "./time.ts";
import type { DayReplay, ReplayRow, ReplaySpan, ReplayTimeline } from "../planning/dayReplay.ts";

/** Rounded ends of a bar; the clip-path carries them, not `border-radius`. */
export const BAR_RADIUS_PX = 6;
/** A five-minute row over a long day is still a visible bar. */
export const MIN_BAR_PERCENT = 0.8;
/** What a struck row's bar dims to: the plan is still readable, it just did not happen. */
export const STRUCK_BAR_OPACITY = 0.35;
/** The strike draws in 450 ms, then the bar dims for the rest of the beat. */
export const STRIKE_MS = 450;
/** Rows come in on the timeline's 60 ms stagger, each over 300 ms. */
export const ROW_ENTER_MS = 300;
export const ROW_STAGGER_MS = 60;
export const ROW_RISE_PX = 6;
/** The totals line's fade: the timeline schedules around the same 200 ms. It
 *  rises a few pixels as it fades, so no entrance is a bare fade. */
export const TOTALS_FADE_MS = 200;
export const TOTALS_RISE_PX = 4;
export const SENTENCE_MS = 600;
export const SENTENCE_RISE_PX = 8;
export const SENTENCE_BLUR_PX = 6;
/** With no sentence the replay ends this long after the totals have landed. */
export const NO_SENTENCE_HOLD_MS = 1200;
/** Continue leaves the stage with a short fade (exits are quicker than entrances). */
export const EXIT_MS = 120;

/* ---------- geometry ---------- */

/** A horizontal stretch of the track, in percent of its width. */
export type Box = { left: number; width: number };

/** What a bar looks like at one instant of its motion. */
export type Frame = {
  /** Percent of the bar's own width. */
  translateX: number;
  /** Percent of the bar's width trimmed from its right edge. */
  clipRight: number;
  opacity: number;
};

export type RowLayout = {
  /** The plan outline, drawn over the bar; null when the plan held nothing or the row did not change. */
  ghost: Box | null;
  /** The bar's box; null only if a row has neither a plan nor an actual. */
  bar: Box | null;
  /** Where the motion starts and the final frame it ends on. */
  from: Frame;
  to: Frame;
  /** False when nothing about the bar changes (an unchanged row). */
  animated: boolean;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function toBox(span: ReplaySpan, range: ReplaySpan): Box {
  const length = Math.max(1, range.end - range.start);
  const left = clamp(((span.start - range.start) / length) * 100, 0, 100);
  const right = clamp(((span.end - range.start) / length) * 100, 0, 100);
  const width = Math.max(MIN_BAR_PERCENT, right - left);
  return { left: round3(Math.min(left, 100 - width)), width: round3(width) };
}

/** Time tracked with no block claims no time of day: the bar starts at the axis origin. */
function originBox(minutes: number, range: ReplaySpan): Box {
  const length = Math.max(1, range.end - range.start);
  return { left: 0, width: round3(Math.max(MIN_BAR_PERCENT, Math.min(100, (minutes / length) * 100))) };
}

const REST: Frame = { translateX: 0, clipRight: 0, opacity: 1 };

/** Where a row's plan outline and bar sit, and the two frames its bar plays between. */
export function layoutRow(row: ReplayRow, range: ReplaySpan): RowLayout {
  const planBox = row.plan === null ? null : toBox(row.plan, range);
  const actualBox =
    row.actual === null ? null : row.placed ? toBox(row.actual, range) : originBox(row.actual.end - row.actual.start, range);

  if (planBox === null && actualBox !== null) {
    return {
      ghost: null,
      bar: actualBox,
      from: { translateX: 0, clipRight: 100, opacity: 0 },
      to: REST,
      animated: true,
    };
  }
  if (planBox !== null && actualBox === null) {
    return {
      ghost: planBox,
      bar: planBox,
      from: REST,
      to: { ...REST, opacity: STRUCK_BAR_OPACITY },
      animated: true,
    };
  }
  if (planBox === null || actualBox === null) {
    return { ghost: null, bar: null, from: REST, to: REST, animated: false };
  }
  if (row.outcome === "unchanged") {
    return { ghost: null, bar: actualBox, from: REST, to: REST, animated: false };
  }

  // The widest the bar is ever drawn: the plan's length or the actual one.
  const width = Math.max(planBox.width, actualBox.width);
  return {
    ghost: planBox,
    bar: { left: planBox.left, width },
    from: { translateX: 0, clipRight: round3((1 - planBox.width / width) * 100), opacity: 1 },
    to: {
      translateX: round3(((actualBox.left - planBox.left) / width) * 100),
      clipRight: round3((1 - actualBox.width / width) * 100),
      opacity: 1,
    },
    animated: true,
  };
}

export function frameTransform(frame: Frame): string {
  return `translateX(${frame.translateX}%)`;
}

export function frameClip(frame: Frame): string {
  return `inset(0 ${frame.clipRight}% 0 0 round ${BAR_RADIUS_PX}px)`;
}

/* ---------- motion plan ---------- */

export type MotionPart = "stage" | "row" | "more" | "bar" | "strike" | "totals" | "sentence";

type Keyframe = Record<string, string | number>;

/** One animation: which element, between which frames, and when. `ease` names a CSS curve token. */
export type MotionEntry = {
  target: { part: MotionPart; key?: string };
  keyframes: Keyframe[];
  options: {
    delay: number;
    duration: number;
    endDelay: number;
    ease: "out" | "inOut";
    fill: "backwards";
  };
};

/**
 * When the playback is over. With a sentence it is the timeline's total (the
 * sentence rises, then holds so it can be read). Without one, the totals line
 * is the last beat and a short hold follows it.
 */
export function playbackEndMs(timeline: ReplayTimeline, hasSentence: boolean): number {
  if (hasSentence) return timeline.totalMs;
  return Math.min(timeline.totalMs, timeline.totalsAtMs + TOTALS_FADE_MS + NO_SENTENCE_HOLD_MS);
}

function entry(
  part: MotionPart,
  key: string | undefined,
  keyframes: Keyframe[],
  delay: number,
  duration: number,
  ease: "out" | "inOut",
  endDelay = 0,
): MotionEntry {
  return { target: key === undefined ? { part } : { part, key }, keyframes, options: { delay, duration, endDelay, ease, fill: "backwards" } };
}

/**
 * Every animation of the replay, from the timeline alone. Unchanged rows only
 * enter; a changed row's bar bends on its own beat (move and stretch on
 * `ease-in-out`, entrances and the strike on `ease-out`); the totals line and
 * the sentence close the story. The last entry lands exactly on
 * `playbackEndMs`.
 */
export function replayMotion(replay: DayReplay, timeline: ReplayTimeline, hasSentence: boolean): MotionEntry[] {
  const end = playbackEndMs(timeline, hasSentence);
  const plan: MotionEntry[] = [];
  const steps = new Map(timeline.steps.map(step => [step.key, step]));

  plan.push(entry("stage", undefined, [{ opacity: 0 }, { opacity: 1 }], 0, timeline.stageInMs, "out"));

  let lastEnterMs = -ROW_STAGGER_MS;
  replay.rows.forEach((row, index) => {
    const step = steps.get(row.key);
    const enterMs = step?.enterMs ?? index * ROW_STAGGER_MS;
    lastEnterMs = Math.max(lastEnterMs, enterMs);
    plan.push(
      entry(
        "row",
        row.key,
        [
          { opacity: 0, transform: `translateY(${ROW_RISE_PX}px)` },
          { opacity: 1, transform: "translateY(0px)" },
        ],
        enterMs,
        ROW_ENTER_MS,
        "out",
      ),
    );

    const action = step?.action;
    if (action === null || action === undefined) return;
    const layout = layoutRow(row, replay.range);
    if (action.kind === "struck") {
      plan.push(
        entry("strike", row.key, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], action.atMs, STRIKE_MS, "out"),
        entry(
          "bar",
          row.key,
          [{ opacity: layout.from.opacity }, { opacity: layout.to.opacity }],
          action.atMs + STRIKE_MS,
          action.durationMs - STRIKE_MS,
          "out",
        ),
      );
    } else if (action.kind === "added") {
      plan.push(
        entry(
          "bar",
          row.key,
          [
            { opacity: layout.from.opacity, clipPath: frameClip(layout.from) },
            { opacity: layout.to.opacity, clipPath: frameClip(layout.to) },
          ],
          action.atMs,
          action.durationMs,
          "out",
        ),
      );
    } else {
      plan.push(
        entry(
          "bar",
          row.key,
          [
            { transform: frameTransform(layout.from), clipPath: frameClip(layout.from) },
            { transform: frameTransform(layout.to), clipPath: frameClip(layout.to) },
          ],
          action.atMs,
          action.durationMs,
          "inOut",
        ),
      );
    }
  });

  if (replay.more !== null) {
    plan.push(
      entry(
        "more",
        undefined,
        [
          { opacity: 0, transform: `translateY(${ROW_RISE_PX}px)` },
          { opacity: 1, transform: "translateY(0px)" },
        ],
        lastEnterMs + ROW_STAGGER_MS,
        ROW_ENTER_MS,
        "out",
      ),
    );
  }

  plan.push(
    entry(
      "totals",
      undefined,
      [
        { opacity: 0, transform: `translateY(${TOTALS_RISE_PX}px)` },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      timeline.totalsAtMs,
      TOTALS_FADE_MS,
      "out",
      hasSentence ? 0 : end - timeline.totalsAtMs - TOTALS_FADE_MS,
    ),
  );

  if (hasSentence) {
    plan.push(
      entry(
        "sentence",
        undefined,
        [
          { opacity: 0, transform: `translateY(${SENTENCE_RISE_PX}px)`, filter: `blur(${SENTENCE_BLUR_PX}px)` },
          { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
        ],
        timeline.sentenceAtMs,
        SENTENCE_MS,
        "out",
        timeline.totalMs - timeline.sentenceAtMs - SENTENCE_MS,
      ),
    );
  }
  return plan;
}

/* ---------- copy ---------- */

/** The row's name; an untitled manual block is a work block. */
export function rowTitle(row: ReplayRow): string {
  return row.label.trim() || t("shutdown.workBlock");
}

function rowSentence(row: ReplayRow): string {
  const title = rowTitle(row);
  const planned = minutesText(row.plannedMinutes);
  const actual = minutesText(row.actualMinutes);
  switch (row.outcome) {
    case "unchanged": return t("replay.sr.unchanged", { title, planned });
    case "moved": return t("replay.sr.moved", { title, planned });
    case "stretched": return t("replay.sr.stretched", { title, planned, actual });
    case "shrunk": return t("replay.sr.shrunk", { title, planned, actual });
    case "struck": return t("replay.sr.struck", { title, planned });
    case "added": return t("replay.sr.added", { title, actual });
  }
}

export function totalsText(replay: DayReplay): string {
  return t("replay.totals", { planned: minutesText(replay.plannedMinutes), tracked: minutesText(replay.trackedMinutes) });
}

/**
 * The replay as one text for a screen reader, announced once when the stage
 * mounts (not per frame): every row, what the cap folded away, the totals and
 * the sentence. The animated chart is `aria-hidden`.
 */
export function replayAnnouncement(replay: DayReplay, sentence: string | null): string {
  const parts = replay.rows.map(row => (row.done ? `${rowSentence(row)} ${t("replay.sr.done")}` : rowSentence(row)));
  if (replay.more !== null) parts.push(t("replay.more", { count: replay.more.count }));
  parts.push(totalsText(replay));
  if (sentence) parts.push(sentence);
  return parts.join(" ");
}

/** The wall clock of `minutes` elapsed since the zone's midnight of `day` ("24:00" at the day's end). */
export function axisLabel(day: string, timeZone: string, minutes: number): string {
  const instant = new Date(Date.parse(toZonedInstant(`${day}T00:00`, timeZone)) + minutes * 60_000);
  return dateKey(instant, timeZone) === day ? timeLabel(instant, timeZone) : "24:00";
}

/** "09:00 – 18:00": the visible range, in the profile zone. */
export function rangeLabel(replay: DayReplay, timeZone: string): string {
  return `${axisLabel(replay.day, timeZone, replay.range.start)} – ${axisLabel(replay.day, timeZone, replay.range.end)}`;
}

/**
 * The weekly review's pure view half (S3, ronda 2 W2b): the step metadata the
 * flow renders, the words the Review step shows, and the labels the banner and
 * the Rituals rows share.
 *
 * No Firebase, no React, no clock: everything here takes the data
 * `planning/weekly.ts` already computed and answers with strings and ordered
 * lists, the way `ui/shutdownRitual.ts` owns the shutdown ritual's copy. The
 * sentences are pinned by unit tests so no component invents a wording of its
 * own.
 */

import type { DueMoment, WeeklyMoment, WeeklyNumbers, WeeklyReviewStep } from "../../planning/weekly.ts";
import { formatDuration, formatWall, keyToWallUtc } from "../time.ts";

/** The four steps in flow order, with the copy each pane shows. */
export type StepMeta = {
  id: WeeklyReviewStep;
  label: string;
  /** The pane's one-line lede. */
  lede: string;
};

export const weeklyStepMeta: readonly StepMeta[] = [
  { id: "review", label: "Review", lede: "How the week actually went." },
  { id: "cleanup", label: "Clean up", lede: "Decide what to do with what is left over." },
  { id: "plan", label: "Plan", lede: "Set next week's priorities and time." },
  { id: "reflect", label: "Reflect", lede: "A short note for yourself." },
];

function metaOf(step: WeeklyReviewStep): StepMeta {
  const found = weeklyStepMeta.find(entry => entry.id === step);
  if (found === undefined) throw new Error(`unknown weekly review step: ${step}`);
  return found;
}

export function stepLabel(step: WeeklyReviewStep): string {
  return metaOf(step).label;
}

export function stepLede(step: WeeklyReviewStep): string {
  return metaOf(step).lede;
}

/**
 * The steps this visit of the flow runs, in flow order: exactly the steps the
 * due moment offers (its own plus the earlier moments' unfinished ones), or
 * all four when the review was opened by hand and nothing is due.
 */
export function stepsToShow(due: DueMoment | null): WeeklyReviewStep[] {
  const order: WeeklyReviewStep[] = ["review", "cleanup", "plan", "reflect"];
  if (due === null) return order;
  return order.filter(step => due.steps.includes(step));
}

/** "Oct 19 – Oct 25": the week the review is about, from its bounding day keys. */
export function weekRangeLabel(monday: string, sunday: string): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${formatWall(keyToWallUtc(monday), options)} – ${formatWall(keyToWallUtc(sunday), options)}`;
}

/** "Week 43": the week key's own number, for headings and announcements. */
export function weekNumberLabel(week: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  return match === null ? week : `Week ${Number(match[2])}`;
}

/** The banner's sentence: when the moment opens, in the zone's weekday words. */
export function momentLabel(moment: WeeklyMoment): string {
  const day = weekdayName(moment.day);
  const hours = Math.floor(moment.time / 60);
  const minutes = moment.time % 60;
  return `${day} at ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The JavaScript weekday number (0 = Sunday) as the UI's word. */
export function weekdayName(day: number): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[((day % 7) + 7) % 7];
}

/** The steps a moment runs, as the Rituals row reads them, in flow order. */
export function momentStepsLabel(steps: readonly WeeklyReviewStep[]): string {
  return weeklyStepMeta
    .filter(meta => steps.includes(meta.id))
    .map(meta => meta.label)
    .join(", ");
}

/**
 * The Review step's sentences (S3: a few numbers, no charts, no streaks).
 * Every line names one fact of the week; the caller renders them in order.
 * `actualIsPartial` (r2-w2c) marks the tracked total as approximate while the
 * per-day history catches up, and the planned line says so quietly.
 */
export function reviewSentences(
  numbers: WeeklyNumbers,
  actualIsPartial = false,
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];

  const planned = formatDuration(numbers.plannedMinutes);
  const actual = formatDuration(numbers.actualMinutes);
  lines.push({
    label: "Planned vs actual",
    value: numbers.actualMinutes > 0
      ? `${planned} planned · ${actual} tracked${actualIsPartial ? " (approximate)" : ""}`
      : `${planned} planned · nothing tracked yet`,
  });

  if (numbers.biasRatio !== null) {
    lines.push({ label: "Estimation", value: biasSentence(numbers.biasRatio) });
  }

  lines.push({
    label: "Done",
    value: numbers.plannedCount === 0
      ? `${numbers.doneCount} ${numbers.doneCount === 1 ? "task" : "tasks"} completed`
      : `${numbers.doneCount} of ${numbers.plannedCount} planned ${numbers.plannedCount === 1 ? "tasks" : "tasks"} completed`,
  });

  return lines;
}

/**
 * The estimation bias in words (S3: reuse the planning bias, a record rather
 * than a suggestion). The same neutral band `planning/bias.ts` stays quiet in
 * reads as "close to your estimates"; outside it the ratio is said plainly.
 */
export function biasSentence(ratio: number): string {
  if (ratio >= 1.1) return `Tasks took about ${ratio.toFixed(1)}× their estimates.`;
  if (ratio <= 0.9) return `Tasks took about ${ratio.toFixed(1)}× their estimates — faster than planned.`;
  return "Time landed close to your estimates.";
}

/** "Where the time went", as the top three's own lines; empty when nothing was tracked. */
export function topTaskLines(top: readonly { title: string; minutes: number }[]): { title: string; value: string }[] {
  return top.map(entry => ({ title: entry.title, value: formatDuration(entry.minutes) }));
}

/**
 * The Clean-up action's labels and toasts, in the row's order. The words are
 * data so the buttons and the unit tests share one table.
 */
export const cleanupActionLabels: Record<"this-week" | "someday" | "delete", string> = {
  "this-week": "This week",
  someday: "Someday",
  delete: "Delete",
};

/** The reason a candidate shows. `today` is accepted for symmetry with the
 *  row that renders it; the label does not depend on the date. */
export function cleanupReasonLabel(reason: "overdue" | "scheduled-not-done", _today: string): string {
  return reason === "overdue" ? "Overdue" : "Was scheduled this week";
}

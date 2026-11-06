/**
 * Everything the closing ritual hands the day replay stage (day-replay plan
 * §1, §4, §5), assembled in one pure place so the sheet and the palette agree
 * on what a day's replay is, or that there is none.
 *
 * - the plan is the device's morning snapshot of the day when it kept one
 *   (`planSnapshot`), otherwise today's blocks as they stand;
 * - the sentence reads the finished-task history, but only the title words of
 *   the tasks tracked or finished on the replay day (`dayBias`), so it is a
 *   reflection on that day and not on the whole history.
 *
 * No DOM, no React, no Firebase: the storage is a parameter.
 */

import type { BiasSample } from "../planning/bias.ts";
import { dayBias } from "../planning/dayBias.ts";
import {
  buildDayReplay,
  replayTimeline,
  type DayReplay,
  type ReplayBlock,
  type ReplayTask,
  type ReplayTimeline,
} from "../planning/dayReplay.ts";
import { readPlanSnapshot, type SnapshotStorage } from "../planning/planSnapshot.ts";
import { dateKey } from "./time.ts";

/** The task fields the replay reads; `TaskView` fits without adapters. */
export type ReplayInputTask = ReplayTask;

export type PreparedReplay = {
  replay: DayReplay;
  /** Null for a day where nothing changed: the stage shows one static line. */
  timeline: ReplayTimeline | null;
  sentence: string | null;
  basis: string | null;
};

function trackedOn(task: ReplayTask, day: string): boolean {
  const minutes = task.actualByDay?.[day];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
}

function finishedOn(task: ReplayTask, day: string, timeZone: string): boolean {
  if (!task.completed || task.completedAt === undefined) return false;
  const stamp = Date.parse(task.completedAt);
  return Number.isFinite(stamp) && dateKey(new Date(stamp), timeZone) === day;
}

/** The replay of one profile-zone day, or null when the day held nothing to compare. */
export function prepareDayReplay(input: {
  uid: string;
  day: string;
  timeZone: string;
  tasks: readonly ReplayInputTask[];
  blocks: readonly ReplayBlock[];
  /** `completedSamples(tasks)`: the finished-task history the bias reads. */
  samples: readonly BiasSample[];
  storage: SnapshotStorage | null;
}): PreparedReplay | null {
  const { uid, day, timeZone, tasks, blocks, samples, storage } = input;
  const snapshot = readPlanSnapshot(storage, uid, day);
  const replay = buildDayReplay({ day, timeZone, tasks, blocks, plan: snapshot?.blocks });
  if (replay === null) return null;
  const today = tasks.filter(task => trackedOn(task, day) || finishedOn(task, day, timeZone));
  const bias = dayBias(samples, today);
  return {
    replay,
    timeline: replayTimeline(replay),
    sentence: bias?.sentence ?? null,
    basis: bias?.basis ?? null,
  };
}

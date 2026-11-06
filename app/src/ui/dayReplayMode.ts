/**
 * The day replay's device-local switches (day-replay plan §1, L5): whether the
 * replay plays by itself after closing the day, and which day it last did.
 * Both live in `localStorage` like the morning brief's dismissal
 * (`shutdownRitual.briefStorageKey`): a property of this screen, not of the
 * planner, so no profile write and no data change.
 *
 * - `auto`: plays once a day after the close, with Skip; also on request.
 * - `request`: only the "Replay the day" button and the palette action.
 * - `off`: the feature is hidden everywhere.
 *
 * A browser that refuses storage reads as the default and loses nothing but
 * the memory of the choice.
 */

import type { SnapshotStorage } from "../planning/planSnapshot.ts";

export type ReplayMode = "auto" | "request" | "off";

export const replayModes: readonly ReplayMode[] = ["auto", "request", "off"];

/** The slice of `Storage` this module uses, so tests need no DOM. */
export type ReplayStorage = Pick<Storage, "getItem" | "setItem">;

export const replayModeKey = "planner-replay-mode";

/** The last profile-zone day the replay auto-played on this device, per user. */
export const replaySeenKey = (uid: string): string => `planner-replay-seen:${uid}`;

/** The browser's storage, or null when it refuses access (hardened modes throw). */
export function deviceReplayStorage(): ReplayStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The same storage as the morning plan snapshots need (`planSnapshot`): the whole `Storage` surface they use. */
export function deviceSnapshotStorage(): SnapshotStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readReplayMode(storage: ReplayStorage | null = deviceReplayStorage()): ReplayMode {
  try {
    const stored = storage?.getItem(replayModeKey);
    return replayModes.find(mode => mode === stored) ?? "auto";
  } catch {
    return "auto";
  }
}

export function writeReplayMode(mode: ReplayMode, storage: ReplayStorage | null = deviceReplayStorage()): void {
  try {
    storage?.setItem(replayModeKey, mode);
  } catch {
    // The choice holds for this mount only.
  }
}

export function readReplaySeen(uid: string, storage: ReplayStorage | null = deviceReplayStorage()): string | null {
  try {
    return storage?.getItem(replaySeenKey(uid)) ?? null;
  } catch {
    return null;
  }
}

export function writeReplaySeen(uid: string, day: string, storage: ReplayStorage | null = deviceReplayStorage()): void {
  try {
    storage?.setItem(replaySeenKey(uid), day);
  } catch {
    // Worst case the replay offers itself once more on this device.
  }
}

/** Whether closing `day` plays the replay by itself: auto mode, not played that day yet. */
export function autoPlays(input: { mode: ReplayMode; seen: string | null; day: string }): boolean {
  return input.mode === "auto" && input.seen !== input.day;
}

/**
 * The morning plan snapshot (Day replay, plan §4): a device-local copy of the
 * day's blocks as they stood when the day was first seen, so the replay can
 * show what moved, what was dropped and what was added. Blocks keep no history
 * on the server and this adds none: nothing here touches Firestore, rules or
 * the profile.
 *
 * Pure of the DOM: the storage is passed in (a `Storage`, or null when the
 * browser refuses one), and every read and write swallows a storage that
 * throws, because a missing snapshot only means the replay falls back to the
 * day's current blocks. Day bounds come from the profile zone through
 * `ui/time.ts`, never from the browser's clock zone.
 */

import type { WorkBlock } from "../domain/model.ts";
import { dayMs, keyToWallUtc, toZonedInstant, wallDayKey } from "../ui/time.ts";

/** The slice of `Storage` this module uses, so tests need no DOM. */
export type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type PlanSnapshotBlock = {
  id: string;
  start: string;
  end: string;
  taskId?: string;
  /** Resolved at capture, so a task deleted later still has its name. */
  title: string;
};

export type PlanSnapshot = {
  v: 1;
  day: string;
  zone: string;
  takenAt: string;
  blocks: PlanSnapshotBlock[];
};

export type CaptureInput = {
  uid: string;
  /** The profile-zone day key being captured. */
  day: string;
  zone: string;
  now: Date;
  blocks: readonly WorkBlock[];
  /** The current title of a task, or undefined when it is gone. */
  taskTitle: (taskId: string) => string | undefined;
};

const keyPrefix = "planner-day-plan:";
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
/** Days of snapshots kept per user, the captured day included. */
const keptDays = 8;
const maxBlocks = 60;
const maxTitle = 140;

export function planSnapshotKey(uid: string, day: string): string {
  return `${keyPrefix}${uid}:${day}`;
}

/** The stored snapshot of a day, or null when absent, corrupt or unreadable. */
export function readPlanSnapshot(storage: SnapshotStorage | null, uid: string, day: string): PlanSnapshot | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(planSnapshotKey(uid, day));
    return raw === null ? null : parseSnapshot(JSON.parse(raw), day);
  } catch {
    return null;
  }
}

/**
 * Stores the day's blocks unless a valid snapshot of that day already exists
 * (first capture wins). A day with no blocks stores nothing, so the morning
 * plan is the first non-empty one rather than an empty page that would turn
 * every later block into an "added" row. Returns whether a snapshot was
 * written.
 */
export function capturePlanSnapshot(storage: SnapshotStorage | null, input: CaptureInput): boolean {
  if (!storage || !dayPattern.test(input.day)) return false;
  try {
    if (readPlanSnapshot(storage, input.uid, input.day)) return false;
    const blocks = dayBlocks(input);
    if (blocks.length === 0) return false;
    const snapshot: PlanSnapshot = { v: 1, day: input.day, zone: input.zone, takenAt: input.now.toISOString(), blocks };
    storage.setItem(planSnapshotKey(input.uid, input.day), JSON.stringify(snapshot));
    prune(storage, input.uid);
    return true;
  } catch {
    return false;
  }
}

/** The non-imported blocks that overlap the zone's day, earliest first. */
function dayBlocks(input: CaptureInput): PlanSnapshotBlock[] {
  const dayStart = Date.parse(toZonedInstant(`${input.day}T00:00`, input.zone));
  const nextDay = wallDayKey(keyToWallUtc(input.day) + dayMs);
  const dayEnd = Date.parse(toZonedInstant(`${nextDay}T00:00`, input.zone));
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) return [];
  return input.blocks
    .filter(block => block.source === undefined)
    .map(block => ({ block, start: Date.parse(block.start), end: Date.parse(block.end) }))
    .filter(item => item.start < dayEnd && item.end > dayStart)
    .sort((a, b) => a.start - b.start || (a.block.id < b.block.id ? -1 : 1))
    .slice(0, maxBlocks)
    .map(({ block }) => {
      const title = (block.taskId ? input.taskTitle(block.taskId) : undefined) ?? block.title ?? "";
      const stored: PlanSnapshotBlock = { id: block.id, start: block.start, end: block.end, title: title.slice(0, maxTitle) };
      if (block.taskId) stored.taskId = block.taskId;
      return stored;
    });
}

/** Drops this user's snapshots older than the newest `keptDays` days. */
function prune(storage: SnapshotStorage, uid: string): void {
  const prefix = `${keyPrefix}${uid}:`;
  const own: Array<{ key: string; day: string }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(prefix)) continue;
    const day = key.slice(prefix.length);
    if (dayPattern.test(day)) own.push({ key, day });
  }
  own.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  for (const stale of own.slice(keptDays)) storage.removeItem(stale.key);
}

function parseSnapshot(value: unknown, day: string): PlanSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.day !== day) return null;
  if (typeof record.zone !== "string" || typeof record.takenAt !== "string" || !Array.isArray(record.blocks)) return null;
  const blocks: PlanSnapshotBlock[] = [];
  for (const entry of record.blocks) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.start !== "string" || typeof item.end !== "string" || typeof item.title !== "string") return null;
    const block: PlanSnapshotBlock = { id: item.id, start: item.start, end: item.end, title: item.title };
    if (typeof item.taskId === "string") block.taskId = item.taskId;
    blocks.push(block);
  }
  return { v: 1, day, zone: record.zone, takenAt: record.takenAt, blocks };
}

import { useEffect, useRef } from "react";
import type { WorkBlock } from "../domain/model.ts";
import { capturePlanSnapshot, readPlanSnapshot, type SnapshotStorage } from "../planning/planSnapshot.ts";
import { dateKey } from "./time.ts";

/** The browser's storage, or null when it refuses access (hardened modes throw). */
function deviceStorage(): SnapshotStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Takes the device-local morning plan snapshot (Day replay): the day's blocks
 * the first time this device sees them settled. Write-once per day, so the
 * hook can run on every change; `ready` must mean the store has loaded, the
 * profile zone is known and no write is waiting for the server, so a snapshot
 * never records an unconfirmed edit. `now` is the shell's clock, which carries
 * the capture across midnight.
 */
export function useDayPlanSnapshot({
  uid,
  ready,
  blocks,
  tasks,
  timeZone,
  now,
}: {
  uid: string;
  ready: boolean;
  blocks: readonly WorkBlock[];
  tasks: ReadonlyArray<{ id: string; title: string }>;
  timeZone: string | null;
  now: Date;
}): void {
  const captured = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || timeZone === null) return;
    const day = dateKey(now, timeZone);
    const marker = `${uid}:${day}`;
    if (captured.current === marker) return;
    const storage = deviceStorage();
    const titles = new Map(tasks.map(task => [task.id, task.title]));
    capturePlanSnapshot(storage, { uid, day, zone: timeZone, now, blocks, taskTitle: id => titles.get(id) });
    // An empty day stores nothing, so only a stored snapshot ends the attempts.
    if (readPlanSnapshot(storage, uid, day)) captured.current = marker;
  }, [uid, ready, blocks, tasks, timeZone, now]);
}

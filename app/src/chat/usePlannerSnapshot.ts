/**
 * Feeds the planner context from the existing read-only data hooks:
 * `useStore`'s tasks and blocks map onto the context's pure shape; the time
 * zone comes from the user profile. This hook writes nothing — it only reads
 * the same views the rest of the app renders.
 */

import { useMemo } from "react";
import { browserTimeZone, useProfileTimeZone } from "../data/profile.ts";
import { effectiveKind } from "../domain/holidays.ts";
import { useStore } from "../data/store.ts";
import type { PlannerSnapshot } from "./plannerContext.ts";

export type PlannerSnapshotResult = {
  snapshot: PlannerSnapshot;
  timeZone: string;
  loading: boolean;
};

export function usePlannerSnapshot(uid: string | null): PlannerSnapshotResult {
  const store = useStore(uid);
  const profile = useProfileTimeZone(uid);

  const snapshot = useMemo<PlannerSnapshot>(
    () => ({
      blocks: store.blocks.map(block => ({
        id: block.id,
        start: block.start,
        end: block.end,
        ...(block.taskId === undefined ? {} : { taskId: block.taskId }),
        ...(block.title === undefined ? {} : { title: block.title }),
      })),
      tasks: store.tasks.map(task => ({
        id: task.id,
        title: task.title,
        completed: task.completed,
        ...(task.estimate === undefined ? {} : { estimateMinutes: task.estimate }),
        ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
      })),
      // Holiday labels: the read/hide tools and the context text
      // see the user's own classification, exactly like the Holidays sheet.
      holidays: store.holidays.map(holiday => ({
        id: holiday.id,
        date: holiday.date,
        title: holiday.title,
        kind: effectiveKind(holiday),
        ...(holiday.hidden === true ? { hidden: true } : {}),
      })),
    }),
    [store.blocks, store.tasks, store.holidays],
  );

  // A profile still loading has no zone yet; the browser's zone is the
  // same fallback the rest of the app assumes.
  return { snapshot, timeZone: profile.timeZone ?? browserTimeZone, loading: store.loading || profile.loading };
}

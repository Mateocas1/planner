import { doc, increment, updateDoc, type Firestore } from "firebase/firestore";
import { MAX_ACTUAL_MINUTES } from "../domain/model.ts";

/**
 * The `actualMinutes` decrement of the idle-away flow, kept
 * apart from `tasks.ts` and taking the database as a parameter: that module
 * imports the app's client, which resolves its project from
 * `window.location`, so the emulator test could not load it. `tasks.ts`
 * `subtractActualMinutes` passes the app's database.
 */

/**
 * Validates the day key a tracked minute count is attributed to (ronda 2
 * S3/L6): a real calendar `YYYY-MM-DD`, the same shape `ui/time.ts`
 * `dateKey` produces in the profile zone. The check guards programmer error
 * at the write boundary — a map entry under a non-day key would be a minute
 * no weekly number could ever place.
 */
const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

export function requireActualDayKey(dayKey: string): string {
  const stamp = dayKeyPattern.test(dayKey) ? Date.parse(`${dayKey}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== dayKey) {
    throw new Error(`expected a valid date-only day key (YYYY-MM-DD), got ${JSON.stringify(dayKey)}`);
  }
  return dayKey;
}

/**
 * One tracked-minutes write: the cumulative counter and the day map move
 * together, in the SAME `updateDoc`, so the two transforms are atomic and
 * offline-safe exactly like the single-counter write they replace. Firestore
 * increments on absent fields count from zero, so neither a new task nor a
 * first write on a day needs a read.
 */
export async function subtractActualMinutesIn(db: Firestore, uid: string, taskId: string, minutes: number, dayKey: string) {
  if (typeof taskId !== "string" || taskId === "" || taskId.includes("/")) throw new Error("task ID is invalid");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ACTUAL_MINUTES) {
    throw new Error(`actual minutes to subtract must be a whole minute count between 1 and ${MAX_ACTUAL_MINUTES}`);
  }
  requireActualDayKey(dayKey);
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), {
    actualMinutes: increment(-minutes),
    [`actualByDay.${dayKey}`]: increment(-minutes),
  });
}

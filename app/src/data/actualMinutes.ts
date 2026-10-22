import { doc, increment, updateDoc, type Firestore } from "firebase/firestore";
import { MAX_ACTUAL_MINUTES } from "../domain/model.ts";

/**
 * The `actualMinutes` decrement of the idle-away flow (T9, spec S8.5), kept
 * apart from `tasks.ts` and taking the database as a parameter: that module
 * imports the app's client, which resolves its project from
 * `window.location`, so the emulator test could not load it. `tasks.ts`
 * `subtractActualMinutes` passes the app's database.
 */
export async function subtractActualMinutesIn(db: Firestore, uid: string, taskId: string, minutes: number) {
  if (typeof taskId !== "string" || taskId === "" || taskId.includes("/")) throw new Error("task ID is invalid");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ACTUAL_MINUTES) {
    throw new Error(`actual minutes to subtract must be a whole minute count between 1 and ${MAX_ACTUAL_MINUTES}`);
  }
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { actualMinutes: increment(-minutes) });
}

import { addDoc, collection, deleteDoc, deleteField, doc, increment, setDoc, updateDoc, writeBatch, type Firestore } from "firebase/firestore";
import { createTask, MAX_ACTUAL_MINUTES, parseActualByDay, requireActualMinutes, requireEstimate, requireInstant, type Task } from "../domain/model.ts";
import { planUndo, type ShutdownPlan, type ShutdownState, type UndoRefusal } from "../planning/shutdown.ts";
import { db } from "./client.ts";
import { requireActualDayKey, subtractActualMinutesIn } from "./actualMinutes.ts";
import { forgetRemoval, trackRemoval } from "./pending.ts";
import { profileDocument } from "./profile.ts";

/**
 * Task write helpers against `users/{uid}/tasks`. Each helper validates through
 * the domain module first and throws before any write on invalid input, so
 * errors propagate to the caller (the surface displays them; nothing is
 * swallowed here).
 */

/**
 * The stored shape of a task: the closed set of fields a task document holds.
 * Optional fields are omitted rather than written as null. Every task write
 * path that rewrites a whole document (create, restore, import) goes through
 * here, so a restored task is the document that was deleted. `someday` is the
 * weekly review's Clean-up shelf flag (S3); it rides the same closed list so
 * a delete → undo does not silently un-shelve the task. So does
 * `actualByDay` (ronda 2 S3/L6): the per-day map is tracked data, and undo
 * must no more drop it than the counter it belongs to.
 */
export function taskFields(task: Task, completed: boolean, completedAt?: string, someday?: boolean): Record<string, unknown> {
  return {
    title: task.title,
    completed,
    ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
    ...(task.estimate === undefined ? {} : { estimate: task.estimate }),
    ...(task.actualMinutes === undefined ? {} : { actualMinutes: task.actualMinutes }),
    ...(task.actualByDay === undefined ? {} : { actualByDay: task.actualByDay }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(someday === true ? { someday: true } : {}),
  };
}

export async function addTask(uid: string, title: string, deadline?: string, estimate?: number) {
  const task = createTask("pending-mint", title, deadline, estimate);
  await addDoc(collection(db, `users/${uid}/tasks`), taskFields(task, false));
}

export async function renameTask(uid: string, taskId: string, title: string) {
  const task = createTask(taskId, title);
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { title: task.title });
}

/**
 * Sets or clears the estimate on a task. The estimate is validated through
 * the domain module (requireEstimate) before any write; a missing estimate
 * removes the field from the document.
 */
export async function setTaskEstimate(uid: string, taskId: string, estimate?: number) {
  if (estimate === undefined) {
    await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { estimate: deleteField() });
    return;
  }
  requireEstimate(estimate);
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { estimate });
}

/**
 * Adds minutes of real work to a task (F2b), one focus session at a time.
 *
 * The write is a pair of Firestore `increment()` transforms in ONE
 * `updateDoc` — the cumulative counter and the day map entry
 * `actualByDay.<dayKey>` — so they land atomically, commute with every other
 * device's increments and queue offline like any other write (ronda 2 S3/L6).
 * No read is needed to record a session and nothing is lost while offline.
 *
 * `dayKey` is the profile-zone `YYYY-MM-DD` the tracked minutes belong to:
 * for a focus session, the day the session started (domain/focus.ts
 * `sessionDayKey`), never "now" at write time. Only whole positive minutes
 * are accepted: the caller (the focus timer) is what decides whether a
 * session is worth recording at all.
 */
export async function addActualMinutes(uid: string, taskId: string, minutes: number, dayKey: string, database: Firestore = db) {
  if (typeof taskId !== "string" || taskId === "" || taskId.includes("/")) throw new Error("task ID is invalid");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ACTUAL_MINUTES) {
    throw new Error(`actual minutes to add must be a whole minute count between 1 and ${MAX_ACTUAL_MINUTES}`);
  }
  requireActualDayKey(dayKey);
  await updateDoc(doc(database, `users/${uid}/tasks/${taskId}`), {
    actualMinutes: increment(minutes),
    [`actualByDay.${dayKey}`]: increment(minutes),
  });
}

/**
 * Removes minutes from a task's counter (T9 idle away, spec S8.5): a session
 * the user spent mostly away, confirmed after its own minutes already landed.
 *
 * It is the same write path as `addActualMinutes` -- one `updateDoc` with a
 * negative transform on both `actualMinutes` and the away day's map entry --
 * so it queues offline, commutes with every other device's increments and
 * never needs a read. `dayKey` is the day the away span belongs to (the hook
 * passes it from the confirmed spans), not "now" at write time. What it
 * cannot do is see the counter: keeping the result non-negative is the
 * caller's clamp (domain/idle.ts `clampSubtraction`), exactly once by the
 * applied ledger, and this helper only refuses anything that is not a whole
 * positive minute.
 */
export async function subtractActualMinutes(uid: string, taskId: string, minutes: number, dayKey: string) {
  await subtractActualMinutesIn(db, uid, taskId, minutes, dayKey);
}

export async function setTaskCompleted(uid: string, taskId: string, completed: boolean) {
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), completed
    ? { completed: true, completedAt: new Date().toISOString() }
    : { completed: false, completedAt: deleteField() });
}

/**
 * Sets or clears the deadline on a task. A present deadline is validated as a
 * date-only value through the domain module (createTask) before any write; a
 * missing deadline removes the field from the document. Only the deadline
 * field is written; the current title is passed in solely for validation.
 */
export async function setTaskDeadline(uid: string, taskId: string, title: string, deadline?: string) {
  if (deadline === undefined) {
    await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { deadline: deleteField() });
    return;
  }
  createTask(taskId, title, deadline);
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { deadline });
}

export async function deleteTask(uid: string, taskId: string, database: Firestore = db) {
  const path = `users/${uid}/tasks/${taskId}`;
  await trackRemoval(path, deleteDoc(doc(database, path)));
}

/**
 * Applies the shutdown roll (F3a) as exactly one `writeBatch`: a deadline
 * update per move, plus `profile.lastShutdown = plan.today`. The batch is
 * atomic, so a rejected write changes nothing at all — the sheet can then say
 * "Nothing changed" and mean it — and it is queued offline like any other
 * write, so closing the day on a train does not lose the roll.
 *
 * Every write names one field: `deadline` through an update, the stamp through
 * a merged set. A task keeps its estimate, its completion instant, its title
 * and any field this version does not know about; the profile keeps every
 * other setting.
 *
 * Offline replay is last-writer-wins, and that is deliberate. A queued batch
 * replays the absolute `deadline: tomorrow` with no precondition, so if another
 * device edited that deadline while this one was offline, the replay overwrites
 * it. That is this app's rule for every field write (the last one to land
 * wins), and a transaction could not replace it: Firestore transactions fail
 * offline, and closing the day without connectivity has to keep working. Undo
 * is where the rule is checked, against the local state the app holds.
 *
 * The plan is pure and already validated (`planning/shutdown.ts`), and a plan
 * that wrote nothing — an already closed day, or a day with more due tasks than
 * one batch can hold — commits nothing, which is what makes the ritual
 * idempotent across devices rather than merely repeatable and keeps undo exact.
 *
 * The database is a parameter with the app's client as its default so the
 * emulator suite can drive this real batch against its own authenticated
 * client; every surface calls it with two arguments.
 */
export async function closeDay(uid: string, plan: ShutdownPlan, database: Firestore = db) {
  if (plan.alreadyClosed || plan.refused !== undefined) return;
  const batch = writeBatch(database);
  for (const move of plan.moves) {
    batch.update(doc(database, `users/${uid}/tasks/${move.taskId}`), { deadline: move.after });
  }
  batch.set(profileDocument(uid, database), { lastShutdown: plan.today }, { merge: true });
  await batch.commit();
}

/** What an undo did: how many deadlines it put back, how many edits it left
 * alone, and — when it refused — that it wrote nothing. */
export type UndoCloseDayResult = { reverted: number; skipped: number; refused?: UndoRefusal };

/**
 * Undoes a roll, checked against the state the app holds now instead of
 * replayed blind: `planUndo` refuses when the profile's stamp is no longer the
 * one this close wrote (a later close owns it), and reverts only the tasks
 * whose deadline is still the one the close wrote, counting the edits that came
 * after it. A refusal returns before the batch is built, so it cannot write
 * anything.
 *
 * The rest of the undo is one batch: every reverted deadline, and
 * `lastShutdown` back to the raw value the plan recorded — the field is
 * deleted only when the close being undone was the first one, because "no
 * stamp" is not any particular day. Nothing else in a task or in the profile
 * document is touched (each write is an update or a merged set).
 *
 * `state` is what `useStore` and the profile snapshot hold, so pending local
 * writes are part of the comparison and undo works offline. A write landing
 * between reading that state and committing this batch still wins, exactly as
 * it does for every other write here. The batch fits by construction: an
 * undoable plan carries at most `maxCloseDayMoves` moves, plus the stamp.
 */
export async function undoCloseDay(
  uid: string,
  plan: ShutdownPlan,
  state: ShutdownState,
  database: Firestore = db,
): Promise<UndoCloseDayResult> {
  const undo = planUndo(plan, state);
  if (undo.refused !== undefined) return { reverted: 0, skipped: 0, refused: undo.refused };
  const batch = writeBatch(database);
  for (const write of undo.deadlines) {
    batch.update(doc(database, `users/${uid}/tasks/${write.taskId}`), { deadline: write.deadline });
  }
  batch.set(
    profileDocument(uid, database),
    { lastShutdown: undo.lastShutdown === undefined ? deleteField() : undo.lastShutdown },
    { merge: true },
  );
  await batch.commit();
  return { reverted: undo.deadlines.length, skipped: undo.skipped };
}

/** A task exactly as it was stored, captured before it is deleted. */
export type DeletedTask = {
  id: string;
  title: string;
  completed: boolean;
  deadline?: string;
  estimate?: number;
  /** The tracked minutes the focus timer accumulated; undo must not lose them. */
  actualMinutes?: number;
  /** The same minutes attributed per day (S3/L6); undo must not lose them. */
  actualByDay?: Record<string, number>;
  completedAt?: string;
  /** The weekly review's Clean-up shelf flag (S3); undo must not un-shelve
   *  the task any more than it may drop its deadline. */
  someday?: boolean;
};

/**
 * Puts a deleted task back under its original document id and with the exact
 * fields it held, which is what undo promises. The document schema for a task
 * is closed (title, completed, optional deadline, estimate, actualMinutes,
 * completedAt, someday), so rewriting those fields with setDoc reproduces the
 * original document rather than approximating it. The title and deadline are
 * validated through the domain module first; estimate and actualMinutes are
 * validated only when present.
 */
export async function restoreTask(uid: string, task: DeletedTask, database: Firestore = db) {
  if (!task.id || task.id.includes("/")) throw new Error("task ID is invalid");
  const validated = createTask(task.id, task.title, task.deadline, task.estimate);
  if (task.actualMinutes !== undefined) requireActualMinutes(task.actualMinutes);
  // The map is normalized through the domain reader, exactly like the read
  // path: the snapshot usually comes from `toTask`, so this only re-asserts
  // what a reader would accept.
  const actualByDay = task.actualByDay === undefined ? undefined : parseActualByDay(task.actualByDay);
  if (task.completedAt !== undefined) requireInstant(task.completedAt);
  const path = `users/${uid}/tasks/${task.id}`;
  const restored: Task = task.actualMinutes === undefined && actualByDay === undefined
    ? validated
    : {
        ...validated,
        ...(task.actualMinutes === undefined ? {} : { actualMinutes: task.actualMinutes }),
        ...(actualByDay === undefined ? {} : { actualByDay }),
      };
  const write = setDoc(doc(database, path), taskFields(restored, task.completed, task.completedAt, task.someday));
  // The restore is the pending write now: the delete it undoes no longer counts
  // on its own (see forgetRemoval), so one document is one pending change.
  forgetRemoval(path);
  await write;
}
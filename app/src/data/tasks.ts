import { addDoc, collection, deleteDoc, deleteField, doc, setDoc, updateDoc, writeBatch, type Firestore } from "firebase/firestore";
import { createTask, requireEstimate, requireInstant, type Task } from "../domain/model.ts";
import { planUndo, type ShutdownPlan } from "../planning/shutdown.ts";
import { db } from "./client.ts";
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
 * here, so a restored task is the document that was deleted.
 */
export function taskFields(task: Task, completed: boolean, completedAt?: string): Record<string, unknown> {
  return {
    title: task.title,
    completed,
    ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
    ...(task.estimate === undefined ? {} : { estimate: task.estimate }),
    ...(completedAt === undefined ? {} : { completedAt }),
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

export async function deleteTask(uid: string, taskId: string) {
  await trackRemoval(`users/${uid}/tasks/${taskId}`, deleteDoc(doc(db, `users/${uid}/tasks/${taskId}`)));
}

/**
 * Applies the shutdown roll (F3a) as exactly one `writeBatch`: a deadline
 * update per move, plus `profile.lastShutdown = plan.today`. The batch is
 * atomic, so a rejected write changes nothing at all — the sheet can then say
 * "Nothing changed" and mean it — and it is queued offline like any other
 * write, so closing the day on a train does not lose the roll.
 *
 * The plan is pure and already validated (`planning/shutdown.ts`), and a plan
 * for a day that is already closed writes nothing, which is what makes the
 * ritual idempotent across devices rather than merely repeatable.
 *
 * The database is a parameter with the app's client as its default so the
 * emulator suite can drive this real batch against its own authenticated
 * client; every surface calls it with two arguments.
 */
export async function closeDay(uid: string, plan: ShutdownPlan, database: Firestore = db) {
  if (plan.alreadyClosed) return;
  const batch = writeBatch(database);
  for (const move of plan.moves) {
    batch.update(doc(database, `users/${uid}/tasks/${move.taskId}`), { deadline: move.after });
  }
  batch.set(profileDocument(uid, database), { lastShutdown: plan.today }, { merge: true });
  await batch.commit();
}

/**
 * Undoes a roll exactly, in one batch: every moved deadline returns to the
 * value the plan recorded, and `lastShutdown` returns to the stamp that was
 * there before — deleted when the close being undone was the first one,
 * because "no stamp" is not any particular day. Nothing else in the profile
 * document is touched (the write is a merge).
 */
export async function undoCloseDay(uid: string, plan: ShutdownPlan, database: Firestore = db) {
  if (plan.alreadyClosed) return;
  const undo = planUndo(plan);
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
}

/** A task exactly as it was stored, captured before it is deleted. */
export type DeletedTask = { id: string; title: string; completed: boolean; deadline?: string; estimate?: number; completedAt?: string };

/**
 * Puts a deleted task back under its original document id and with the exact
 * fields it held, which is what undo promises. The document schema for a task
 * is closed (title, completed, optional deadline, estimate, completedAt), so
 * rewriting those fields with setDoc reproduces the original document rather
 * than approximating it. The title and deadline are validated through the
 * domain module first, and estimate is validated only when present.
 */
export async function restoreTask(uid: string, task: DeletedTask) {
  if (!task.id || task.id.includes("/")) throw new Error("task ID is invalid");
  const validated = createTask(task.id, task.title, task.deadline, task.estimate);
  if (task.completedAt !== undefined) requireInstant(task.completedAt);
  const path = `users/${uid}/tasks/${task.id}`;
  const write = setDoc(doc(db, path), taskFields(validated, task.completed, task.completedAt));
  // The restore is the pending write now: the delete it undoes no longer counts
  // on its own (see forgetRemoval), so one document is one pending change.
  forgetRemoval(path);
  await write;
}
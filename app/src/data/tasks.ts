import { addDoc, collection, deleteDoc, deleteField, doc, setDoc, updateDoc } from "firebase/firestore";
import { createTask } from "../domain/model.ts";
import { db } from "./client.ts";
import { trackRemoval } from "./pending.ts";

/**
 * Task write helpers against `users/{uid}/tasks`. Each helper validates through
 * the domain module first and throws before any write on invalid input, so
 * errors propagate to the caller (the surface displays them; nothing is
 * swallowed here).
 */

export async function addTask(uid: string, title: string, deadline?: string) {
  const task = createTask("pending-mint", title, deadline);
  await addDoc(collection(db, `users/${uid}/tasks`), {
    title: task.title,
    completed: false,
    ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
  });
}

export async function renameTask(uid: string, taskId: string, title: string) {
  const task = createTask(taskId, title);
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { title: task.title });
}

export async function setTaskCompleted(uid: string, taskId: string, completed: boolean) {
  await updateDoc(doc(db, `users/${uid}/tasks/${taskId}`), { completed });
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
  await trackRemoval(deleteDoc(doc(db, `users/${uid}/tasks/${taskId}`)));
}

/** A task exactly as it was stored, captured before it is deleted. */
export type DeletedTask = { id: string; title: string; completed: boolean; deadline?: string };

/**
 * Puts a deleted task back under its original document id and with the exact
 * fields it held, which is what undo promises. The document schema for a task
 * is closed (title, completed, optional deadline), so rewriting those fields
 * with setDoc reproduces the original document rather than approximating it.
 * The title and deadline are validated through the domain module first.
 */
export async function restoreTask(uid: string, task: DeletedTask) {
  const validated = createTask(task.id, task.title, task.deadline);
  if (!task.id || task.id.includes("/")) throw new Error("task ID is invalid");
  await setDoc(doc(db, `users/${uid}/tasks/${task.id}`), {
    title: validated.title,
    completed: task.completed,
    ...(validated.deadline === undefined ? {} : { deadline: validated.deadline }),
  });
}

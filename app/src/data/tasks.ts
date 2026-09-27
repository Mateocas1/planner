import { addDoc, collection, deleteDoc, deleteField, doc, updateDoc } from "firebase/firestore";
import { createTask } from "../domain/model.ts";
import { db } from "./client.ts";

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
  await deleteDoc(doc(db, `users/${uid}/tasks/${taskId}`));
}

import { addDoc, collection, deleteDoc, doc } from "firebase/firestore";
import { createWorkBlock } from "../domain/model.ts";
import { db } from "./client.ts";
import { trackRemoval } from "./pending.ts";

/**
 * Work block write helpers against `users/{uid}/blocks`. Input is validated by
 * the domain module before any write, so rejected input never reaches
 * Firestore; errors propagate to the caller for display.
 */
export async function addBlock(uid: string, start: string, end: string, taskId?: string) {
  const block = createWorkBlock("pending-mint", start, end, taskId);
  await addDoc(collection(db, `users/${uid}/blocks`), {
    start: block.start,
    end: block.end,
    ...(block.taskId === undefined ? {} : { taskId: block.taskId }),
  });
}

export async function deleteBlock(uid: string, blockId: string) {
  await trackRemoval(deleteDoc(doc(db, `users/${uid}/blocks/${blockId}`)));
}

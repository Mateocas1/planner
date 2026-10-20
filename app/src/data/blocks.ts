import { addDoc, collection, deleteDoc, doc, setDoc, updateDoc } from "firebase/firestore";
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

/**
 * Moves a block's edges (drag-resize, keyboard resize). The block is validated
 * by the domain module before any write, so a rejected start/end never reaches
 * Firestore; the task link is untouched.
 */
export async function setBlockTimes(uid: string, blockId: string, start: string, end: string) {
  const block = createWorkBlock(blockId, start, end);
  await updateDoc(doc(db, `users/${uid}/blocks/${blockId}`), { start: block.start, end: block.end });
}

export async function deleteBlock(uid: string, blockId: string) {
  await trackRemoval(deleteDoc(doc(db, `users/${uid}/blocks/${blockId}`)));
}

/** A work block exactly as it was stored, captured before it is deleted. */
export type DeletedBlock = { id: string; start: string; end: string; taskId?: string };

/**
 * Puts a deleted work block back under its original document id with the exact
 * instants and task link it held. The block schema is closed (start, end,
 * optional taskId), so setDoc reproduces the original document. The instants
 * are validated through the domain module before any write.
 */
export async function restoreBlock(uid: string, block: DeletedBlock) {
  const validated = createWorkBlock(block.id, block.start, block.end, block.taskId);
  if (!block.id || block.id.includes("/")) throw new Error("block ID is invalid");
  await setDoc(doc(db, `users/${uid}/blocks/${block.id}`), {
    start: validated.start,
    end: validated.end,
    ...(validated.taskId === undefined ? {} : { taskId: validated.taskId }),
  });
}

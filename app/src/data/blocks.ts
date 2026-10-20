import { addDoc, collection, deleteDoc, doc, setDoc, updateDoc } from "firebase/firestore";
import { blockFields, createWorkBlock, type BlockSource } from "../domain/model.ts";
import { db } from "./client.ts";
import { forgetRemoval, trackRemoval } from "./pending.ts";

/**
 * Work block write helpers against `users/{uid}/blocks`. Input is validated by
 * the domain module before any write, so rejected input never reaches
 * Firestore; errors propagate to the caller for display.
 */

// The stored block shape is the domain's (model.blockFields), so the read path
// (model.parseBlock) and every write path cannot drift apart. Re-exported for
// the import writer, which builds documents from domain blocks.
export { blockFields };

export async function addBlock(uid: string, start: string, end: string, taskId?: string) {
  const block = createWorkBlock("pending-mint", start, end, taskId);
  await addDoc(collection(db, `users/${uid}/blocks`), blockFields(block));
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
  await trackRemoval(`users/${uid}/blocks/${blockId}`, deleteDoc(doc(db, `users/${uid}/blocks/${blockId}`)));
}

/** A work block exactly as it was stored, captured before it is deleted. */
export type DeletedBlock = {
  id: string;
  start: string;
  end: string;
  taskId?: string;
  title?: string;
  source?: BlockSource;
};

/**
 * Puts a deleted work block back under its original document id with the exact
 * instants, task link, title and import source it held. The block schema is
 * closed (start, end, optional taskId, title and source), so setDoc reproduces
 * the original document. The instants and the import source are validated
 * through the domain module before any write.
 */
export async function restoreBlock(uid: string, block: DeletedBlock) {
  const validated = createWorkBlock(block.id, block.start, block.end, block.taskId, {
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.source === undefined ? {} : { source: block.source }),
  });
  if (!block.id || block.id.includes("/")) throw new Error("block ID is invalid");
  const path = `users/${uid}/blocks/${block.id}`;
  const write = setDoc(doc(db, path), blockFields(validated));
  // The restore is the pending write now: the delete it undoes no longer counts
  // on its own (see forgetRemoval), so one document is one pending change.
  forgetRemoval(path);
  await write;
}

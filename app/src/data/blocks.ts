import { addDoc, collection, deleteDoc, doc, setDoc, updateDoc, writeBatch, type Firestore } from "firebase/firestore";
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

/** One block of a plan, as the placement module hands it over: the instants to
 * write in the profile zone, and the task the block reserves time for. */
export type PlannedBlock = { start: string; end: string; taskId?: string };

/** A batch in flight: the document ids are minted before the write is sent, so
 * a caller can offer the exact undo without waiting for the server, and `done`
 * is what the surface races against its own accept beat (see write.ts). */
export type BlockBatch = { ids: string[]; done: Promise<void> };

/**
 * Writes every block of a day's plan in one `writeBatch` (F4b). One batch is the
 * atomicity the plan promises: a day is planned or it is not, never half of it,
 * and the pending-write counter sees one write per document because the commit
 * is one.
 *
 * The returned ids are the documents the batch created, in the order they were
 * given, which is what the undo removes. Every block is validated by the domain
 * module before the batch is built, so a rejected instant leaves no document
 * queued: the throw happens before `commit` is even constructed.
 *
 * An empty plan writes nothing and resolves at once.
 */
export function addBlocks(uid: string, blocks: readonly PlannedBlock[], database: Firestore = db): BlockBatch {
  if (blocks.length === 0) return { ids: [], done: Promise.resolve() };
  const writes = blocks.map(planned => {
    const reference = doc(collection(database, `users/${uid}/blocks`));
    const block = createWorkBlock(reference.id, planned.start, planned.end, planned.taskId);
    return { reference, fields: blockFields(block) };
  });
  const batch = writeBatch(database);
  for (const write of writes) batch.set(write.reference, write.fields);
  return { ids: writes.map(write => write.reference.id), done: batch.commit() };
}

/**
 * Deletes the blocks one plan batch created, in one batch, and nothing else
 * (F4b's undo). The documents are named by id, so a block a person has moved
 * since is removed as it is, and an older block on the same day stays.
 *
 * Each delete is counted as pending until the commit settles, because Firestore
 * does not flag a removal in the snapshot (see data/pending.ts).
 */
export function removeBlocks(uid: string, ids: readonly string[], database: Firestore = db): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  const batch = writeBatch(database);
  const paths = ids.map(id => `users/${uid}/blocks/${id}`);
  for (const path of paths) batch.delete(doc(database, path));
  const commit = batch.commit();
  for (const path of paths) void trackRemoval(path, commit).catch(() => undefined);
  return commit;
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

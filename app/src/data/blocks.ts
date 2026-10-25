import { addDoc, collection, deleteDoc, doc, getDocs, query, setDoc, updateDoc, where, writeBatch, type Firestore } from "firebase/firestore";
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
 * The most operations one write batch here may carry. Firestore refuses a
 * batch over 500 operations, and an overflow rejects the batch whole — the
 * task and none of its blocks deleted, with the rejection free to disappear
 * into a caller's `.catch`. The guard refuses one operation earlier (499),
 * and it throws before the batch is built: nothing is written anywhere, and
 * the error reaches the caller's surface as a message instead of an emulator
 * rejection. Batches are never chunked to fit: chunking would break the
 * atomicity the delete (and its undo) promises — half of a task's schedule
 * deleted is exactly the bug this code exists to prevent.
 */
export const MAX_BATCH_OPS = 499;

/** Throws a caller-facing error when `operations` writes would not fit in one
 * batch; `what` names them in the message. */
export function assertBatchFits(operations: number, what: string): void {
  if (operations > MAX_BATCH_OPS) {
    throw new Error(`Too many ${what} for one write batch (at most ${MAX_BATCH_OPS} operations); nothing was written.`);
  }
}

/** Captures a live block view as the closed snapshot undo restores: only the
 * stored block fields travel, so view-only flags (like `pending`) never leak
 * into a restored document. */
export function deletedBlockSnapshot(
  block: { id: string; start: string; end: string; taskId?: string; title?: string; source?: BlockSource },
): DeletedBlock {
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    ...(block.taskId === undefined ? {} : { taskId: block.taskId }),
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.source === undefined ? {} : { source: block.source }),
  };
}

/**
 * Puts a deleted work block back under its original document id with the exact
 * instants, task link, title and import source it held. The block schema is
 * closed (start, end, optional taskId, title and source), so setDoc reproduces
 * the original document. The instants and the import source are validated
 * through the domain module before any write.
 */
export async function restoreBlock(uid: string, block: DeletedBlock, database: Firestore = db) {
  const validated = createWorkBlock(block.id, block.start, block.end, block.taskId, {
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.source === undefined ? {} : { source: block.source }),
  });
  if (!block.id || block.id.includes("/")) throw new Error("block ID is invalid");
  const path = `users/${uid}/blocks/${block.id}`;
  const write = setDoc(doc(database, path), blockFields(validated));
  // The restore is the pending write now: the delete it undoes no longer counts
  // on its own (see forgetRemoval), so one document is one pending change.
  forgetRemoval(path);
  await write;
}

/**
 * Every work block linked to a task, resolved from Firestore at the moment
 * the caller asks (the UI's task delete, and the chat executor's check after
 * its own write). The caller's store snapshot can be stale — a block created
 * on another device after the last render, or after a chat card was
 * proposed — so the delete path asks the database instead of trusting the
 * view. Offline, the query is served from the persistent local cache, which
 * is the same data the store snapshot held. A single-field equality query
 * needs no index beyond the automatic one.
 *
 * The results are closed snapshots under their own ids: exactly what undo
 * restores, and what `deleteTask` accepts (each block's `taskId` is the
 * queried task, so the foreign-block guard never fires).
 */
export async function linkedBlocks(uid: string, taskId: string, database: Firestore = db): Promise<DeletedBlock[]> {
  const snapshot = await getDocs(query(collection(database, `users/${uid}/blocks`), where("taskId", "==", taskId)));
  return snapshot.docs.map(entry => {
    const fields = entry.data() as { start?: string; end?: string; taskId?: string; title?: string; source?: BlockSource };
    return deletedBlockSnapshot({
      id: entry.id,
      start: fields.start ?? "",
      end: fields.end ?? "",
      taskId: fields.taskId,
      title: fields.title,
      source: fields.source,
    });
  });
}

/** One block going back where it was: the document path and the closed
 * stored fields to write. */
export type BlockRestore = { path: string; fields: Record<string, unknown> };

/** Validates one deleted block snapshot into the write its restore needs
 * (the shared body of `restoreBlocks` and the one-batch undo in tasks.ts). */
export function blockRestoreWrite(uid: string, block: DeletedBlock): BlockRestore {
  if (!block.id || block.id.includes("/")) throw new Error("block ID is invalid");
  const validated = createWorkBlock(block.id, block.start, block.end, block.taskId, {
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.source === undefined ? {} : { source: block.source }),
  });
  return { path: `users/${uid}/blocks/${block.id}`, fields: blockFields(validated) };
}

/**
 * Puts several deleted work blocks back under their original document ids in
 * ONE `writeBatch`, with the exact instants, task links, titles and import
 * sources they held (the undo of a task delete that removed those blocks, S8).
 * Every block is validated through the domain module before the batch is
 * built, so a rejected snapshot leaves nothing queued; the batch either lands
 * whole or not at all, which keeps an undo from splitting a task's schedule
 * in two. Each path stops counting its delete as pending (forgetRemoval).
 * An empty list writes nothing and resolves at once.
 */
export function restoreBlocks(uid: string, blocks: readonly DeletedBlock[], database: Firestore = db): Promise<void> {
  if (blocks.length === 0) return Promise.resolve();
  assertBatchFits(blocks.length, "work blocks to restore");
  const writes = blocks.map(block => blockRestoreWrite(uid, block));
  const batch = writeBatch(database);
  for (const write of writes) batch.set(doc(database, write.path), write.fields);
  const commit = batch.commit();
  for (const write of writes) forgetRemoval(write.path);
  return commit;
}

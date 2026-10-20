import { doc, writeBatch } from "firebase/firestore";
import { importedIds, type ImportedBlockRef, type ImportPlan } from "../domain/gcalImport.ts";
import { blockFields } from "./blocks.ts";
import { db } from "./client.ts";
import { trackRemoval } from "./pending.ts";
import { taskFields } from "./tasks.ts";

/**
 * The write half of "Import from Google Calendar". It applies a plan the mapper
 * produced, so nothing here decides what an event becomes; it only decides how
 * the documents reach Firestore.
 *
 * Every import document has a deterministic id (see domain/gcalImport.ts) and
 * is written with `set`, so importing the same window twice rewrites the same
 * documents with the same content instead of duplicating them. Writes go in
 * batches of at most `MAX_BATCH_WRITES`, the per-batch limit for a Firestore
 * batched write.
 */

/** Firestore's limit on operations in one batched write. */
export const MAX_BATCH_WRITES = 500;

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

export type ImportWriteCounts = { blocks: number; tasks: number };

/**
 * Writes every block and task in the plan under its deterministic id. An empty
 * plan writes nothing at all (Firestore rejects an empty batch). A failure in
 * one batch rejects the call and leaves the batches before it applied, which
 * re-importing the same window repairs -- the ids make the retry idempotent.
 */
export async function writeImportPlan(uid: string, plan: ImportPlan): Promise<ImportWriteCounts> {
  const writes: { path: string; data: Record<string, unknown> }[] = [
    ...plan.blocks.map(block => ({ path: `users/${uid}/blocks/${block.id}`, data: blockFields(block) })),
    ...plan.tasks.map(task => ({ path: `users/${uid}/tasks/${task.id}`, data: taskFields(task, false) })),
  ];
  for (const chunk of chunks(writes, MAX_BATCH_WRITES)) {
    const batch = writeBatch(db);
    for (const write of chunk) batch.set(doc(db, write.path), write.data);
    await batch.commit();
  }
  return { blocks: plan.blocks.length, tasks: plan.tasks.length };
}

/**
 * The safety net for an import: deletes every block that records a Google
 * source and every task whose id carries the import prefix, in batches. The
 * selection itself is pure (see importedIds); this only applies it, and counts
 * each delete as a pending change until the server acknowledges it, because a
 * removal is never flagged the way a write is (see pending.ts).
 */
export async function removeImported(
  uid: string,
  blocks: Iterable<ImportedBlockRef>,
  tasks: Iterable<{ id: string }>,
): Promise<ImportWriteCounts> {
  const { blockIds, taskIds } = importedIds(blocks, tasks);
  const paths = [
    ...blockIds.map(id => `users/${uid}/blocks/${id}`),
    ...taskIds.map(id => `users/${uid}/tasks/${id}`),
  ];
  for (const chunk of chunks(paths, MAX_BATCH_WRITES)) {
    const batch = writeBatch(db);
    for (const path of chunk) batch.delete(doc(db, path));
    const commit = batch.commit();
    // The batch is one write from Firestore's point of view but many documents
    // from the store's; each path takes a ticket on the same promise and drops
    // it when that commit settles.
    for (const path of chunk) void trackRemoval(path, commit).catch(() => undefined);
    await commit;
  }
  return { blocks: blockIds.length, tasks: taskIds.length };
}

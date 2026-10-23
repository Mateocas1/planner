import { collection, deleteField, doc, writeBatch, type Firestore } from "firebase/firestore";
import { blockFields, createTask, createWorkBlock } from "../domain/model.ts";

/**
 * The chat's move_task write (Ronda 3 fix, spec S1): one confirmed move is
 * exactly one Firestore `writeBatch`, so the deadline and the work block that
 * places the task at a start time land together or not at all — a failed
 * write can never leave half a move behind (the deadline moved, the block
 * missing). This is the only place the chat writes a move; the field builders
 * are the app's own (`createTask` validation, `blockFields`), so the batch
 * stores what every other surface stores.
 */

/** One confirmed chat move: where the task's deadline goes, plus the optional
 * task-linked work block that places it at a time on that day. */
export type ChatMove = {
  taskId: string;
  /** The task's current title, passed to validation exactly like
   * `setTaskDeadline` does. */
  title: string;
  /** New deadline day (`YYYY-MM-DD`), or undefined to clear the deadline. */
  deadline?: string;
  /** Optional work block placing the task on the day's schedule. */
  block?: { start: string; end: string };
};

/** One write inside a move batch: a field update on an existing document, or
 * a whole-document set (the new block). Exposed for the payload test — the
 * executor applies exactly what this lists. */
export type ChatMoveWrite =
  | { kind: "update"; path: string; fields: Record<string, unknown> }
  | { kind: "set"; path: string; fields: Record<string, unknown> };

/**
 * The writes one move consists of, as pure data. Validation runs here and
 * throws before any write exists (the domain module's rules, the same ones
 * `setTaskDeadline`/`addBlock` apply), so a rejected move produces no batch
 * at all. The block document's id is minted by the caller and ends up in the
 * block's path, so undo-style removal stays possible.
 */
export function chatMoveWrites(uid: string, move: ChatMove, blockId: string): ChatMoveWrite[] {
  if (typeof move.taskId !== "string" || move.taskId === "" || move.taskId.includes("/")) {
    throw new Error("task ID is invalid");
  }
  const writes: ChatMoveWrite[] = [];
  // The deadline validates through `createTask` — the same call
  // `setTaskDeadline` makes — so a bad date or title throws here.
  createTask(move.taskId, move.title, move.deadline);
  writes.push({
    kind: "update",
    path: `users/${uid}/tasks/${move.taskId}`,
    fields: move.deadline === undefined ? { deadline: deleteField() } : { deadline: move.deadline },
  });
  if (move.block !== undefined) {
    const block = createWorkBlock(blockId, move.block.start, move.block.end, move.taskId);
    writes.push({ kind: "set", path: `users/${uid}/blocks/${blockId}`, fields: blockFields(block) });
  }
  return writes;
}

/**
 * Writes one confirmed chat move in one atomic `writeBatch`. The database is
 * a parameter (not this module's import) so the payload test runs in plain
 * node: this module must stay importable without the browser-only client.
 * Throws (writing nothing) when the move does not validate; the caller
 * surfaces the error on the card.
 */
export async function moveTaskWithBlock(uid: string, move: ChatMove, database: Firestore): Promise<void> {
  const blockId = move.block === undefined ? "" : doc(collection(database, `users/${uid}/blocks`)).id;
  const writes = chatMoveWrites(uid, move, blockId);
  const batch = writeBatch(database);
  for (const write of writes) {
    const reference = doc(database, write.path);
    if (write.kind === "update") batch.update(reference, write.fields);
    else batch.set(reference, write.fields);
  }
  await batch.commit();
}

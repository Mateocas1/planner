import { useSyncExternalStore } from "react";

/**
 * Deletes this session has not yet had acknowledged. A deleted document leaves
 * the query snapshot at once, and Firestore does not flag its removal as a
 * pending write, so the store cannot count a delete from the snapshot. The
 * delete's own promise is the signal: it settles only when the server
 * acknowledges the write (or rejects it). A delete queued by an earlier session
 * is not counted; that gap is recorded in the feature's report.
 *
 * Removals are keyed by document path and identified by a ticket, because one
 * document can have more than one write in flight at a time: an undo rewrites
 * the document it just deleted (see forgetRemoval), and the delete it
 * compensates for may still be unacknowledged. Counting per path lets the
 * restore take over the pending slot instead of adding a second one, and a
 * ticket keeps the older write's acknowledgement from cancelling a newer one.
 */
let outstanding = 0;
const removals = new Map<string, Set<number>>();
let tickets = 0;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function drop(documentPath: string, ticket: number): boolean {
  const tracked = removals.get(documentPath);
  if (!tracked || !tracked.delete(ticket)) return false;
  if (tracked.size === 0) removals.delete(documentPath);
  outstanding -= 1;
  return true;
}

/** Counts a delete as pending until its write settles; the result is passed through. */
export function trackRemoval<T>(documentPath: string, write: Promise<T>): Promise<T> {
  const ticket = (tickets += 1);
  const tracked = removals.get(documentPath);
  if (tracked) tracked.add(ticket);
  else removals.set(documentPath, new Set([ticket]));
  outstanding += 1;
  publish();
  return write.finally(() => {
    if (drop(documentPath, ticket)) publish();
  });
}

/**
 * Stops counting a delete that a later write to the same document supersedes:
 * undo restores the document it just deleted. Without this, a delete and its
 * undo would report two pending changes for one document that is back where it
 * started. The oldest tracked delete for the path is the one being undone; if
 * there is none (the delete was already acknowledged), this does nothing.
 */
export function forgetRemoval(documentPath: string): void {
  const tracked = removals.get(documentPath);
  if (!tracked || tracked.size === 0) return;
  if (drop(documentPath, Math.min(...tracked))) publish();
}

/** The number of deletes awaiting server acknowledgement right now. */
export function pendingRemovalCount(): number {
  return outstanding;
}

/** The number of deletes awaiting server acknowledgement; follows changes. */
export function usePendingRemovals(): number {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pendingRemovalCount,
  );
}

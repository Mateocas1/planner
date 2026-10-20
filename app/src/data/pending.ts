import { useSyncExternalStore } from "react";

/**
 * Deletes this session has not yet had acknowledged. A deleted document leaves
 * the query snapshot at once, and Firestore does not flag its removal as a
 * pending write, so the store cannot count a delete from the snapshot. The
 * delete's own promise is the signal: it settles only when the server
 * acknowledges the write (or rejects it). A delete queued by an earlier session
 * is not counted; that gap is recorded in the feature's report.
 */
let outstanding = 0;
const listeners = new Set<() => void>();

function change(delta: number) {
  outstanding += delta;
  for (const listener of listeners) listener();
}

/** Counts a delete as pending until its write settles; the result is passed through. */
export function trackRemoval<T>(write: Promise<T>): Promise<T> {
  change(1);
  return write.finally(() => change(-1));
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

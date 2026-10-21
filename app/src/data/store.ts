import { useEffect, useState } from "react";
import { collection, onSnapshot, type QueryDocumentSnapshot, type QuerySnapshot } from "firebase/firestore";
import { parseActualMinutes, parseBlock as parseStoredBlock, parseEstimate, type Recurrence, type Task, type WorkBlock } from "../domain/model.ts";
import { db } from "./client.ts";
import { usePendingRemovals } from "./pending.ts";

/** View type for a stored task: the domain Task plus its completion state. */
export type TaskView = Task & { completed: boolean; completedAt?: string; pending: boolean };

/**
 * View type for a stored work block: the domain WorkBlock plus whether the
 * write that produced it is still unacknowledged by the server. The local
 * cache reports a queued write through snapshot metadata, so the flag clears
 * on its own once the write is acknowledged.
 */
export type BlockView = WorkBlock & { pending: boolean };

/** View type for a stored recurring series (a definition, not occurrences). */
export type SeriesView = {
  id: string;
  title: string;
  frequency: Recurrence["frequency"];
  anchorDate: string;
  deadline?: string;
  estimate?: number;
};

type Collection = "tasks" | "blocks" | "series" | "completions";

export type Store = {
  loading: boolean;
  tasks: TaskView[];
  blocks: BlockView[];
  series: SeriesView[];
  /** Completion records keyed by occurrenceId, valued by completedAt. */
  completions: Record<string, string>;
  /**
   * Writes the server has not acknowledged: documents still flagged by their
   * metadata, plus deletes (see trackRemoval), across every collection.
   */
  pendingWrites: number;
};

function toTask(doc: QueryDocumentSnapshot): TaskView {
  const data = doc.data();
  const estimate = parseEstimate(data.estimate);
  const actualMinutes = parseActualMinutes(data.actualMinutes);
  return {
    id: doc.id,
    title: String(data.title),
    completed: data.completed === true,
    pending: doc.metadata.hasPendingWrites,
    ...(data.deadline === undefined ? {} : { deadline: String(data.deadline) }),
    ...(estimate === undefined ? {} : { estimate }),
    ...(actualMinutes === undefined ? {} : { actualMinutes }),
    ...(data.completedAt === undefined ? {} : { completedAt: String(data.completedAt) }),
  };
}

/** A stored block document read as the domain block plus its pending flag. */
function toBlock(doc: QueryDocumentSnapshot): BlockView {
  return { ...parseStoredBlock(doc.id, doc.data()), pending: doc.metadata.hasPendingWrites };
}

function toSeries(doc: QueryDocumentSnapshot): SeriesView {
  const data = doc.data();
  const estimate = parseEstimate(data.estimate);
  return {
    id: doc.id,
    title: String(data.title),
    frequency: String(data.frequency) as SeriesView["frequency"],
    anchorDate: String(data.anchorDate),
    ...(data.deadline === undefined ? {} : { deadline: String(data.deadline) }),
    ...(estimate === undefined ? {} : { estimate }),
  };
}

function toCompletions(docs: QueryDocumentSnapshot[]): Record<string, string> {
  const completions: Record<string, string> = {};
  for (const doc of docs) completions[doc.id] = String(doc.data().completedAt);
  return completions;
}

export function useStore(uid: string | null): Store {
  const [store, setStore] = useState<Store>({ loading: true, tasks: [], blocks: [], series: [], completions: {}, pendingWrites: 0 });

  useEffect(() => {
    if (!uid) {
      setStore({ loading: false, tasks: [], blocks: [], series: [], completions: {}, pendingWrites: 0 });
      return;
    }
    setStore({ loading: true, tasks: [], blocks: [], series: [], completions: {}, pendingWrites: 0 });

    // Documents still flagged as pending, per collection. Deletes are counted
    // separately, from their own writes, because a removal is never flagged.
    const flagged: Record<Collection, number> = { tasks: 0, blocks: 0, series: 0, completions: 0 };
    const track = (name: Collection, snapshot: QuerySnapshot) => {
      flagged[name] = snapshot.docs.filter(doc => doc.metadata.hasPendingWrites).length;
      return Object.values(flagged).reduce((sum, count) => sum + count, 0);
    };

    const outstanding = new Set<Collection>(["tasks", "blocks", "series", "completions"]);
    const delivered = (collection: Collection) => {
      outstanding.delete(collection);
      if (outstanding.size === 0) setStore(previous => ({ ...previous, loading: false }));
    };
    const onError = (error: Error) => {
      console.error("store snapshot failed", error);
    };

    const unsubscribeTasks = onSnapshot(
      collection(db, `users/${uid}/tasks`),
      { includeMetadataChanges: true },
      snapshot => {
        const pendingWrites = track("tasks", snapshot);
        setStore(previous => ({ ...previous, tasks: snapshot.docs.map(toTask), pendingWrites }));
        delivered("tasks");
      },
      onError,
    );
    const unsubscribeBlocks = onSnapshot(
      collection(db, `users/${uid}/blocks`),
      { includeMetadataChanges: true },
      snapshot => {
        const pendingWrites = track("blocks", snapshot);
        setStore(previous => ({ ...previous, blocks: snapshot.docs.map(toBlock), pendingWrites }));
        delivered("blocks");
      },
      onError,
    );
    const unsubscribeSeries = onSnapshot(
      collection(db, `users/${uid}/series`),
      { includeMetadataChanges: true },
      snapshot => {
        const pendingWrites = track("series", snapshot);
        setStore(previous => ({ ...previous, series: snapshot.docs.map(toSeries), pendingWrites }));
        delivered("series");
      },
      onError,
    );
    const unsubscribeCompletions = onSnapshot(
      collection(db, `users/${uid}/completions`),
      { includeMetadataChanges: true },
      snapshot => {
        const pendingWrites = track("completions", snapshot);
        setStore(previous => ({ ...previous, completions: toCompletions(snapshot.docs), pendingWrites }));
        delivered("completions");
      },
      onError,
    );
    return () => {
      unsubscribeTasks();
      unsubscribeBlocks();
      unsubscribeSeries();
      unsubscribeCompletions();
    };
  }, [uid]);

  const removals = usePendingRemovals();
  return removals === 0 ? store : { ...store, pendingWrites: store.pendingWrites + removals };
}

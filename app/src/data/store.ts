import { useEffect, useState } from "react";
import { collection, onSnapshot, type QueryDocumentSnapshot } from "firebase/firestore";
import type { Recurrence, Task, WorkBlock } from "../domain/model.ts";
import { db } from "./client.ts";

/** View type for a stored task: the domain Task plus its completion state. */
export type TaskView = Task & { completed: boolean; pending: boolean };

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
};

export type Store = {
  loading: boolean;
  tasks: TaskView[];
  blocks: BlockView[];
  series: SeriesView[];
  /** Completion records keyed by occurrenceId, valued by completedAt. */
  completions: Record<string, string>;
};

function toTask(doc: QueryDocumentSnapshot): TaskView {
  const data = doc.data();
  return {
    id: doc.id,
    title: String(data.title),
    completed: data.completed === true,
    pending: doc.metadata.hasPendingWrites,
    ...(data.deadline === undefined ? {} : { deadline: String(data.deadline) }),
  };
}

function toBlock(doc: QueryDocumentSnapshot): BlockView {
  const data = doc.data();
  return {
    id: doc.id,
    start: String(data.start),
    end: String(data.end),
    ...(data.taskId === undefined ? {} : { taskId: String(data.taskId) }),
    pending: doc.metadata.hasPendingWrites,
  };
}

function toSeries(doc: QueryDocumentSnapshot): SeriesView {
  const data = doc.data();
  return {
    id: doc.id,
    title: String(data.title),
    frequency: String(data.frequency) as SeriesView["frequency"],
    anchorDate: String(data.anchorDate),
    ...(data.deadline === undefined ? {} : { deadline: String(data.deadline) }),
  };
}

function toCompletions(docs: QueryDocumentSnapshot[]): Record<string, string> {
  const completions: Record<string, string> = {};
  for (const doc of docs) completions[doc.id] = String(doc.data().completedAt);
  return completions;
}

export function useStore(uid: string | null): Store {
  const [store, setStore] = useState<Store>({ loading: true, tasks: [], blocks: [], series: [], completions: {} });

  useEffect(() => {
    if (!uid) {
      setStore({ loading: false, tasks: [], blocks: [], series: [], completions: {} });
      return;
    }
    setStore({ loading: true, tasks: [], blocks: [], series: [], completions: {} });

    const outstanding = new Set(["tasks", "blocks", "series", "completions"]);
    const delivered = (collection: "tasks" | "blocks" | "series" | "completions") => {
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
        setStore(previous => ({ ...previous, tasks: snapshot.docs.map(toTask) }));
        delivered("tasks");
      },
      onError,
    );
    const unsubscribeBlocks = onSnapshot(
      collection(db, `users/${uid}/blocks`),
      { includeMetadataChanges: true },
      snapshot => {
        setStore(previous => ({ ...previous, blocks: snapshot.docs.map(toBlock) }));
        delivered("blocks");
      },
      onError,
    );
    const unsubscribeSeries = onSnapshot(
      collection(db, `users/${uid}/series`),
      { includeMetadataChanges: true },
      snapshot => {
        setStore(previous => ({ ...previous, series: snapshot.docs.map(toSeries) }));
        delivered("series");
      },
      onError,
    );
    const unsubscribeCompletions = onSnapshot(
      collection(db, `users/${uid}/completions`),
      { includeMetadataChanges: true },
      snapshot => {
        setStore(previous => ({ ...previous, completions: toCompletions(snapshot.docs) }));
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

  return store;
}

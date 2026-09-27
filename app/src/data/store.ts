import { useEffect, useState } from "react";
import { collection, onSnapshot, type QueryDocumentSnapshot } from "firebase/firestore";
import type { Task, WorkBlock } from "../domain/model.ts";
import { db } from "./client.ts";

export type Store = { loading: boolean; tasks: Task[]; blocks: WorkBlock[] };

function toTask(doc: QueryDocumentSnapshot): Task {
  const data = doc.data();
  return {
    id: doc.id,
    title: String(data.title),
    ...(data.deadline === undefined ? {} : { deadline: String(data.deadline) }),
  };
}

function toBlock(doc: QueryDocumentSnapshot): WorkBlock {
  const data = doc.data();
  return {
    id: doc.id,
    start: String(data.start),
    end: String(data.end),
    ...(data.taskId === undefined ? {} : { taskId: String(data.taskId) }),
  };
}

export function useStore(uid: string | null): Store {
  const [store, setStore] = useState<Store>({ loading: true, tasks: [], blocks: [] });

  useEffect(() => {
    if (!uid) {
      setStore({ loading: false, tasks: [], blocks: [] });
      return;
    }
    setStore({ loading: true, tasks: [], blocks: [] });

    const outstanding = new Set(["tasks", "blocks"]);
    const delivered = (collection: "tasks" | "blocks") => {
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
    return () => {
      unsubscribeTasks();
      unsubscribeBlocks();
    };
  }, [uid]);

  return store;
}

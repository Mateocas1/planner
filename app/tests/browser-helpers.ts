import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { addDoc, collection, connectFirestoreEmulator, getDocsFromServer, getFirestore, terminate, type Firestore } from "firebase/firestore";

export const password = "redacted-pass";

async function withRemoteUser<T>(email: string, work: (db: Firestore, uid: string) => Promise<T>): Promise<T> {
  const app: FirebaseApp = initializeApp(
    { projectId: "demo-calendar-app", apiKey: "local-only" },
    `remote-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8187);
  try {
    const account = await signInWithEmailAndPassword(auth, email, password);
    return await work(db, account.user.uid);
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
}

export async function seedTaskAndBlock(email: string, title: string, start: string, end: string) {
  return withRemoteUser(email, async (db, uid) => {
    const task = await addDoc(collection(db, `users/${uid}/tasks`), { title });
    const block = await addDoc(collection(db, `users/${uid}/blocks`), { start, end });
    return { taskId: task.id, blockId: block.id };
  });
}

export async function readRemoteState(email: string) {
  return withRemoteUser(email, async (db, uid) => {
    const tasks = await getDocsFromServer(collection(db, `users/${uid}/tasks`));
    const blocks = await getDocsFromServer(collection(db, `users/${uid}/blocks`));
    return {
      taskTitles: tasks.docs.map(doc => doc.data().title as string).sort(),
      blockStarts: blocks.docs.map(doc => doc.data().start as string).sort(),
    };
  });
}

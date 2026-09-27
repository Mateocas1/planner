import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { addDoc, collection, connectFirestoreEmulator, doc, getDocFromServer, getDocsFromServer, getFirestore, setDoc, terminate, type Firestore } from "firebase/firestore";

export const password = "redacted-pass";

/** The single profile document for a user (see app/src/data/profile.ts). */
function profileDoc(db: Firestore, uid: string) {
  return doc(db, `users/${uid}/profile/main`);
}

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

export async function readRemoteBlocks(email: string): Promise<Array<{ start: string; end: string; taskId?: string }>> {
  return withRemoteUser(email, async (db, uid) => {
    const blocks = await getDocsFromServer(collection(db, `users/${uid}/blocks`));
    return blocks.docs.map(doc => doc.data() as { start: string; end: string; taskId?: string });
  });
}

export async function readRemoteTasks(email: string) {
  return withRemoteUser(email, async (db, uid) => {
    const tasks = await getDocsFromServer(collection(db, `users/${uid}/tasks`));
    return tasks.docs.map(doc => doc.data());
  });
}

/**
 * Creates the Auth account directly on the emulator (REST signUp) without
 * signing any browser session in, so tests can pre-seed server state before
 * the app under test ever runs for that user.
 */
export async function createRemoteAccount(email: string): Promise<void> {
  const response = await fetch(
    "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-only",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`emulator signUp failed: ${response.status} ${await response.text()}`);
}

/** Seeds the profile timezone and one work block before the user is ever signed in. */
export async function seedProfileAndBlock(email: string, timeZone: string, start: string, end: string): Promise<void> {
  await createRemoteAccount(email);
  await withRemoteUser(email, async (db, uid) => {
    await setDoc(profileDoc(db, uid), { timeZone });
    await addDoc(collection(db, `users/${uid}/blocks`), { start, end });
  });
}

export async function updateRemoteProfile(email: string, timeZone: string): Promise<void> {
  return withRemoteUser(email, async (db, uid) => {
    await setDoc(profileDoc(db, uid), { timeZone });
  });
}

export async function readRemoteProfile(email: string): Promise<{ timeZone?: string }> {
  return withRemoteUser(email, async (db, uid) => {
    const snapshot = await getDocFromServer(profileDoc(db, uid));
    return (snapshot.data() as { timeZone?: string } | undefined) ?? {};
  });
}

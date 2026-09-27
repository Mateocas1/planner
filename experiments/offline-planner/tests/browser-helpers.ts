import { expect, type Page } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  terminate,
} from "firebase/firestore";

export const password = "lab-password";
export const blockText = "2026-02-03T09:00:00-03:00 to 2026-02-03T10:00:00-03:00";

export type ExpectedTask = {
  title: string;
  completed: boolean;
};

export const item = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });

export async function verifyRemoteState(email: string, expectedTasks: ExpectedTask[]) {
  const app = initializeApp(
    { projectId: "demo-calendar-offline", apiKey: "local-only" },
    `remote-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const auth = getAuth(app);
  const db = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8087);

  try {
    const account = await signInWithEmailAndPassword(auth, email, password);
    const tasks = await getDocsFromServer(collection(db, `users/${account.user.uid}/tasks`));
    expect(tasks.size).toBe(expectedTasks.length);
    for (const expected of expectedTasks) {
      const task = tasks.docs.find(entry => entry.data().title === expected.title);
      expect(task).toBeDefined();
      const remoteTask = await getDocFromServer(doc(db, `users/${account.user.uid}/tasks/${task!.id}`));
      expect(remoteTask.data()).toMatchObject(expected);
    }
    const blocks = await getDocsFromServer(collection(db, `users/${account.user.uid}/blocks`));
    expect(blocks.size).toBe(1);
    const remoteBlock = await getDocFromServer(doc(db, `users/${account.user.uid}/blocks/${blocks.docs[0].id}`));
    expect(remoteBlock.data()).toMatchObject({
      start: "2026-02-03T09:00:00-03:00",
      end: "2026-02-03T10:00:00-03:00",
    });
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
}

async function withRemoteUser<T>(email: string, work: (db: ReturnType<typeof getFirestore>, uid: string) => Promise<T>) {
  const app = initializeApp(
    { projectId: "demo-calendar-offline", apiKey: "local-only" },
    `remote-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const auth = getAuth(app);
  const db = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8087);

  try {
    const account = await signInWithEmailAndPassword(auth, email, password);
    return await work(db, account.user.uid);
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
}

export async function findRemoteTaskId(email: string, title: string) {
  return withRemoteUser(email, async (db, uid) => {
    const tasks = await getDocsFromServer(collection(db, `users/${uid}/tasks`));
    const matches = tasks.docs.filter(task => task.data().title === title);
    expect(matches).toHaveLength(1);
    const task = await getDocFromServer(doc(db, `users/${uid}/tasks/${matches[0].id}`));
    expect(task.data()).toMatchObject({ title, completed: false });
    return task.id;
  });
}

export async function remoteTask(email: string, taskId: string) {
  return withRemoteUser(email, (db, uid) => getDocFromServer(doc(db, `users/${uid}/tasks/${taskId}`)));
}

export async function findRemoteBlockId(email: string) {
  return withRemoteUser(email, async (db, uid) => {
    const blocks = await getDocsFromServer(collection(db, `users/${uid}/blocks`));
    expect(blocks.size).toBe(1);
    expect(blocks.docs[0].data()).toMatchObject({
      start: "2026-02-03T09:00:00-03:00",
      end: "2026-02-03T10:00:00-03:00",
    });
    return blocks.docs[0].id;
  });
}

export async function verifyRemoteBlockDeletion(email: string, deletedBlockId: string, expectedTasks: ExpectedTask[]) {
  await withRemoteUser(email, async (db, uid) => {
    expect((await getDocFromServer(doc(db, `users/${uid}/blocks/${deletedBlockId}`))).exists()).toBe(false);
    const blocks = await getDocsFromServer(collection(db, `users/${uid}/blocks`));
    expect(blocks.size).toBe(0);
    const tasks = await getDocsFromServer(collection(db, `users/${uid}/tasks`));
    expect(tasks.size).toBe(expectedTasks.length);
    for (const expected of expectedTasks) {
      const task = tasks.docs.find(entry => entry.data().title === expected.title);
      expect(task?.data()).toMatchObject(expected);
    }
  });
}

export async function deleteRemoteTask(email: string, taskId: string) {
  await withRemoteUser(email, async (db, uid) => {
    const target = doc(db, `users/${uid}/tasks/${taskId}`);
    await deleteDoc(target);
    expect((await getDocFromServer(target)).exists()).toBe(false);
  });
}

export async function verifyRemoteDeletion(email: string, deletedTaskId: string, expectedControl: ExpectedTask[]) {
  await withRemoteUser(email, async (db, uid) => {
    expect((await getDocFromServer(doc(db, `users/${uid}/tasks/${deletedTaskId}`))).exists()).toBe(false);
    const tasks = await getDocsFromServer(collection(db, `users/${uid}/tasks`));
    expect(tasks.size).toBe(expectedControl.length);
    for (const expected of expectedControl) {
      const task = tasks.docs.find(entry => entry.data().title === expected.title);
      expect(task?.data()).toMatchObject(expected);
    }
    const blocks = await getDocsFromServer(collection(db, `users/${uid}/blocks`));
    expect(blocks.size).toBe(1);
    expect(blocks.docs[0].data()).toMatchObject({
      start: "2026-02-03T09:00:00-03:00",
      end: "2026-02-03T10:00:00-03:00",
    });
  });
}

export async function createAccount(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create fake account" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

export async function signInAccount(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

export async function createConfirmedTask(page: Page, title: string) {
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(page, title)).toContainText("server-confirmed", { timeout: 30_000 });
}

export async function createConfirmedBlock(page: Page) {
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(item(page, blockText)).toContainText("server-confirmed", { timeout: 30_000 });
}

import { expect, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  terminate,
} from "firebase/firestore";

test.setTimeout(60_000);

const password = "lab-password";

async function verifyRemoteState(email: string, renamed: string, second: string) {
  const app = initializeApp(
    { projectId: "demo-calendar-offline", apiKey: "local-only" },
    `remote-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const auth = getAuth(app);
  const db = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);

  try {
    const account = await signInWithEmailAndPassword(auth, email, password);
    const tasks = await getDocsFromServer(collection(db, `users/${account.user.uid}/tasks`));
    expect(tasks.size).toBe(2);
    const renamedTask = tasks.docs.find(item => item.data().title === renamed);
    const secondTask = tasks.docs.find(item => item.data().title === second);
    expect(renamedTask).toBeDefined();
    expect(secondTask).toBeDefined();

    const remoteRenamedTask = await getDocFromServer(doc(db, `users/${account.user.uid}/tasks/${renamedTask!.id}`));
    const remoteSecondTask = await getDocFromServer(doc(db, `users/${account.user.uid}/tasks/${secondTask!.id}`));
    expect(remoteRenamedTask.data()).toMatchObject({ title: renamed, completed: true });
    expect(remoteSecondTask.data()).toMatchObject({ title: second, completed: false });

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

test("creates a task and block, retains offline edits, then syncs", async ({ page, context }, testInfo) => {
  const marker = `browser-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const task = `${marker} task`;
  const renamed = `${marker} renamed`;
  const offlineRenamed = `${renamed} offline`;
  const second = `${marker} offline task`;
  const item = (text: string) => page.getByRole("listitem").filter({ hasText: text });

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create fake account" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();

  await page.getByLabel("Task title").fill(task);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(task)).toContainText("server-confirmed", { timeout: 30_000 });

  await page.getByRole("button", { name: `Edit ${task}` }).click();
  await page.getByLabel("Rename task").fill(renamed);
  await page.getByRole("button", { name: "Save rename" }).click();
  await expect(item(renamed)).toContainText("server-confirmed", { timeout: 30_000 });

  await page.getByRole("button", { name: "Add block" }).click();
  const block = item("2026-02-03T09:00:00-03:00 to 2026-02-03T10:00:00-03:00");
  await expect(block).toContainText("server-confirmed", { timeout: 30_000 });

  await context.setOffline(true);
  await page.getByRole("button", { name: `Edit ${renamed}` }).click();
  await page.getByLabel("Rename task").fill(offlineRenamed);
  await page.getByRole("button", { name: "Save rename" }).click();
  await page.getByRole("button", { name: `Complete ${offlineRenamed}` }).click();
  await page.getByLabel("Task title").fill(second);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(offlineRenamed)).toContainText("pending write");
  await expect(item(second)).toContainText("pending write");

  await context.setOffline(false);
  await expect(item(offlineRenamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(offlineRenamed)).toContainText("completed");
  await expect(item(second)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(second)).toContainText("open");
  await expect(block).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(page.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);

  await verifyRemoteState(email, offlineRenamed, second);

  await page.reload();
  await expect(item(offlineRenamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(second)).toContainText("server-confirmed", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});

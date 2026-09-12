import { expect, test, type Page } from "@playwright/test";
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
const blockText = "2026-02-03T09:00:00-03:00 to 2026-02-03T10:00:00-03:00";

type ExpectedTask = {
  title: string;
  completed: boolean;
};

const item = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });

async function verifyRemoteState(email: string, expectedTasks: ExpectedTask[]) {
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

async function createAccount(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create fake account" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

async function createConfirmedTask(page: Page, title: string) {
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(page, title)).toContainText("server-confirmed", { timeout: 30_000 });
}

async function createConfirmedBlock(page: Page) {
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(item(page, blockText)).toContainText("server-confirmed", { timeout: 30_000 });
}

test("creates a task and block, retains offline edits, then syncs", async ({ page, context }, testInfo) => {
  const marker = `browser-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const task = `${marker} task`;
  const renamed = `${marker} renamed`;
  const offlineRenamed = `${renamed} offline`;
  const second = `${marker} offline task`;

  await page.goto("/");
  await createAccount(page, email);
  await createConfirmedTask(page, task);

  await page.getByRole("button", { name: `Edit ${task}` }).click();
  await page.getByLabel("Rename task").fill(renamed);
  await page.getByRole("button", { name: "Save rename" }).click();
  await expect(item(page, renamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await createConfirmedBlock(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: `Edit ${renamed}` }).click();
  await page.getByLabel("Rename task").fill(offlineRenamed);
  await page.getByRole("button", { name: "Save rename" }).click();
  await page.getByRole("button", { name: `Complete ${offlineRenamed}` }).click();
  await page.getByLabel("Task title").fill(second);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(page, offlineRenamed)).toContainText("pending write");
  await expect(item(page, second)).toContainText("pending write");

  await context.setOffline(false);
  await expect(item(page, offlineRenamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(page, offlineRenamed)).toContainText("completed");
  await expect(item(page, second)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(page, second)).toContainText("open");
  await expect(page.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
  await verifyRemoteState(email, [
    { title: offlineRenamed, completed: true },
    { title: second, completed: false },
  ]);

  await page.reload();
  await expect(item(page, offlineRenamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(page, second)).toContainText("server-confirmed", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});

test("reopens the built app shell offline and later syncs cached edits", async ({ page, context }) => {
  const marker = `shell-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const initial = `${marker} initial`;
  const renamed = `${initial} offline`;
  const beforeReopen = `${marker} before reopen`;
  const afterReopen = `${marker} after reopen`;

  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await createAccount(page, email);
  await createConfirmedTask(page, initial);
  await createConfirmedBlock(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: `Edit ${initial}` }).click();
  await page.getByLabel("Rename task").fill(renamed);
  await page.getByRole("button", { name: "Save rename" }).click();
  await page.getByRole("button", { name: `Complete ${renamed}` }).click();
  await page.getByLabel("Task title").fill(beforeReopen);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(item(page, renamed)).toContainText("pending write");
  await expect(item(page, renamed)).toContainText("completed");
  await expect(item(page, beforeReopen)).toContainText("pending write");

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByRole("heading", { name: "Planner lab" })).toBeVisible();
  await expect(reopened.getByText(`Signed in as ${email}.`)).toBeVisible();
  await expect(item(reopened, renamed)).toContainText("pending write");
  await expect(item(reopened, renamed)).toContainText("completed");
  await expect(item(reopened, beforeReopen)).toContainText("pending write");
  await expect(item(reopened, blockText)).toBeVisible();

  await reopened.getByLabel("Task title").fill(afterReopen);
  await reopened.getByRole("button", { name: "Add task" }).click();
  await expect(item(reopened, afterReopen)).toContainText("pending write");

  await context.setOffline(false);
  await expect(item(reopened, renamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(reopened, renamed)).toContainText("completed");
  await expect(item(reopened, beforeReopen)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(reopened, afterReopen)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(reopened, blockText)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(reopened.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
  await verifyRemoteState(email, [
    { title: renamed, completed: true },
    { title: beforeReopen, completed: false },
    { title: afterReopen, completed: false },
  ]);

  await reopened.reload();
  await expect(item(reopened, renamed)).toContainText("server-confirmed", { timeout: 30_000 });
  await expect(item(reopened, afterReopen)).toContainText("server-confirmed", { timeout: 30_000 });
});

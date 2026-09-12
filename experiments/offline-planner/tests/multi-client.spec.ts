import { expect, test, type Browser } from "@playwright/test";
import {
  blockText,
  createAccount,
  createConfirmedBlock,
  createConfirmedTask,
  deleteRemoteTask,
  findRemoteTaskId,
  item,
  remoteTask,
  signInAccount,
  verifyRemoteDeletion,
  verifyRemoteState,
} from "./browser-helpers.ts";

async function characterizeDeletedTaskRename(browser: Browser, deleteBeforeReconnect: boolean) {
  const marker = `delete-rename-${deleteBeforeReconnect ? "before" : "after"}-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const target = `${marker} target`;
  const renamedTarget = `${target} renamed while offline`;
  const control = `${marker} control`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await pageA.goto("/");
    await createAccount(pageA, email);
    await createConfirmedTask(pageA, target);
    await createConfirmedTask(pageA, control);
    await createConfirmedBlock(pageA);

    await pageB.goto("/");
    await signInAccount(pageB, email);
    for (const page of [pageA, pageB]) {
      await expect(item(page, target)).toContainText("open");
      await expect(item(page, target)).toContainText("server-confirmed", { timeout: 30_000 });
      await expect(item(page, control)).toContainText("open");
      await expect(item(page, control)).toContainText("server-confirmed");
      await expect(item(page, blockText)).toContainText("server-confirmed");
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    await verifyRemoteState(email, [
      { title: target, completed: false },
      { title: control, completed: false },
    ]);
    const targetId = await findRemoteTaskId(email, target);

    await contextB.setOffline(true);
    await pageB.getByRole("button", { name: `Edit ${target}` }).click();
    await pageB.getByLabel("Rename task").fill(renamedTarget);
    await pageB.getByRole("button", { name: "Save rename" }).click();
    await expect(item(pageB, renamedTarget)).toContainText("pending write");

    if (deleteBeforeReconnect) {
      await deleteRemoteTask(email, targetId);
      await expect(item(pageA, target)).toHaveCount(0, { timeout: 30_000 });
      await expect(item(pageB, renamedTarget)).toContainText("pending write");
      await contextB.setOffline(false);
      await expect(pageB.getByRole("alert")).toContainText(/not[_ -]?found|no (entity|document) to update/i, { timeout: 30_000 });
    } else {
      await contextB.setOffline(false);
      await expect(item(pageB, renamedTarget)).toContainText("server-confirmed", { timeout: 30_000 });
      await expect(pageB.getByRole("alert")).toHaveCount(0);
      const acknowledgedTarget = await remoteTask(email, targetId);
      expect(acknowledgedTarget.exists()).toBe(true);
      expect(acknowledgedTarget.data()).toMatchObject({ title: renamedTarget, completed: false });
      await deleteRemoteTask(email, targetId);
    }

    for (const page of [pageA, pageB]) {
      await expect(item(page, target)).toHaveCount(0, { timeout: 30_000 });
      await expect(item(page, renamedTarget)).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("listitem")).toHaveCount(2);
      await expect(item(page, control)).toContainText("open");
      await expect(item(page, control)).toContainText("server-confirmed");
      await expect(item(page, blockText)).toContainText("server-confirmed");
      await expect(page.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
    }
    await expect(pageA.getByRole("alert")).toHaveCount(0);
    if (deleteBeforeReconnect) {
      await expect(pageB.getByRole("alert")).toContainText(/not[_ -]?found|no (entity|document) to update/i);
    } else {
      await expect(pageB.getByRole("alert")).toHaveCount(0);
    }
    await verifyRemoteDeletion(email, targetId, [{ title: control, completed: false }]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
}

test("deletion before a queued offline task rename rejects the missing-document update", async ({ browser }) => {
  await characterizeDeletedTaskRename(browser, true);
});

test("queued task rename acknowledged before deletion converges without a write error", async ({ browser }) => {
  await characterizeDeletedTaskRename(browser, false);
});

test("isolated clients characterize ordered Firestore field and same-field sync",  async ({ browser }) => {
  const marker = `multi-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const taskOne = `${marker} independent fields`;
  const taskOneTitleFromA = `${taskOne} renamed by A`;
  const taskTwo = `${marker} same field`;
  const taskTwoTitleFromA = `${taskTwo} renamed by A`;
  const taskTwoTitleFromB = `${taskTwo} renamed by B`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await pageA.goto("/");
    await createAccount(pageA, email);
    await createConfirmedTask(pageA, taskOne);
    await createConfirmedTask(pageA, taskTwo);
    await createConfirmedBlock(pageA);

    await pageB.goto("/");
    await signInAccount(pageB, email);
    await expect(item(pageB, taskOne)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(pageB, taskTwo)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(pageB, blockText)).toContainText("server-confirmed", { timeout: 30_000 });

    await contextA.setOffline(true);
    await contextB.setOffline(true);

    await pageA.getByRole("button", { name: `Edit ${taskOne}` }).click();
    await pageA.getByLabel("Rename task").fill(taskOneTitleFromA);
    await pageA.getByRole("button", { name: "Save rename" }).click();
    await pageB.getByRole("button", { name: `Complete ${taskOne}` }).click();
    await expect(item(pageA, taskOneTitleFromA)).toContainText("pending write");
    await expect(item(pageA, taskOneTitleFromA)).toContainText("open");
    await expect(item(pageB, taskOne)).toContainText("pending write");
    await expect(item(pageB, taskOne)).toContainText("completed");

    await pageA.getByRole("button", { name: `Edit ${taskTwo}` }).click();
    await pageA.getByLabel("Rename task").fill(taskTwoTitleFromA);
    await pageA.getByRole("button", { name: "Save rename" }).click();
    await pageB.getByRole("button", { name: `Edit ${taskTwo}` }).click();
    await pageB.getByLabel("Rename task").fill(taskTwoTitleFromB);
    await pageB.getByRole("button", { name: "Save rename" }).click();
    await expect(item(pageA, taskTwoTitleFromA)).toContainText("pending write");
    await expect(item(pageB, taskTwoTitleFromB)).toContainText("pending write");

    await contextA.setOffline(false);
    await expect(item(pageA, taskOneTitleFromA)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(pageA, taskTwoTitleFromA)).toContainText("server-confirmed", { timeout: 30_000 });
    await verifyRemoteState(email, [
      { title: taskOneTitleFromA, completed: false },
      { title: taskTwoTitleFromA, completed: false },
    ]);

    await contextB.setOffline(false);
    await expect(item(pageA, taskOneTitleFromA)).toContainText("completed", { timeout: 30_000 });
    await expect(item(pageB, taskOneTitleFromA)).toContainText("completed", { timeout: 30_000 });
    await expect(item(pageA, taskTwoTitleFromB)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(pageB, taskTwoTitleFromB)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(pageA, taskTwoTitleFromA)).toHaveCount(0);
    await expect(item(pageB, taskTwoTitleFromA)).toHaveCount(0);
    await expect(pageA.getByRole("listitem")).toHaveCount(3);
    await expect(pageB.getByRole("listitem")).toHaveCount(3);
    await expect(pageA.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
    await expect(pageB.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
    await verifyRemoteState(email, [
      { title: taskOneTitleFromA, completed: true },
      { title: taskTwoTitleFromB, completed: false },
    ]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

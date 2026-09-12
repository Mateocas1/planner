import { expect, test } from "@playwright/test";
import "./multi-client.spec.ts";
import {
  blockText,
  createAccount,
  createConfirmedBlock,
  createConfirmedTask,
  item,
  verifyRemoteState,
} from "./browser-helpers.ts";

test.setTimeout(60_000);

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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  blockText,
  createAccount,
  createConfirmedBlock,
  createConfirmedTask,
  findRemoteBlockId,
  item,
  verifyRemoteBlockDeletion,
  verifyRemoteState,
} from "./browser-helpers.ts";

const run = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname;

async function build(mode?: "sw-update-old" | "sw-update-new") {
  await run(process.execPath, ["./node_modules/vite/bin/vite.js", "build", ...(mode ? ["--mode", mode] : [])], {
    cwd: projectRoot,
  });
}

type WorkerRegistration = { registrationId: string; scopeURL: string };
type WorkerVersion = {
  versionId: string;
  registrationId: string;
  status: string;
  controlledClients?: string[];
};
type ObservedWorkerVersion = WorkerVersion & { statuses: Set<string> };

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

test("deletes a block through the UI and proves its server absence across a reload", async ({ page }) => {
  const marker = `delete-block-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const control = `${marker} control`;

  await page.goto("/");
  await createAccount(page, email);
  await createConfirmedTask(page, control);
  await createConfirmedBlock(page);
  await verifyRemoteState(email, [{ title: control, completed: false }]);
  const blockId = await findRemoteBlockId(email);

  await page.getByRole("button", { name: "Delete block" }).click();
  await expect(item(page, blockText)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Delete block" })).toHaveCount(0);
  await verifyRemoteBlockDeletion(email, blockId, [{ title: control, completed: false }]);

  await page.reload();
  await expect(item(page, blockText)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Delete block" })).toHaveCount(0);
  await expect(item(page, control)).toContainText("server-confirmed", { timeout: 30_000 });
});

test("observes a waiting Workbox update while Firestore writes are backend-blocked", async ({ page, context }) => {
  const marker = `sw-update-${Date.now()}`;
  const email = `${marker}@example.invalid`;
  const original = `${marker} original`;
  const renamed = `${marker} renamed`;
  const created = `${marker} created`;
  const control = `${marker} control`;
  let firestoreRequests = 0;
  let observer: Page | undefined;
  let session: CDPSession | undefined;

  try {
    await build("sw-update-old");
    await page.goto("/");
    await expect(page.locator('meta[name="offline-planner-build"]')).toHaveAttribute("content", "sw-update-old");
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const initial = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const controller = navigator.serviceWorker.controller;
      if (!registration || !controller) throw new Error("expected initial worker control");
      const state = window as Window & { oldController?: ServiceWorker; runtimeId?: string; navigationCount?: number };
      state.oldController = controller;
      state.runtimeId = crypto.randomUUID();
      state.navigationCount = performance.getEntriesByType("navigation").length;
      return { controllerUrl: controller.scriptURL, runtimeId: state.runtimeId };
    });
    observer = await context.newPage();
    await expect(observer).toHaveURL("about:blank");
    session = await context.newCDPSession(observer);
    const registrations = new Map<string, WorkerRegistration>();
    const versions = new Map<string, ObservedWorkerVersion>();
    session.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: updates }: { registrations: WorkerRegistration[] }) => {
      for (const registration of updates) registrations.set(registration.registrationId, registration);
    });
    session.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }: { versions: WorkerVersion[] }) => {
      for (const version of updates) {
        const prior = versions.get(version.versionId);
        versions.set(version.versionId, {
          ...version,
          statuses: new Set([...(prior?.statuses ?? []), version.status]),
        });
      }
    });
    await session.send("ServiceWorker.enable");
    const appScope = new URL("/", page.url()).href;
    await expect.poll(() => [...registrations.values()].filter(registration => registration.scopeURL === appScope).length).toBe(1);
    const registrationId = [...registrations.values()].find(registration => registration.scopeURL === appScope)!.registrationId;
    await expect.poll(() => [...versions.values()].filter(version => version.registrationId === registrationId && version.status === "activated").length).toBe(1);
    const oldVersionId = [...versions.values()].find(version => version.registrationId === registrationId && version.status === "activated")!.versionId;

    const oldWorker = await page.request.get(`/sw.js?build=${marker}-old`);
    expect(oldWorker.ok()).toBe(true);
    const oldWorkerBytes = await oldWorker.body();

    await createAccount(page, email);
    await createConfirmedTask(page, original);
    await createConfirmedTask(page, control);
    await createConfirmedBlock(page);
    await verifyRemoteState(email, [{ title: original, completed: false }, { title: control, completed: false }]);

    await context.route("http://127.0.0.1:8087/**", async route => {
      firestoreRequests += 1;
      await route.abort("failed");
    });
    await page.getByRole("button", { name: `Edit ${original}` }).click();
    await page.getByLabel("Rename task").fill(renamed);
    await page.getByRole("button", { name: "Save rename" }).click();
    await page.getByRole("button", { name: `Complete ${renamed}` }).click();
    await page.getByLabel("Task title").fill(created);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(item(page, renamed)).toContainText("pending write");
    await expect(item(page, renamed)).toContainText("completed");
    await expect(item(page, created)).toContainText("pending write");
    await expect(item(page, control)).toContainText("server-confirmed");
    await expect.poll(() => firestoreRequests).toBeGreaterThan(0);
    await verifyRemoteState(email, [{ title: original, completed: false }, { title: control, completed: false }]);

    await build("sw-update-new");
    const newHtml = await page.request.get(`/?build=${marker}-new`);
    expect(newHtml.ok()).toBe(true);
    expect(await newHtml.text()).toContain('content="sw-update-new"');
    const newWorker = await page.request.get(`/sw.js?build=${marker}-new`);
    expect(newWorker.ok()).toBe(true);
    expect(await newWorker.body()).not.toEqual(oldWorkerBytes);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === "installed");
    await expect.poll(() => [...versions.values()].filter(version =>
      version.registrationId === registrationId
      && version.versionId !== oldVersionId
      && version.statuses.has("installing")
      && version.statuses.has("installed"),
    ).length).toBe(1);
    const newVersionId = [...versions.values()].find(version =>
      version.registrationId === registrationId
      && version.versionId !== oldVersionId
      && version.statuses.has("installing")
      && version.statuses.has("installed"),
    )!.versionId;
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
    await expect(page.evaluate(() => navigator.onLine)).resolves.toBe(true);
    await expect(item(page, renamed)).toContainText("pending write");
    await expect(item(page, renamed)).toContainText("completed");
    await expect(item(page, created)).toContainText("pending write");
    await expect(item(page, created)).toContainText("open");
    await expect(item(page, control)).toContainText("server-confirmed");
    await expect(item(page, control)).toContainText("open");
    await expect(item(page, blockText)).toContainText("server-confirmed");
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(item(page, original)).toHaveCount(0);
    await expect.poll(() => page.evaluate(({ controllerUrl, runtimeId }) => {
      const state = window as Window & { oldController?: ServiceWorker; runtimeId?: string; navigationCount?: number };
      return navigator.serviceWorker.controller === state.oldController
        && navigator.serviceWorker.controller?.scriptURL === controllerUrl
        && state.runtimeId === runtimeId
        && performance.getEntriesByType("navigation").length === state.navigationCount;
    }, initial)).toBe(true);

    await context.unroute("http://127.0.0.1:8087/**");
    await expect(item(page, renamed)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(item(page, renamed)).toContainText("completed");
    await expect(item(page, created)).toContainText("server-confirmed", { timeout: 30_000 });
    await expect(page.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(item(page, control)).toContainText("server-confirmed");
    await expect(item(page, control)).toContainText("open");
    await expect(item(page, blockText)).toContainText("server-confirmed");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(item(page, original)).toHaveCount(0);
    await verifyRemoteState(email, [
      { title: renamed, completed: true },
      { title: created, completed: false },
      { title: control, completed: false },
    ]);

    await context.setOffline(true);
    await page.close();
    await expect.poll(() => versions.get(newVersionId)?.status).toBe("activated");
    const reopened = await context.newPage();
    await reopened.goto("/");
    await expect(reopened.locator('meta[name="offline-planner-build"]')).toHaveAttribute("content", "sw-update-new");
    await reopened.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return navigator.serviceWorker.controller !== null && registration?.active !== undefined && !registration.waiting;
    });
    expect(versions.get(newVersionId)?.status).toBe("activated");
    await expect(reopened.evaluate(() => navigator.onLine)).resolves.toBe(false);
    await expect(reopened.getByText(`Signed in as ${email}.`)).toBeVisible();
    await expect(item(reopened, renamed)).toContainText("cached");
    await expect(item(reopened, renamed)).toContainText("completed");
    await expect(item(reopened, created)).toContainText("cached");
    await expect(item(reopened, created)).toContainText("open");
    await expect(item(reopened, control)).toContainText("cached");
    await expect(item(reopened, control)).toContainText("open");
    await expect(item(reopened, blockText)).toContainText("cached");
    await expect(reopened.getByRole("listitem")).toHaveCount(4);
    await expect(item(reopened, original)).toHaveCount(0);
    await expect(reopened.getByRole("listitem").filter({ hasText: "pending write" })).toHaveCount(0);
    await expect(reopened.getByRole("alert")).toHaveCount(0);
  } finally {
    try {
      await context.unroute("http://127.0.0.1:8087/**");
    } finally {
      try {
        await session?.detach();
      } finally {
        try {
          await observer?.close();
        } finally {
          await build();
        }
      }
    }
  }
});

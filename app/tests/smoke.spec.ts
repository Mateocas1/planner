import { expect, test, type Page } from "@playwright/test";

/**
 * The offline smoke test, run against the deployed site by `npm run test:smoke`.
 *
 * It proves two offline claims that fail differently:
 *   1. the shell loads with no network — only the service worker can do that;
 *   2. the data renders with no network — only Firestore's persistent cache can.
 *
 * It uses one clearly-marked account, created on the first ever run and signed
 * in on every later one, so the project accumulates at most a single smoke
 * account. Nothing here deletes a user, writes anything the app's own UI could
 * not write, or touches the deployed rules or config.
 */

test.setTimeout(180_000);

const SMOKE_EMAIL = "offline-smoke@example.com";
const SMOKE_PASSWORD = "redacted-pass";

/**
 * Waits for the precache worker to finish installing and activate. This is a
 * condition wait, not a fixed sleep: a brand-new registration activates on its
 * own (there is no old worker to wait behind), and only after that can a reload
 * be served from the precached shell.
 */
async function waitForWorkerActive(page: Page) {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.state === "activated";
    },
    undefined,
    { timeout: 60_000 },
  );
}

test("the deployed app reloads its shell and cached data with no network", async ({ page, context }) => {
  const title = `Offline smoke ${Date.now()}`;
  const tasksNav = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" });
  const taskRow = page.locator(".task-title", { hasText: title });
  const identity = page.getByText(`Signed in as ${SMOKE_EMAIL}`);

  // Sign in, creating the smoke account the first time this ever runs.
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(SMOKE_EMAIL);
  await page.getByLabel("Password").fill(SMOKE_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const signInError = page.getByRole("alert");
  await expect(identity.or(signInError)).toBeVisible({ timeout: 30_000 });
  if (await signInError.isVisible()) {
    // No account exists yet on the first ever run: create it, then it signs in.
    await page.getByRole("button", { name: "Create account" }).click();
  }
  await expect(identity).toBeVisible({ timeout: 30_000 });

  // Create a task through the UI.
  await tasksNav.click();
  await expect(page.getByRole("button", { name: "Add task" })).toBeVisible();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(taskRow).toBeVisible();
  // The write settled enough to re-enable the form before we reload it.
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();

  await waitForWorkerActive(page);

  // Online reload: the task survives a fresh document load, so the write is
  // not trapped in this page's memory.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
  await expect(identity).toBeVisible({ timeout: 30_000 });
  await tasksNav.click();
  await expect(taskRow).toBeVisible({ timeout: 30_000 });

  // Offline reload: no network at all. A successful navigation here is the
  // service worker serving the precached shell; the assertions below prove
  // what that shell then renders.
  await context.setOffline(true);
  await page.reload();

  // Shell proof: the precached app chrome, not a white page.
  await expect(page.getByText("Personal Planner")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 30_000 });
  await expect(identity).toBeVisible({ timeout: 30_000 });

  // Data proof: the task created above, rendered from Firestore's local cache.
  await tasksNav.click();
  await expect(taskRow).toBeVisible({ timeout: 30_000 });
});

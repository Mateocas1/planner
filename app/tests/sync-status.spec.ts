import { expect, test, type Page } from "@playwright/test";
import { createRemoteAccount, password, seedTaskAndBlock } from "./browser-helpers.ts";

test.setTimeout(60_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signUp(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

/** Signs an existing (remotely seeded) account in through the browser form. */
async function signInAs(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Creates a task through the New task sheet and waits for the sheet to leave. */
async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

/** The sync line: the status region that carries the sync wording. Other
 * views also use role="status" (loading, empty states), so it is scoped. */
function syncLine(page: Page) {
  return page.getByRole("status").filter({ has: page.locator(".sync-text") });
}

test("writes the server has not acknowledged are counted, and the line says Synced once they clear", async ({ page }) => {
  const email = newEmail("sync-count");
  await signUp(page, email);
  await openTasks(page);
  await expect(syncLine(page)).toHaveText("Synced");

  // Abort the write channel so acknowledgements cannot arrive. The writes stay
  // queued on this device, which is exactly what the line counts.
  await page.route(/\/Write\/channel/, route => route.abort());

  await addTask(page, "First held task");
  await expect(syncLine(page)).toHaveText("1 change waiting to sync");

  // A change of count within the same state updates the text in place: the
  // marked node survives, so it does not fade again.
  const swap = syncLine(page).locator(".sync-text");
  await swap.evaluate(node => node.setAttribute("data-marked", "yes"));
  await addTask(page, "Second held task");
  await expect(syncLine(page)).toHaveText("2 changes waiting to sync");
  await expect(swap).toHaveAttribute("data-marked", "yes");

  // Releasing the channel lets the queue drain; the count returns to Synced.
  await page.unroute(/\/Write\/channel/);
  await expect(syncLine(page)).toHaveText("Synced", { timeout: 45_000 });
});

test("offline, the line names the state and counts the changes still waiting", async ({ page, context }) => {
  const email = newEmail("sync-offline");
  await signUp(page, email);
  await openTasks(page);

  await context.setOffline(true);
  await expect(syncLine(page)).toHaveText("Offline · nothing waiting");
  await addTask(page, "Offline task");
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  await context.setOffline(false);
  await expect(syncLine(page)).toHaveText("Synced", { timeout: 30_000 });
});

test("a delete made offline is counted until the server acknowledges it", async ({ page, context }) => {
  const email = newEmail("sync-delete");
  await createRemoteAccount(email);
  await seedTaskAndBlock(email, "Remote task", "2026-03-02T09:00:00-03:00", "2026-03-02T10:00:00-03:00");
  await signInAs(page, email);
  await openTasks(page);
  await expect(page.locator(".task-title", { hasText: "Remote task" })).toBeVisible();
  await expect(syncLine(page)).toHaveText("Synced");

  // A removal leaves the snapshot, so the count comes from the delete's own write.
  await context.setOffline(true);
  await page.getByRole("button", { name: "Remote task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expect(page.locator(".task-title", { hasText: "Remote task" })).toHaveCount(0);
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  await context.setOffline(false);
  await expect(syncLine(page)).toHaveText("Synced", { timeout: 30_000 });
});

test.describe("sync line motion", () => {
  test("the line is static apart from a 140ms opacity swap, and is announced politely", async ({ page }) => {
    const email = newEmail("sync-motion");
    await signUp(page, email);

    const line = syncLine(page);
    await expect(line).toHaveAttribute("aria-live", "polite");
    await expect(line).toHaveCSS("animation-name", "none");
    const swap = line.locator(".sync-text");
    await expect(swap).toHaveCSS("animation-name", "sync-swap");
    await expect(swap).toHaveCSS("animation-duration", "0.14s");
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the swap collapses to an instant change", async ({ page }) => {
      const email = newEmail("sync-reduced");
      await signUp(page, email);

      await expect(syncLine(page).locator(".sync-text")).toHaveCSS("animation-duration", "0.001s");
    });
  });
});

import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

/**
 * Cross-feature invariants (M1).
 *
 * Each feature's own spec pins its own rules; these tests pin the places where
 * two of them meet and a merge can keep both behaviours while still leaving
 * them disagreeing. The sync line counts unacknowledged writes, and undo is a
 * compensating write: undoing a delete has to leave the count describing one
 * pending change, not two.
 */

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

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Creates a task through the New task sheet and waits for its row and for the
 * sheet to leave, exactly as the flow suite does. */
async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

/** The sync line, scoped past the other polite status regions. */
function syncLine(page: Page) {
  return page.getByRole("status").filter({ has: page.locator(".sync-text") });
}

test("undoing a delete that is still waiting to sync leaves one pending change, not two", async ({ page, context }) => {
  const email = newEmail("integ-undo-sync");
  await signUp(page, email);
  await openTasks(page);
  await addTask(page, "Held task");
  await expect(syncLine(page)).toHaveText("Synced");

  // Offline, so the delete stays queued: the line counts it from the delete's
  // own write, because a removal is never flagged in a snapshot.
  await context.setOffline(true);
  await expect(syncLine(page)).toHaveText("Offline · nothing waiting");
  await page.getByRole("button", { name: "Held task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expect(page.locator(".task-title", { hasText: "Held task" })).toHaveCount(0);
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  // Undo restores the document with a write of its own. That write supersedes
  // the delete it compensates for, so the offer still describes one change:
  // counting both would tell the user two things are unsaved when only one
  // document differs from the server.
  await page.locator(".undo-toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".task-title", { hasText: "Held task" })).toBeVisible();
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  // Both queued writes flush on reconnect and the line returns to Synced.
  await context.setOffline(false);
  await expect(syncLine(page)).toHaveText("Synced", { timeout: 30_000 });
});

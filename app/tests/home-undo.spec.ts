import { expect, test, type Page } from "@playwright/test";
import { readRemoteTasks, seedTasks, submitAuthForm } from "./browser-helpers.ts";

/**
 * F6c's other half — the undo offer on Today. Home's rows act through the same
 * writes Tasks and the Calendar already use (`x`, `t`, Enter and the delete in
 * the details sheet), so they owe the same offer: the shell's undo toast, whose
 * Undo writes the item back. With the shell's offer unwired the row moves and
 * the delete lands with no way back, which is what these two cases pin.
 *
 * Everything is driven from the keyboard, as the row cursor is; the assertions
 * read what the user sees (the toast, the list) and what the server stored. The
 * zone is UTC, so a date key and a stored instant mean one hour.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test.setTimeout(90_000);

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A UTC day key `offset` days from now. */
function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function openToday(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("heading", { name: "Today", level: 2 })).toBeVisible();
}

/** Puts the caret back on the page itself, the way clicking an inert part of it
 * does: nothing holds focus, so `j` has to find the first row on its own. */
async function focusPage(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

const dueList = (page: Page) =>
  page.locator("section.list-section").filter({ has: page.getByRole("heading", { name: "Due today" }) });
const dueRow = (page: Page, title: string) => dueList(page).locator("li.row", { hasText: title }).locator("[data-row-cursor]");
const details = (page: Page) => page.getByRole("complementary", { name: "Task details" });
const undoToast = (page: Page) => page.locator(".undo-toast");

/** Signs in, seeds one task due today, opens Today and puts the caret on it. */
async function seedDueToday(page: Page, prefix: string): Promise<string> {
  const email = newEmail(prefix);
  await submitAuthForm(page, email, "sign up");
  await seedTasks(email, [{ title: "Alpha invoice", deadline: utcDay(0) }]);
  await openToday(page);
  await expect(dueRow(page, "Alpha invoice")).toBeVisible();
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();
  return email;
}

test("deleting a task from Today's details offers undo, and undo puts the task back", async ({ page }) => {
  const email = await seedDueToday(page, "home-undo-delete");

  await page.keyboard.press("Enter");
  await expect(details(page)).toBeVisible();
  await details(page).getByRole("button", { name: "Delete task" }).click();
  await expect(details(page)).toHaveCount(0);

  // the offer is the shell's, and the delete is already the stored state
  await expect(undoToast(page)).toContainText("Task deleted");
  await expect(dueRow(page, "Alpha invoice")).toHaveCount(0);
  await expect.poll(async () => (await readRemoteTasks(email)).length, poll).toBe(0);

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);
  await expect(dueRow(page, "Alpha invoice")).toBeVisible();
  await expect
    .poll(async () => (await readRemoteTasks(email)).map(task => [task.title, task.deadline]), poll)
    .toEqual([["Alpha invoice", utcDay(0)]]);
});

test("t on a Today row offers undo, and undo restores the deadline", async ({ page }) => {
  const email = await seedDueToday(page, "home-undo-tomorrow");

  await page.keyboard.press("t");

  // the move is written, and the shell offers it back under the date it landed on
  await expect(undoToast(page)).toContainText("Deadline moved to");
  await expect.poll(async () => (await readRemoteTasks(email))[0]?.deadline, poll).toBe(utcDay(1));

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);
  await expect.poll(async () => (await readRemoteTasks(email))[0]?.deadline, poll).toBe(utcDay(0));
});

import { expect, test, type Page } from "@playwright/test";
import {
  readRemoteTasks,
  seedDaySettings,
  seedTasks,
  submitAuthForm,
} from "./browser-helpers.ts";

/**
 * F6b — palette actions with key hints (odd/research/distinctive-roadmap.md §2,
 * "F6. Keyboard-first", criterion 5).
 *
 * The palette lists the keyboard's actions with the key that performs them.
 * Each case opens the palette the way a keyboard user does (Ctrl+K), types the
 * action's words, and reads what the user sees: the hint chip on the row, the
 * selected row, and then what the server stored after the action ran.
 */

/* A desktop, so the palette and the Tasks list are the pointer-free surfaces a
   keyboard user reaches (the hints are hidden on touch-only devices). */
test.use({ viewport: { width: 1440, height: 900 } });

test.setTimeout(90_000);

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A UTC day key `offset` days from now; the zone these cases run in. */
function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

async function openView(page: Page, name: "Today" | "Tasks" | "Calendar") {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name }).click();
}

/** Puts the caret back on the page itself, so nothing holds focus. */
async function focusPage(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const field = (page: Page) => dialog(page).getByRole("combobox", { name: "Search tasks or run a command" });
const options = (page: Page) => dialog(page).getByRole("listbox", { name: "Results" }).getByRole("option");

/** The row-cursor control of one task row: the title button. */
const rowOf = (page: Page, title: string) => page.locator("li.task", { hasText: title }).locator("button.task-open");

/** The stored tasks by title, reduced to the fields a case names. */
async function remoteTask(email: string, title: string) {
  await expect
    .poll(async () => (await readRemoteTasks(email)).some(task => task.title === title), poll)
    .toBe(true);
  return (await readRemoteTasks(email)).find(task => task.title === title);
}

test("Complete task is listed with its key, and runs on the focused row", async ({ page }) => {
  const email = newEmail("palette-complete");
  await signUp(page, email);
  await seedTasks(email, [
    { title: "Alpha invoice", deadline: utcDay(0) },
    { title: "Bravo report", deadline: utcDay(1) },
  ]);
  await openView(page, "Tasks");
  await expect(rowOf(page, "Alpha invoice")).toBeVisible();
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await field(page).fill("complete");
  // the row shows the key the keyboard answers with, and the create row is first
  const action = options(page).filter({ hasText: "Complete task" });
  await expect(action).toHaveCount(1);
  await expect(action.locator("kbd")).toHaveText("x");

  await page.keyboard.press("ArrowDown");
  await expect(action).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => (await remoteTask(email, "Alpha invoice"))?.completed, poll).toBe(true);
  expect((await remoteTask(email, "Bravo report"))?.completed).not.toBe(true);
});

test("Move to tomorrow moves the focused task's deadline by one day", async ({ page }) => {
  const email = newEmail("palette-tomorrow");
  await signUp(page, email);
  await seedTasks(email, [{ title: "Alpha invoice", deadline: utcDay(0) }]);
  await openView(page, "Tasks");
  await expect(rowOf(page, "Alpha invoice")).toBeVisible();
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();

  await page.keyboard.press("Control+k");
  await field(page).fill("tomorrow");
  const action = options(page).filter({ hasText: "Move to tomorrow" });
  await expect(action.locator("kbd")).toHaveText("t");
  await page.keyboard.press("ArrowDown");
  await expect(action).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => (await remoteTask(email, "Alpha invoice"))?.deadline, poll).toBe(utcDay(1));
});

test("the task actions are not listed when no task holds focus", async ({ page }) => {
  const email = newEmail("palette-unfocused");
  await signUp(page, email);
  await seedTasks(email, [{ title: "Alpha invoice", deadline: utcDay(0) }]);
  await openView(page, "Tasks");
  await expect(rowOf(page, "Alpha invoice")).toBeVisible();
  await focusPage(page);

  await page.keyboard.press("Control+k");
  await field(page).fill("complete");
  await expect(options(page).filter({ hasText: "Create" })).toHaveCount(1);
  await expect(options(page).filter({ hasText: "Complete task" })).toHaveCount(0);
});

test("the Now mode row shows its key, the same key the router answers with", async ({ page }) => {
  const email = newEmail("palette-now");
  await signUp(page, email);
  await openView(page, "Today");

  await page.keyboard.press("Control+k");
  await field(page).fill("now");
  const action = options(page).filter({ hasText: "Open Now mode" });
  // the positive control for the hidden-hint case below: the profile is read and the key shows
  await expect(action.locator("kbd")).toHaveText("n");
});

test("the key hints are left out when keyboard shortcuts are off", async ({ page }) => {
  const email = newEmail("palette-shortcuts-off");
  await seedDaySettings(email, { timeZone: "UTC", shortcutsEnabled: false });
  await submitAuthForm(page, email, "sign in");
  await openView(page, "Today");

  await page.keyboard.press("Control+k");
  await field(page).fill("now");
  const action = options(page).filter({ hasText: "Open Now mode" });
  await expect(action).toHaveCount(1);
  // The profile arrives asynchronously and no element marks its arrival, so the
  // absence is checked after a settle window long enough for the first snapshot
  // (the positive case above shows the same read lands in well under a second).
  await page.waitForTimeout(1_500);
  await expect(action.locator("kbd")).toHaveCount(0);
  await expect(action).not.toHaveAttribute("aria-keyshortcuts", /./);
});

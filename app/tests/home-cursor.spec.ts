import { expect, test, type Page } from "@playwright/test";
import { readRemoteBlocks, readRemoteTasks, seedTaskAndBlock, seedTasks, submitAuthForm } from "./browser-helpers.ts";

/**
 * F6c — the row cursor on Today (distinctive roadmap F6, "Keyboard-first"). The
 * Due today list, the Coming up list and the Schedule's blocks are cursor
 * stops, walked by `j`/`k` in the order they are painted, and act through the
 * same writes the Tasks list and the Calendar use: `x` completes, `t` moves the
 * deadline or the block one day, and Enter opens the task's details.
 *
 * Everything is driven from the keyboard; the assertions read what the user
 * sees (which control holds focus, which list a row is in) and what the server
 * stored. The zone is UTC, so a date key and a stored instant mean one hour.
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

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
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
const upcomingList = (page: Page) =>
  page.locator("section.list-section").filter({ has: page.getByRole("heading", { name: "Coming up" }) });
const scheduleList = (page: Page) =>
  page.locator("section.list-section").filter({ has: page.getByRole("heading", { name: "Schedule" }) });

/** The row-cursor control of a Today row, by its visible title. */
const dueRow = (page: Page, title: string) => dueList(page).locator("li.row", { hasText: title }).locator("[data-row-cursor]");
const upcomingRow = (page: Page, title: string) => upcomingList(page).locator("li.row", { hasText: title }).locator("[data-row-cursor]");
const blockRow = (page: Page, title: string) => scheduleList(page).locator("li.agenda-item", { hasText: title }).locator("[data-row-cursor]");

/** Seeds two tasks (one due today, one within the week) and a block today, then
 * opens Today on a signed-in account. */
async function seedToday(page: Page, email: string) {
  await signUp(page, email);
  await seedTasks(email, [
    { title: "Alpha invoice", deadline: utcDay(0) },
    { title: "Bravo report", deadline: utcDay(2) },
  ]);
  await seedTaskAndBlock(email, "Plan the sprint", `${utcDay(0)}T10:00:00+00:00`, `${utcDay(0)}T11:00:00+00:00`);
  await openToday(page);
  await expect(dueRow(page, "Alpha invoice")).toBeVisible();
  await expect(upcomingRow(page, "Bravo report")).toBeVisible();
  await expect(blockRow(page, "Work block")).toBeVisible();
  await focusPage(page);
}

test("j and k walk Due today, Coming up and the Schedule in order, and k at the first row stays", async ({ page }) => {
  const email = newEmail("home-walk");
  await seedToday(page, email);

  // criterion 1, on Today: the first Due today row takes focus, and k on it stays
  await page.keyboard.press("j");
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("k");
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();

  // j walks down through the lists in the order they are painted
  await page.keyboard.press("j");
  await expect(upcomingRow(page, "Bravo report")).toBeFocused();
  await page.keyboard.press("j");
  await expect(blockRow(page, "Work block")).toBeFocused();
  await page.keyboard.press("j");
  await expect(blockRow(page, "Work block")).toBeFocused();

  // exactly one row of the page is a tab stop: the one the cursor is on
  await expect(blockRow(page, "Work block")).toHaveAttribute("tabindex", "0");
  await expect(dueRow(page, "Alpha invoice")).toHaveAttribute("tabindex", "-1");
});

test("x completes the focused Due today task through the Tasks write", async ({ page }) => {
  const email = newEmail("home-complete");
  await seedToday(page, email);

  await page.keyboard.press("j");
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("x");

  await expect(dueList(page).locator("li.row", { hasText: "Alpha invoice" })).toHaveCount(0);
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Alpha invoice")?.completed === true, poll)
    .toBe(true);
});

test("Enter opens the focused Due today task's details, and Escape returns the caret to its row", async ({ page }) => {
  const email = newEmail("home-enter");
  await seedToday(page, email);

  await page.keyboard.press("j");
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("Enter");

  const details = page.getByRole("complementary", { name: "Task details" });
  await expect(details).toBeVisible();
  await expect(details.getByLabel("Rename task")).toHaveValue("Alpha invoice");
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(dueRow(page, "Alpha invoice")).toBeFocused();
});

test("t moves a Schedule block one calendar day, at the same hour", async ({ page }) => {
  const email = newEmail("home-block");
  await signUp(page, email);
  await seedTaskAndBlock(email, "Plan the sprint", `${utcDay(0)}T10:00:00+00:00`, `${utcDay(0)}T11:00:00+00:00`);
  await openToday(page);
  await expect(blockRow(page, "Work block")).toBeVisible();
  await focusPage(page);

  // the only cursor stop on this page is the block: j lands on it
  await page.keyboard.press("j");
  await expect(blockRow(page, "Work block")).toBeFocused();
  await page.keyboard.press("t");

  await expect
    .poll(async () => (await readRemoteBlocks(email)).map(entry => entry.start), poll)
    .toEqual([`${utcDay(1)}T10:00:00+00:00`]);
  expect((await readRemoteBlocks(email))[0].end).toBe(`${utcDay(1)}T11:00:00+00:00`);
});

import { expect, test, type Page } from "@playwright/test";
import {
  readRemoteBlocks,
  readRemoteDaySettings,
  readRemoteTasks,
  seedProfileAndBlock,
  seedTaskAndBlock,
  seedTasks,
  submitAuthForm,
} from "./browser-helpers.ts";

/**
 * F6a — keyboard-first (odd/research/distinctive-roadmap.md §2, "F6.
 * Keyboard-first", criteria 1, 2, 3, 4, 6, 7 and 8).
 *
 * Everything here is driven the way a person with a keyboard does it: no
 * pointer reaches a row, no element is focused through the test API. What the
 * assertions read is what the user and the screen reader get -- which control
 * holds focus, which group the row landed in, what the server stored -- plus the
 * toast they can take the move back with.
 *
 * The zone is UTC unless a case names another one, so a date key and a stored
 * instant mean the same hour. The DST case pins the browser clock instead,
 * because the hour a block keeps can only be wrong on the two days a year the
 * zone's offset changes.
 */

/* A desktop by default: the sidebar, the week grid and the account row are the
   surfaces the keyboard reaches. The phone case sets its own viewport. */
test.use({ viewport: { width: 1440, height: 900 } });

test.setTimeout(90_000);

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A UTC day key `offset` days from now; the zone every case but DST pins. */
function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

async function openView(page: Page, name: "Today" | "Tasks" | "Calendar") {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name }).click();
}

/** Puts the caret back on the page itself, the way clicking an inert part of it
 * does: nothing holds focus, so `j` has to find the first row on its own. */
async function focusPage(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

const openGroup = (page: Page) =>
  page.locator("section.task-group").filter({ has: page.getByRole("heading", { name: /^Open / }) });
const completedGroup = (page: Page) =>
  page.locator("section.task-group").filter({ has: page.getByRole("heading", { name: /^Completed / }) });

/** The row-cursor control of one task row: the title button, which is the
 * control that opens it. */
const rowOf = (page: Page, title: string) => page.locator("li.task", { hasText: title }).locator("button.task-open");

/** Three tasks with distinct deadlines, so the Open list has one settled order
 * (by deadline) that a test can walk. */
async function seedWalkableTasks(page: Page, email: string) {
  await signUp(page, email);
  await seedTasks(email, [
    { title: "Alpha invoice", deadline: utcDay(0) },
    { title: "Bravo report", deadline: utcDay(1) },
    { title: "Charlie review", deadline: utcDay(3) },
  ]);
  await openView(page, "Tasks");
  await expect(rowOf(page, "Alpha invoice")).toBeVisible();
  await expect(rowOf(page, "Charlie review")).toBeVisible();
}

/** The stored tasks by title, with only the fields a case names: the server's
 * document order is not the list's, and a completion instant is a clock. */
async function expectTasks(email: string, expected: Array<{ title: string; completed: boolean; deadline?: string }>) {
  await expect
    .poll(async () => {
      const tasks = await readRemoteTasks(email);
      return tasks
        .map(task => ({
          title: String(task.title),
          completed: task.completed === true,
          ...(typeof task.deadline === "string" ? { deadline: task.deadline } : {}),
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
    }, poll)
    .toEqual([...expected].sort((left, right) => left.title.localeCompare(right.title)));
}

test("j and k walk the Tasks rows with real focus, and stop at the ends", async ({ page }) => {
  const email = newEmail("keys-walk");
  await seedWalkableTasks(page, email);
  await focusPage(page);

  // criterion 1: the first row takes focus, and k on it stays there
  await page.keyboard.press("j");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("k");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();

  // j again walks forward, down the list, and stops at the last row
  await page.keyboard.press("j");
  await expect(rowOf(page, "Bravo report")).toBeFocused();
  await page.keyboard.press("j");
  await expect(rowOf(page, "Charlie review")).toBeFocused();
  await page.keyboard.press("j");
  await expect(rowOf(page, "Charlie review")).toBeFocused();

  // the arrows are the same two actions
  await page.keyboard.press("ArrowUp");
  await expect(rowOf(page, "Bravo report")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rowOf(page, "Charlie review")).toBeFocused();

  // exactly one row is a tab stop: the one the cursor is on
  await expect(rowOf(page, "Charlie review")).toHaveAttribute("tabindex", "0");
  await expect(rowOf(page, "Alpha invoice")).toHaveAttribute("tabindex", "-1");
});

test("x completes the focused task, t moves its deadline, and a field keeps its keys", async ({ page }) => {
  const email = newEmail("keys-act");
  await seedWalkableTasks(page, email);
  await focusPage(page);

  // t moves the deadline one day and offers to take it back; the toast is the
  // shell's own offer, so undo is the compensating write it always is
  await page.keyboard.press("j");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("t");
  await expect(page.locator(".task-deadline").filter({ hasText: "tomorrow" }).first()).toBeVisible();
  const toast = page.locator(".undo-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Deadline moved to tomorrow");
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Alpha invoice")?.deadline, poll)
    .toBe(utcDay(1));
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Alpha invoice")?.deadline, poll)
    .toBe(utcDay(0));

  // criterion 2: the focused row completes through the same write the check
  // uses, and travels to Completed. Pressing Undo left the caret nowhere (the
  // toast it was on is gone), so the walk starts from the page again.
  await focusPage(page);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(rowOf(page, "Bravo report")).toBeFocused();
  await page.keyboard.press("x");
  await expect(completedGroup(page).locator("li.task", { hasText: "Bravo report" })).toHaveCount(1);
  await expect(openGroup(page).locator("li.task", { hasText: "Bravo report" })).toHaveCount(0);
  await expectTasks(email, [
    { title: "Alpha invoice", completed: false, deadline: utcDay(0) },
    { title: "Bravo report", completed: true, deadline: utcDay(1) },
    { title: "Charlie review", completed: false, deadline: utcDay(3) },
  ]);
  // the row that travelled keeps the caret, so the keyboard has not been dropped
  await expect(page.locator("li.task:focus-within", { hasText: "Bravo report" })).toHaveCount(1);

  // criterion 3: c opens the creation sheet, and a field keeps everything typed
  await page.keyboard.press("c");
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  const title = sheet.getByLabel("Task title");
  await expect(title).toBeFocused();
  await page.keyboard.type("xj?");
  await expect(title).toHaveValue("xj?");
  // the help sheet did not open, nothing completed, and the cursor stayed put
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(completedGroup(page).locator("li.task")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("? lists every shortcut by group and Esc closes the sheet", async ({ page }) => {
  const email = newEmail("keys-help");
  await seedWalkableTasks(page, email);
  await focusPage(page);

  // criterion 4
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  for (const group of ["Move", "Act on the focused row", "Create", "Go", "Anywhere"]) {
    await expect(help.getByRole("heading", { name: group })).toBeVisible();
  }
  for (const label of [
    "Next row",
    "Previous row",
    "Open details",
    "Complete the task",
    "Move to the next day",
    "New task",
    "New block",
    "Today",
    "Tasks",
    "Calendar",
    "Now mode",
    "Command palette",
    "This sheet",
    "Close what is open",
  ]) {
    await expect(help.getByText(label, { exact: true })).toBeVisible();
  }
  // the sequence's two keys are printed as two chips
  const sequenceRow = help.locator("li", { hasText: "Tasks" }).last();
  await expect(sequenceRow.locator("kbd")).toHaveText(["g", "t"]);

  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("with the switch off the single-key shortcuts stop and navigation stays", async ({ page }) => {
  const email = newEmail("keys-off");
  await seedWalkableTasks(page, email);

  // criterion 6: the Day settings switch is the mechanism, and it is the one
  // that writes the profile
  await page.getByRole("button", { name: "Day settings" }).click();
  const settings = page.getByRole("complementary", { name: "Day settings" });
  await expect(settings).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Keyboard shortcuts" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await readRemoteDaySettings(email)).shortcutsEnabled, poll).toBe(false);
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);

  await focusPage(page);
  // the letters do nothing at all now: no row takes focus, no task completes
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect(rowOf(page, "Alpha invoice")).not.toBeFocused();
  await expect(completedGroup(page).locator("li.task")).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);

  // navigation keys and sequences were never single-character shortcuts, so
  // the switch stays a switch rather than a cliff
  await page.keyboard.press("ArrowDown");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByRole("heading", { name: "Today", level: 2 })).toBeVisible();

  // and turning it back on restores the letters
  await page.getByRole("button", { name: "Day settings" }).click();
  await page.getByRole("switch", { name: "Keyboard shortcuts" }).click();
  await expect.poll(async () => (await readRemoteDaySettings(email)).shortcutsEnabled, poll).toBe(true);
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(settings).toHaveCount(0);
  await openView(page, "Tasks");
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(rowOf(page, "Alpha invoice")).toBeFocused();
});

test("t moves the focused block a calendar day and undo puts it back", async ({ page }) => {
  const email = newEmail("keys-block");
  await signUp(page, email);
  const today = utcDay(0);
  await seedTaskAndBlock(email, "Plan the sprint", `${today}T10:00:00+00:00`, `${today}T11:00:00+00:00`);
  await openView(page, "Calendar");

  const block = page.locator(`[data-date="${today}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  // the block is the cursor's first row on this surface: j focuses it
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(block).toBeFocused();

  // criterion 7: one calendar day, same hour, in the profile zone
  await page.keyboard.press("t");
  await expect
    .poll(async () => (await readRemoteBlocks(email)).map(entry => entry.start), poll)
    .toEqual([`${utcDay(1)}T10:00:00+00:00`]);
  expect((await readRemoteBlocks(email))[0].end).toBe(`${utcDay(1)}T11:00:00+00:00`);
  const toast = page.locator(".undo-toast");
  await expect(toast).toContainText("Block moved to tomorrow");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await readRemoteBlocks(email)).map(entry => entry.start), poll).toEqual([
    `${today}T10:00:00+00:00`,
  ]);
});

test("t keeps a block's hour across the spring DST change", async ({ page }) => {
  // Madrid springs forward on 2026-03-29: 24 hours after 09:00 on the 28th is
  // 10:00 on the 29th, so a block that kept its hour is the only right answer.
  await page.clock.install({ time: new Date("2026-03-28T12:00:00Z") });
  const email = newEmail("keys-dst");
  // The account and its block are seeded over REST before the browser signs in:
  // a sign-up would create the account the seed needs to find.
  await seedProfileAndBlock(email, "Europe/Madrid", "2026-03-28T09:00:00+01:00", "2026-03-28T10:00:00+01:00");
  await submitAuthForm(page, email, "sign in");
  await openView(page, "Calendar");

  const day = "2026-03-28";
  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await focusPage(page);
  await page.keyboard.press("j");
  await expect(block).toBeFocused();
  await page.keyboard.press("t");
  await expect
    .poll(async () => (await readRemoteBlocks(email)).map(entry => entry.start), poll)
    .toEqual(["2026-03-29T09:00:00+02:00"]);
  expect((await readRemoteBlocks(email))[0].end).toBe("2026-03-29T10:00:00+02:00");
});

test("g h, g t, g c and n reach every surface from the keyboard", async ({ page }) => {
  const email = newEmail("keys-go");
  await seedWalkableTasks(page, email);
  await focusPage(page);

  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByRole("heading", { name: "Today", level: 2 })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  await expect(page.getByRole("heading", { name: /Calendar/ , level: 2 })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.getByRole("heading", { name: "Tasks", level: 2 })).toBeVisible();

  // n opens Now mode, and while it is up it owns the keyboard: `g h` behind it
  // is not a navigation until it closes
  await page.keyboard.press("n");
  const now = page.getByRole("dialog", { name: /Now/ });
  await expect(now).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(now).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(now).toHaveCount(0);
});

test.describe("a phone without a keyboard", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("sees nothing new, and its rows still answer a tap", async ({ page }) => {
    const email = newEmail("keys-phone");
    await seedWalkableTasks(page, email);

    // criterion 8: no help entry, no hint, no sheet — nothing was added to look at
    await expect(page.getByText("Keyboard shortcuts")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /shortcuts/i })).toHaveCount(0);
    await expect(page.locator("[data-shortcut-hint]")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // and the row cursor did not get in the way of a thumb
    await page.getByRole("checkbox", { name: "Complete: Alpha invoice" }).tap();
    await expect(completedGroup(page).locator("li.task", { hasText: "Alpha invoice" })).toHaveCount(1);
  });
});

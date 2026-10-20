import { expect, test, type Page } from "@playwright/test";
import { readRemoteSeries, readRemoteTasks, seedProfile, submitAuthForm } from "./browser-helpers.ts";

/**
 * Natural-language quick add (value roadmap §2.2, roadmap step 3), end to end.
 *
 * The parser has its own unit table (`src/domain/quickAdd.test.ts`); these tests
 * cover what only a browser can prove: the chips a typed line produces, undoing
 * one keeps its text in the title, a manual change to the Deadline or Repeat
 * control outranks the parse, the palette creates the same structured task, and
 * the whole path works from the keyboard on a phone.
 *
 * The profile time zone is seeded, so "tomorrow" means the planner's tomorrow
 * here whatever zone the emulator host believes it is in.
 */

test.setTimeout(90_000);

const zone = "America/Argentina/Buenos_Aires";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A wall-clock day key in `timeZone`, independent of the browser's own zone. */
function dayKeyIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => Number(parts.find(entry => entry.type === type)!.value);
  return `${part("year")}-${pad(part("month"))}-${pad(part("day"))}`;
}

function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The day key of the next occurrence of `weekday` (0 = Sunday), today included. */
function nextWeekday(key: string, weekday: number): string {
  const delta = (weekday - new Date(`${key}T00:00:00Z`).getUTCDay() + 7) % 7;
  return addDays(key, delta);
}

/**
 * The words the app prints for a day key (`ui/format.ts` with the suite's pinned
 * en-US locale). Written out here instead of imported, so a change to the
 * formatter shows up as a failing test rather than a silently matching helper.
 */
function dateLabel(key: string, today: string): string {
  const days = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(`${key}T00:00:00Z`),
  );
}

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

async function expectRemoteTasks(email: string, expected: unknown[]) {
  await expect.poll(() => readRemoteTasks(email), poll).toEqual(expected);
}

async function expectRemoteSeries(email: string, expected: unknown[]) {
  await expect.poll(async () => (await readRemoteSeries(email)).map(doc => doc.data), poll).toEqual(expected);
}

/** Signs a fresh account in with the profile zone already seeded. */
async function signUpWithZone(page: Page, prefix: string, timeZone = zone): Promise<string> {
  const email = newEmail(prefix);
  await seedProfile(email, timeZone);
  await submitAuthForm(page, email, "sign in");
  return email;
}

/** Opens the New task sheet without touching the mouse. */
async function openTaskSheet(page: Page) {
  await page.getByRole("button", { name: "New task" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Task title")).toBeVisible();
}

/** The chip row under the title field. */
const chips = (page: Page) => page.getByRole("list", { name: "Recognized from the text" }).getByRole("button");

/** Submits the New task sheet from the title field, with no pointer involved. */
async function submitFromTitle(page: Page) {
  await page.getByLabel("Task title").focus();
  await page.keyboard.press("Enter");
}

/** Lands on Tasks with the keyboard, where a created row is listed. */
async function openTasksByKeyboard(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Tasks/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
}

test("typing a date in the title creates the task with that deadline", async ({ page }) => {
  const email = await signUpWithZone(page, "quick-date");
  await openTaskSheet(page);

  const today = dayKeyIn(zone, new Date());
  const friday = nextWeekday(today, 5);

  await page.getByLabel("Task title").focus();
  await page.keyboard.type("call mom fri");

  // The chip previews exactly what will be stored, in the planner's own words.
  await expect(chips(page)).toHaveText([dateLabel(friday, today)]);
  await expect(page.getByLabel("Deadline")).toHaveValue(friday);

  await submitFromTitle(page);
  await openTasksByKeyboard(page);
  await expect(page.locator(".task-title", { hasText: "call mom" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "call mom", completed: false, deadline: friday }]);
});

test("a time of day stays in the title, because the task has no time field", async ({ page }) => {
  const email = await signUpWithZone(page, "quick-time");
  await openTaskSheet(page);

  const today = dayKeyIn(zone, new Date());
  const friday = nextWeekday(today, 5);

  await page.getByLabel("Task title").focus();
  await page.keyboard.type("call mom fri 3pm");

  await expect(chips(page)).toHaveText([dateLabel(friday, today)]);
  await submitFromTitle(page);
  await openTasksByKeyboard(page);

  // The deadline is structured; the time the planner cannot hold is not thrown away.
  await expect(page.locator(".task-title", { hasText: "call mom 3pm" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "call mom 3pm", completed: false, deadline: friday }]);
});

test("undoing a chip keeps its text in the title, from the keyboard", async ({ page }) => {
  const email = await signUpWithZone(page, "quick-undo");
  await openTaskSheet(page);

  const today = dayKeyIn(zone, new Date());
  await page.getByLabel("Task title").focus();
  await page.keyboard.type("pay rent tomorrow");
  await expect(chips(page)).toHaveText([dateLabel(addDays(today, 1), today)]);

  // Tab from the field lands on the chip; Enter undoes it.
  await page.keyboard.press("Tab");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByLabel("Deadline")).toHaveValue("");
  // Shift+Tab puts the caret back in the title, where Enter submits.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("Task title")).toBeFocused();
  await page.keyboard.press("Enter");

  await openTasksByKeyboard(page);
  await expect(page.locator(".task-title", { hasText: "pay rent tomorrow" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "pay rent tomorrow", completed: false }]);
});

test("a deadline the user picks outranks the parsed one", async ({ page }) => {
  const email = await signUpWithZone(page, "quick-manual");
  await openTaskSheet(page);

  const today = dayKeyIn(zone, new Date());
  await page.getByLabel("Task title").focus();
  await page.keyboard.type("pay rent tomorrow");
  await expect(chips(page)).toHaveText([dateLabel(addDays(today, 1), today)]);

  const chosen = addDays(today, 10);
  await page.getByLabel("Deadline").fill(chosen);

  // The chip would be lying about the stored value, so it is gone; the text it
  // matched is still consumed, which is what the user's own choice means.
  await expect(chips(page)).toHaveCount(0);
  await submitFromTitle(page);

  await openTasksByKeyboard(page);
  await expect(page.locator(".task-title", { hasText: "pay rent" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "pay rent", completed: false, deadline: chosen }]);
});

test("the palette creates the same structured task from one line", async ({ page }) => {
  const email = await signUpWithZone(page, "quick-palette");
  const today = dayKeyIn(zone, new Date());
  const deadline = addDays(today, 2);

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("review PR in 2 days");

  // The create row names the clean title and previews the deadline it parsed.
  const create = dialog.getByRole("option").first();
  await expect(create).toContainText("review PR");
  await expect(create).toContainText(dateLabel(deadline, today));
  await page.keyboard.press("Enter");

  await expect(dialog).toHaveCount(0);
  await openTasksByKeyboard(page);
  await expect(page.locator(".task-title", { hasText: "review PR" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "review PR", completed: false, deadline }]);

  // The same line with a repeat creates the series, from the same row.
  const monday = nextWeekday(today, 1);
  await page.keyboard.press("Control+k");
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("gym every mon");
  await expect(dialog.getByRole("option").first()).toContainText("Weekly");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expectRemoteSeries(email, [{ title: "gym", frequency: "weekly", anchorDate: monday }]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("a repeat line creates the series, keyboard only, in the narrow sheet", async ({ page }) => {
    const email = await signUpWithZone(page, "quick-phone");
    await page.getByRole("button", { name: "New task" }).first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Task title")).toBeVisible();

    const today = dayKeyIn(zone, new Date());
    const monday = nextWeekday(today, 1);
    await page.getByLabel("Task title").focus();
    await page.keyboard.type("gym every mon");

    await expect(chips(page)).toHaveText(["Weekly"]);
    // The start date the series will be anchored to follows the weekday named.
    await expect(page.getByLabel("Start date")).toHaveValue(monday);
    const chip = await chips(page).first().boundingBox();
    expect(chip).not.toBeNull();
    expect(chip!.x + chip!.width).toBeLessThanOrEqual(390);

    await submitFromTitle(page);
    await openTasksByKeyboard(page);
    await expect(page.getByText("gym", { exact: true })).toBeVisible();
    await expectRemoteSeries(email, [{ title: "gym", frequency: "weekly", anchorDate: monday }]);
  });
});

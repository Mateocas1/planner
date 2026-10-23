import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  readRemoteTasks,
  seedSidebarFixture,
  seedTrackedTasks,
  storedFocusSession,
  submitAuthForm,
} from "./browser-helpers.ts";

/**
 * Estimate vs actual (F2b).
 *
 * Three behaviours are asserted end to end here, against the real emulators:
 *
 * - a finished focus session adds its whole minutes to the task it was spent
 *   on, and a glance at the timer (under five minutes) adds nothing;
 * - the estimate lesson is a *suggestion*: it appears only once the history can
 *   support it, it says the number out loud, and the stored estimate changes
 *   only when the user taps it;
 * - a completed task says what it really took, and the recorded count survives
 *   the closed task schema through delete and undo.
 *
 * The focus session is seeded as a stored one (see `storedFocusSession`), which
 * is what a desktop restores on load: the timer recomputes every number from
 * those instants, so "this session began twenty minutes ago" is a statement
 * about two instants instead of a wait. The twenty-minute session is the one
 * whose credit sits on a whole-minute boundary, so it also holds the page's
 * clock still (see `sessionAt`): the two instants and the stop are one read.
 */

test.setTimeout(120_000);

/* A desktop-tall window: the focus timer is a sidebar surface (FocusWidget). */
test.use({ viewport: { width: 1440, height: 900 } });

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
const FOCUS_KEY = "planner-focus";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signIn(page: Page, email: string) {
  /* The Auth emulator can reject a token minted a moment after the account was
     created (see submitAuthForm): a retry budget, not a tolerance. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
}

/**
 * A stored session whose instants are read off `now`, the same instant the page
 * clock is then held at (`page.clock.setFixedTime`), so the stop reports exactly
 * `startedMinutesAgo` of focused time.
 *
 * `storedFocusSession` states them from the *test's* clock instead, which is a
 * different read of the host's wall clock, taken one to two seconds before the
 * stop. This host's clock steps back up to ~1.3 s every 15-30 s
 * (odd/runs/hf-flaky.md, the Auth artifact), so a step inside that window can
 * leave 19:59.9 between the two reads and `Math.floor` the credit to 19. The
 * product is right to trust the clock it is handed -- it computes
 * `now - startedAt - pausedMs` and nothing else -- so the fixture is what has to
 * stop asking two clocks what "now" is.
 */
function sessionAt(
  now: number,
  input: { blockId: string; taskId?: string; startedMinutesAgo: number; endsInMinutes: number },
): string {
  return JSON.stringify({
    blockId: input.blockId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    endAt: now + input.endsInMinutes * 60_000,
    startedAt: now - input.startedMinutesAgo * 60_000,
    pausedMs: 0,
  });
}

/** Puts a stored focus session in the tab before the app loads. */
async function seedFocusSession(page: Page, session: string) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: FOCUS_KEY, value: session },
  );
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Waits out a creation sheet that was just submitted (see estimate.spec.ts). */
async function settleSheet(page: Page, label: string) {
  const sheet = page.getByRole("complementary", { name: label });
  if ((await sheet.count()) === 0) return;
  const submitting = await sheet.getByRole("button", { name: /^Add (task|block)$/ }).isDisabled().catch(() => false);
  if (submitting) {
    await expect(sheet).toHaveCount(0);
    return;
  }
  const state = await sheet.getAttribute("data-state").catch(() => null);
  if (state !== "open") await expect(sheet).toHaveCount(0);
}

async function revealTaskForm(page: Page) {
  await settleSheet(page, "New task");
  const add = page.getByRole("button", { name: "Add task" });
  if (await add.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "New task" }).click();
  await expect(add).toBeVisible();
}

/**
 * Presses a row once it has stopped moving. A press is dispatched to whatever
 * is under the pointer at release, and the Tasks list is still landing right
 * after the view changes (the page's entrance plus the list's own settle), so
 * a press inside that beat is dispatched to where the row used to be: its
 * handler never runs and the panel never opens (traced: no view transition
 * starts at all, and the row's box reads differently in two runs). Two reads a
 * poll apart must name the same box before the press.
 */
async function pressAtRest(page: Page, row: Locator): Promise<void> {
  let previous = await row.boundingBox();
  await expect
    .poll(async () => {
      const current = await row.boundingBox();
      const still = previous !== null && current !== null && Math.abs(current.y - previous.y) < 0.5 && Math.abs(current.x - previous.x) < 0.5;
      previous = current;
      return still;
    }, { timeout: 10_000 })
    .toBe(true);
  await row.click();
}

const timer = (page: Page) => page.getByRole("group", { name: "Focus timer" });
const details = (page: Page) => page.getByRole("complementary", { name: "Task details" });

test("a 20-minute focus session adds 20 minutes to its task, and Task details shows what it took", async ({ page }) => {
  const email = newEmail("actual-twenty");
  const { taskIds } = await seedSidebarFixture(email, "UTC", { tasks: [{ title: "Write the brief" }] });
  /* Twenty minutes before the instant the page reads as now, held there: the
     Stop click reports exactly 20:00.000 whatever the host clock does meanwhile. */
  const now = Date.now();
  await page.clock.setFixedTime(now);
  await seedFocusSession(page, sessionAt(now, {
    blockId: "seeded-block",
    taskId: taskIds["Write the brief"],
    startedMinutesAgo: 20,
    endsInMinutes: 10,
  }));
  await signIn(page, email);

  /* The restored session is the timer: stopping it is what reports the minutes. */
  await expect(timer(page)).toBeVisible();
  await expect(timer(page).getByText("Write the brief")).toBeVisible();
  await timer(page).getByRole("button", { name: "Stop" }).click();
  await expect(timer(page)).toHaveCount(0);

  /* Whole minutes, added to the task's own counter: no read, no overwrite —
     and, in the same write, to the session's start day in the planner's zone
     (UTC here) for the weekly review's plan-vs-actual (W2c, ronda2 L6). */
  const startDay = new Date(now - 20 * 60_000).toISOString().slice(0, 10);
  await expect.poll(() => readRemoteTasks(email), poll).toEqual([
    { title: "Write the brief", completed: false, actualMinutes: 20, actualByDay: { [startDay]: 20 } },
  ]);

  await openTasks(page);
  await pressAtRest(page, page.getByRole("button", { name: "Write the brief" }));
  await expect(details(page)).toBeVisible();
  // An open task says what has been tracked so far, never a finished total.
  await expect(details(page).getByText("Tracked 20 min so far")).toBeVisible();

  /* Completing it turns the same number into the record of what it took, next
     to the estimate it was planned with (criterion 5's copy). */
  await details(page).getByRole("switch", { name: "Completed" }).click();
  await expect(details(page).getByText("Assumed 1h · took 20 min")).toBeVisible();
});

test("a session under five minutes is a glance, not work, and records nothing", async ({ page }) => {
  const email = newEmail("actual-short");
  const { taskIds } = await seedSidebarFixture(email, "UTC", { tasks: [{ title: "Quick check" }] });
  await seedFocusSession(page, storedFocusSession({
    blockId: "seeded-block",
    taskId: taskIds["Quick check"],
    startedMinutesAgo: 4,
    endsInMinutes: 30,
  }));
  await signIn(page, email);

  await timer(page).getByRole("button", { name: "Stop" }).click();
  await expect(timer(page)).toHaveCount(0);

  /* The local cache reflects a queued write immediately, so the displayed
     absence is evidence: nothing was recorded for four minutes. */
  await openTasks(page);
  await page.getByRole("button", { name: "Quick check" }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByText(/took|Tracked/)).toHaveCount(0);
  expect(await readRemoteTasks(email)).toEqual([{ title: "Quick check", completed: false }]);

  /* With no tracked history at all, the sheet says how the lesson is learned
     instead of inventing one (criterion 2's exact copy). */
  await details(page).getByRole("button", { name: "Close" }).click();
  await expect(details(page)).toHaveCount(0);
  await revealTaskForm(page);
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet.getByText("Track a few tasks with the timer to learn your pace.")).toBeVisible();
});

test("three tracked invoices are enough to offer 45 minutes, and the estimate changes only on the tap", async ({ page }) => {
  const email = newEmail("actual-suggestion");
  await seedTrackedTasks(email, "UTC", [
    { title: "Send invoice", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice", estimate: 30, actualMinutes: 45, completed: true },
  ]);
  await signIn(page, email);
  await openTasks(page);
  await revealTaskForm(page);

  const sheet = page.getByRole("complementary", { name: "New task" });
  await page.getByLabel("Task title").fill("Send invoice");
  await sheet.getByLabel("Estimate", { exact: true }).fill("30");

  /* The offer is a sentence, not a silent rewrite: the field still says 30. */
  await expect(sheet.getByText("Usually takes 45 min for tasks like this.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Use 45" })).toBeVisible();
  await expect(sheet.getByLabel("Estimate", { exact: true })).toHaveValue("30");

  await sheet.getByRole("button", { name: "Use 45" }).click();
  await expect(sheet.getByLabel("Estimate", { exact: true })).toHaveValue("45");
  await expect(sheet.getByText("45 min")).toBeVisible();
  // The offer applies once: it does not chase its own answer up the scale.
  await expect(sheet.getByRole("button", { name: /^Use / })).toHaveCount(0);

  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Send invoice" })).toHaveCount(4);
  await settleSheet(page, "New task");
  /* Four documents: the three samples untouched, plus the accepted estimate. */
  expect(
    (await readRemoteTasks(email)).filter(task => task.estimate === 45 && task.completed === false),
  ).toEqual([{ title: "Send invoice", completed: false, estimate: 45 }]);
});

test("two samples are not enough: no suggestion, only the pace hint", async ({ page }) => {
  const email = newEmail("actual-threshold");
  await seedTrackedTasks(email, "UTC", [
    { title: "Send invoice", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice", estimate: 30, actualMinutes: 45, completed: true },
  ]);
  await signIn(page, email);
  await openTasks(page);
  await revealTaskForm(page);

  const sheet = page.getByRole("complementary", { name: "New task" });
  await page.getByLabel("Task title").fill("Send invoice");
  await sheet.getByLabel("Estimate", { exact: true }).fill("30");
  await expect(sheet.getByText("Track a few tasks with the timer to learn your pace.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Use / })).toHaveCount(0);
  await expect(sheet.getByLabel("Estimate", { exact: true })).toHaveValue("30");
});

test("undo puts the recorded minutes back exactly", async ({ page }) => {
  const email = newEmail("actual-undo");
  await seedTrackedTasks(email, "UTC", [
    { title: "Renew the passport", estimate: 60, actualMinutes: 45, completed: true },
  ]);
  await signIn(page, email);
  await openTasks(page);

  const before = (await readRemoteTasks(email))[0];
  expect(before).toEqual({ title: "Renew the passport", completed: true, estimate: 60, actualMinutes: 45 });

  await page.getByRole("button", { name: "Renew the passport" }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByText("Estimated 1h · took 45 min")).toBeVisible();
  await details(page).getByRole("button", { name: "Delete task" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Task deleted" })).toBeVisible();
  await expect.poll(() => readRemoteTasks(email), poll).toEqual([]);

  /* The closed task schema carries every field, the tracked minutes included. */
  await page.getByRole("status").filter({ hasText: "Task deleted" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => readRemoteTasks(email), poll).toEqual([before]);
});

test("Task details offers the same learned pace as the creation sheet", async ({ page }) => {
  const email = newEmail("actual-details-offer");
  await seedTrackedTasks(email, "UTC", [
    { title: "Send invoice now", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice later", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice again", estimate: 30, actualMinutes: 45, completed: true },
    { title: "Send invoice draft", estimate: 30 },
  ]);
  await signIn(page, email);
  await openTasks(page);

  /* The details sheet reads the store's own sample list, so a task with a
     recorded history is offered the learned pace there too -- never only in
     the creation sheet, where the history is not yet the user's problem. */
  await page.getByRole("button", { name: "Send invoice draft" }).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByText("Usually takes 45 min for tasks like this.")).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Use 45" })).toBeVisible();

  /* Still an offer: the stored document keeps the estimate its owner wrote
     until the tap, and then carries the accepted one. */
  expect((await readRemoteTasks(email)).find(task => task.title === "Send invoice draft")).toEqual({
    title: "Send invoice draft",
    completed: false,
    estimate: 30,
  });
  await details(page).getByRole("button", { name: "Use 45" }).click();
  await expect.poll(
    async () => (await readRemoteTasks(email)).find(task => task.title === "Send invoice draft"),
    poll,
  ).toEqual({ title: "Send invoice draft", completed: false, estimate: 45 });
});

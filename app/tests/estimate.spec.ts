import { expect, test, type Page } from "@playwright/test";
import { readRemoteSeries, readRemoteTasks, submitAuthForm, chooseOption, pickDate } from "./browser-helpers.ts";

/**
 * Estimates and completion instants (E1).
 *
 * The two new task fields are optional and live in a closed document schema:
 * a task written before them must still read, a restored task must be the
 * document that was deleted, and a field nobody set must stay absent rather
 * than be written as zero. These tests drive the real UI and then read the
 * stored documents, which is where a dropped field would hide.
 */

test.setTimeout(60_000);

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Waits out a creation sheet that was just submitted (same rule as the flow
 * suite: the submitted panel plays its exit before it leaves the DOM). */
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

async function expectRemoteTasks(email: string, expected: unknown[]) {
  await expect.poll(() => readRemoteTasks(email), poll).toEqual(expected);
}

test("an estimate set in the New task sheet is stored and shown in Task details", async ({ page }) => {
  const email = newEmail("estimate-task");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Write the proposal");
  const createSheet = page.getByRole("complementary", { name: "New task" });
  // An empty estimate field states the assumption it stands for, rather than
  // leaving the user to guess what planning will use.
  await expect(createSheet.getByText("Assumed 1h")).toBeVisible();
  await createSheet.getByLabel("Estimate", { exact: true }).fill("45");
  await expect(createSheet.getByText("45 min")).toBeVisible();
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Write the proposal" })).toBeVisible();
  await settleSheet(page, "New task");

  await expectRemoteTasks(email, [{ title: "Write the proposal", completed: false, estimate: 45 }]);

  const panel = page.getByRole("complementary", { name: "Task details" });
  await page.getByRole("button", { name: "Write the proposal" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Estimate", { exact: true })).toHaveValue("45");
  await expect(panel.getByText("45 min")).toBeVisible();

  // Clearing it removes the field from the document and returns the sheet to
  // the assumption, instead of storing a zero that planning would read as real.
  await panel.getByLabel("Estimate", { exact: true }).fill("");
  await panel.getByLabel("Estimate", { exact: true }).blur();
  await expect(panel.getByText("Assumed 1h")).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Write the proposal", completed: false }]);
});

test("a task with no estimate says Assumed 1h where an estimate is shown", async ({ page }) => {
  const email = newEmail("estimate-assumed");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Call the bank");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Call the bank" })).toBeVisible();
  await settleSheet(page, "New task");

  // nothing was written for a value nobody set
  await expectRemoteTasks(email, [{ title: "Call the bank", completed: false }]);

  const panel = page.getByRole("complementary", { name: "Task details" });
  await page.getByRole("button", { name: "Call the bank" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Estimate", { exact: true })).toHaveValue("");
  await expect(panel.getByText("Assumed 1h")).toBeVisible();
});

test("completing a task records the instant, and reopening clears it", async ({ page }) => {
  const email = newEmail("estimate-completed");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Pay the bill");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Pay the bill" })).toBeVisible();
  await settleSheet(page, "New task");

  await page.getByRole("checkbox", { name: "Complete: Pay the bill" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Pay the bill" })).toHaveCount(1);
  // a zoned ISO instant, which is what the rest of the product compares against
  await expect
    .poll(async () => (await readRemoteTasks(email))[0]?.completedAt, poll)
    .toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/));

  await page.getByRole("checkbox", { name: "Reopen: Pay the bill" }).click();
  await expect(page.getByRole("checkbox", { name: "Complete: Pay the bill" })).toBeVisible();
  // un-completing removes the field: an open task carries no completion instant
  await expectRemoteTasks(email, [{ title: "Pay the bill", completed: false }]);
});

test("undo restores the estimate and the completion instant exactly", async ({ page }) => {
  const email = newEmail("estimate-undo");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Renew the passport");
  await page.getByRole("complementary", { name: "New task" }).getByLabel("Estimate", { exact: true }).fill("90");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Renew the passport" })).toBeVisible();
  await settleSheet(page, "New task");

  await page.getByRole("checkbox", { name: "Complete: Renew the passport" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Renew the passport" })).toHaveCount(1);
  await expect
    .poll(async () => (await readRemoteTasks(email))[0]?.completedAt, poll)
    .toEqual(expect.any(String));
  const before = (await readRemoteTasks(email))[0];

  const panel = page.getByRole("complementary", { name: "Task details" });
  await page.getByRole("button", { name: "Renew the passport" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Delete task" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Task deleted" })).toBeVisible();
  await expectRemoteTasks(email, []);

  await page.getByRole("status").filter({ hasText: "Task deleted" }).getByRole("button", { name: "Undo" }).click();
  // the restored document carries both fields, with the completion instant
  // byte for byte the one it held before the delete
  await expect.poll(() => readRemoteTasks(email), poll).toEqual([before]);
  expect(before).toEqual({
    title: "Renew the passport",
    completed: true,
    estimate: 90,
    completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/),
  });
});

test("a repeating task keeps its estimate through the series sheet and undo", async ({ page }) => {
  const email = newEmail("estimate-series");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Stretch");
  await chooseOption(page, "Repeat", "Daily");
  await pickDate(page, "Start date", new Date().toISOString().slice(0, 10));
  await page.getByRole("complementary", { name: "New task" }).getByLabel("Estimate", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".series-row", { hasText: "Stretch" })).toBeVisible();
  await settleSheet(page, "New task");

  const stored = async () => (await readRemoteSeries(email))[0]?.data;
  await expect.poll(async () => (await stored())?.estimate, poll).toEqual(30);

  const panel = page.getByRole("complementary", { name: "Series details" });
  await page.getByRole("button", { name: "Stretch" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Estimate", { exact: true })).toHaveValue("30");
  await expect(panel.getByText("30 min")).toBeVisible();

  // the closed series schema, through delete and undo: the definition comes back
  // with its estimate rather than as a copy without one
  const before = await stored();
  await panel.getByRole("button", { name: "Delete series" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Series deleted" })).toBeVisible();
  await expect.poll(async () => (await readRemoteSeries(email)).length, poll).toEqual(0);
  await page.getByRole("status").filter({ hasText: "Series deleted" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await stored())?.estimate, poll).toEqual(30);
  expect(await stored()).toEqual(before);
});

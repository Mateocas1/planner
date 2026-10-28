import { expect, test, type Page } from "@playwright/test";
import { readRemoteBlocks, readRemoteCompletions, readRemoteSeries, readRemoteTasks, submitAuthForm, type RemoteData, chooseOption } from "./browser-helpers.ts";

/**
 * Undo for delete (F1 / spec S6).
 *
 * The delete is applied as soon as it is accepted, so the offer is a
 * compensating write: undo rewrites the item under its original document id
 * with the exact fields it held. Every test below drives the real UI and checks
 * the consequences a user can observe: the row, the toast, and the stored
 * document.
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

/** Waits out a creation sheet that was just submitted, exactly as the flow
 * suite does, so the next interaction never lands on a closing form. */
async function settleSheet(page: Page, label: string) {
  const sheet = page.getByRole("complementary", { name: label });
  if ((await sheet.count()) === 0) return;
  // Read the form's control first. A submit's continuation re-enables the form
  // and starts the panel's exit in the same commit, so an enabled control means
  // that commit has already happened and the panel is leaving. Sampling
  // data-state first and the control second let the two reads straddle that
  // commit: a leaving panel read as open, and the next fill landed on a form
  // that unmounted under it.
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

async function addTaskThroughForm(page: Page, title: string, deadline?: string) {
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill(title);
  if (deadline) await page.getByLabel("Deadline").fill(deadline);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  // The submitted sheet plays its 180 ms exit before it leaves the DOM, and it
  // is still an accessible "New task" panel carrying a "Task title" field
  // until then. Wait for it to be really gone: a label lookup made in that
  // window (`getByLabel("Task")` in the block form, a check clicked after a
  // create) reads a closing form instead of the one on screen.
  await settleSheet(page, "New task");
}

async function openCalendar(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
}

async function revealBlockForm(page: Page) {
  await settleSheet(page, "New block");
  const add = page.getByRole("button", { name: "Add block" });
  if (await add.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "New block" }).click();
  await expect(add).toBeVisible();
}

/** Local YYYY-MM-DD key, matching the grid's browser-local timezone. */
function localDateKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayKey(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return localDateKey(date);
}

async function expectRemoteTasks(email: string, expected: unknown[]) {
  await expect.poll(() => readRemoteTasks(email), poll).toEqual(expected);
}

async function expectRemoteBlocks(email: string, expected: unknown[]) {
  await expect.poll(() => readRemoteBlocks(email), poll).toEqual(expected);
}

async function expectRemoteSeries(email: string, expected: unknown[]) {
  await expect.poll(() => readRemoteSeries(email), poll).toEqual(expected);
}

/** Polls the forced-server read until one block exists, then returns it. */
async function expectSingleRemoteBlock(email: string) {
  let remote: Array<{ start: string; end: string; taskId?: string }> = [];
  await expect
    .poll(async () => {
      remote = await readRemoteBlocks(email);
      return remote.length;
    }, poll)
    .toBe(1);
  return remote[0]!;
}

/** Polls the forced-server read until one series exists, then returns it. */
async function expectSingleRemoteSeries(email: string) {
  let remote: Array<{ id: string; data: RemoteData }> = [];
  await expect
    .poll(async () => {
      remote = await readRemoteSeries(email);
      return remote.length;
    }, poll)
    .toBe(1);
  return remote[0]!;
}

const undoToast = (page: Page) => page.locator(".undo-toast");

/** The offer reads as one sentence: "<what was deleted> · Undo". */
async function expectToastSentence(page: Page, message: string) {
  const toast = undoToast(page);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("role", "status");
  const sentence = (await toast.innerText()).replace(/\s+/g, " ").trim();
  expect(sentence).toMatch(new RegExp(`^${message}\\s*·\\s*Undo$`));
}

test("deleting a task offers undo, and undo restores that task with its completion and deadline", async ({ page }) => {
  const email = newEmail("undo-task");
  await signUp(page, email);
  await openTasks(page);

  const deadline = dayKey(3);
  await addTaskThroughForm(page, "Pack bags", deadline);
  await page.getByRole("checkbox", { name: "Complete: Pack bags" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Pack bags" })).toHaveCount(1);
  await expectRemoteTasks(email, [{ title: "Pack bags", completed: true, deadline, completedAt: expect.any(String) }]);

  await page.getByRole("button", { name: "Pack bags" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();

  // the offer appears and the row is gone
  await expectToastSentence(page, "Task deleted");
  await expect(page.locator(".task-title", { hasText: "Pack bags" })).toHaveCount(0);
  // the delete is really applied: the toast is a compensating write, not a
  // deferral, so the server is already without the document
  await expectRemoteTasks(email, []);

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);

  // same title, same completion, same deadline — in the completed group
  await expect(page.locator("li.task.completed", { hasText: "Pack bags" })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Reopen: Pack bags" })).toBeChecked();
  await expectRemoteTasks(email, [{ title: "Pack bags", completed: true, deadline, completedAt: expect.any(String) }]);

  // it is stored state, not a lingering local echo
  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await openTasks(page);
  await expect(page.locator("li.task.completed", { hasText: "Pack bags" })).toHaveCount(1);
});

test("deleting a task deletes its work blocks, and undo restores both (S8)", async ({ page }) => {
  const email = newEmail("undo-task-blocks");
  await signUp(page, email);
  await openTasks(page);

  const deadline = dayKey(3);
  await addTaskThroughForm(page, "Paint fence", deadline);
  // One work block linked to the task, today — the calendar's own week, so
  // the block is on screen across the reload too.
  await openCalendar(page);
  await revealBlockForm(page);
  // Scope to the sheet: other surfaces (focus, settings) carry Start/End labels too.
  const blockForm = page.getByRole("complementary", { name: "New block" });
  const blockDay = dayKey(0);
  await blockForm.getByLabel("Start").fill(`${blockDay}T14:00`);
  await blockForm.getByLabel("End").fill(`${blockDay}T15:30`);
  await chooseOption(blockForm, "Task", "Paint fence");
  await page.getByRole("button", { name: "Add block" }).click();
  await settleSheet(page, "New block");
  const slot = page.locator(`[data-date="${blockDay}"] .calendar-block`).filter({ hasText: "Paint fence" });
  await expect(slot).toHaveCount(1);
  await expect.poll(async () => (await readRemoteBlocks(email)).filter(block => block.taskId !== undefined), poll).toHaveLength(1);

  // Deleting the task takes the block off the calendar with it — the old
  // orphan-block bug (S8).
  await openTasks(page);
  // The row button (not the calendar's "Focus: Paint fence" pill that the
  // block just created).
  await page.getByRole("button", { name: /Paint fence due/ }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");
  await expect(page.locator(".task-title", { hasText: "Paint fence" })).toHaveCount(0);
  await expectRemoteTasks(email, []);
  await expect.poll(() => readRemoteBlocks(email), poll).toEqual([]);
  await openCalendar(page);
  await expect(page.locator(`[data-date="${blockDay}"] .calendar-block`)).toHaveCount(0);

  // Undo restores the task AND the block, under the same link.
  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);
  await openTasks(page);
  await expect(page.locator(".task-title", { hasText: "Paint fence" })).toHaveCount(1);
  await expectRemoteTasks(email, [{ title: "Paint fence", completed: false, deadline }]);
  await expect.poll(async () => (await readRemoteBlocks(email)).filter(block => block.taskId !== undefined), poll).toHaveLength(1);
  await openCalendar(page);
  await expect(page.locator(`[data-date="${blockDay}"] .calendar-block`).filter({ hasText: "Paint fence" })).toHaveCount(1);

  // Stored state, not a local echo.
  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect.poll(async () => (await readRemoteBlocks(email)).filter(block => block.taskId !== undefined), poll).toHaveLength(1);
  await openCalendar(page);
  await expect(page.locator(`[data-date="${blockDay}"] .calendar-block`).filter({ hasText: "Paint fence" })).toHaveCount(1);
});

test("deleting a series offers undo, and undo restores the same id, schedule and completion history", async ({ page }) => {
  const email = newEmail("undo-series");
  await signUp(page, email);
  await openTasks(page);

  // a daily habit whose first occurrence is today, then completed: the record
  // is keyed "<seriesId>:<date>", so it only still matches a restored series
  // that kept its document id
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Stretch");
  await chooseOption(page, "Repeat", "Daily");
  await page.getByLabel("Start date").fill(dayKey(0));
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".series-row", { hasText: "Stretch" })).toBeVisible();

  const panel = page.getByRole("complementary", { name: "Series details" });
  await page.getByRole("button", { name: "Stretch" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("checkbox", { name: `Complete: Stretch on ${dayKey(0)}` }).click();
  await expect(panel.getByRole("checkbox", { name: `Completed: Stretch on ${dayKey(0)}` })).toBeChecked();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);

  const row = page.locator(".series-row", { hasText: "Stretch" });
  await expect(row).toHaveAttribute("data-next-occurrence", dayKey(1));
  const before = await expectSingleRemoteSeries(email);
  const completionsBefore = await readRemoteCompletions(email);

  await page.getByRole("button", { name: "Stretch" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Delete series" }).click();

  await expectToastSentence(page, "Series deleted");
  await expect(row).toHaveCount(0);
  await expectRemoteSeries(email, []);

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);

  // the restored row keeps its anchor and frequency, and today stays completed:
  // the next occurrence is tomorrow only because the completion record still
  // belongs to this series id
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-next-occurrence", dayKey(1));
  await expectRemoteSeries(email, [before]);
  expect(await readRemoteCompletions(email)).toEqual(completionsBefore);

  await page.getByRole("button", { name: "Stretch" }).click();
  await expect(panel.getByRole("checkbox", { name: `Completed: Stretch on ${dayKey(0)}` })).toBeChecked();
});

test("deleting a block offers undo, and undo restores it at the same instants and task link", async ({ page }) => {
  const email = newEmail("undo-block");
  await signUp(page, email);
  await openTasks(page);
  await addTaskThroughForm(page, "Deep work");
  await openCalendar(page);

  const day = localDateKey(new Date());
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${day}T11:00`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T12:00`);
  await chooseOption(page, "Task", "Deep work");
  await page.getByRole("button", { name: "Add block" }).click();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  const before = await expectSingleRemoteBlock(email);
  expect(before.taskId).toBeTruthy();

  await block.click();
  await page.getByRole("button", { name: "Delete block" }).click();

  await expectToastSentence(page, "Block deleted");
  await expect(block).toHaveCount(0);
  await expectRemoteBlocks(email, []);

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);

  // the same instants, and it is still for the same task
  await expect(block).toHaveCount(1);
  await expectRemoteBlocks(email, [before]);
  await block.click();
  await expect(page.getByRole("complementary", { name: "Block details" })).toContainText("Deep work");
});

test("a second delete replaces the toast, and undo then restores only the newest delete", async ({ page }) => {
  const email = newEmail("undo-replace");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "First");
  await addTaskThroughForm(page, "Second");

  await page.getByRole("button", { name: "First" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");
  // `data-offer` names the offer on screen. The first delete's is what is
  // showing right now; the second delete's replaces it once its write lands.
  const firstOffer = await undoToast(page).getAttribute("data-offer");
  if (firstOffer === null) throw new Error("the first delete left no offer on screen");

  // a sheet plays its return animation before it leaves the DOM, so the next
  // panel is only opened once the previous one is really gone
  await expect(page.getByRole("complementary", { name: "Task details" })).toHaveCount(0);
  await page.getByRole("button", { name: "Second" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  // The delete is offered once it is acknowledged, so the first delete's toast
  // is still the one on screen right here, with the same sentence. Take the
  // offer only after the newest one has replaced it: clicking too early undoes
  // "First" and then the real offer arrives behind it.
  await expect
    .poll(async () => {
      const offer = await undoToast(page).getAttribute("data-offer").catch(() => null);
      return offer !== null && offer !== firstOffer;
    })
    .toBe(true);
  // one offer, not two: the newest delete owns it, and it is not the one the
  // first delete left behind
  await expect(undoToast(page)).toHaveCount(1);
  await expect(undoToast(page)).not.toHaveAttribute("data-offer", firstOffer);
  await expectToastSentence(page, "Task deleted");

  await undoToast(page).getByRole("button", { name: "Undo" }).click();
  await expect(undoToast(page)).toHaveCount(0);

  await expect(page.locator(".task-title", { hasText: "Second" })).toHaveCount(1);
  await expect(page.locator(".task-title", { hasText: "First" })).toHaveCount(0);
  await expectRemoteTasks(email, [{ title: "Second", completed: false }]);
});

test("Escape and the close control both dismiss the offer, and the delete still stands", async ({ page }) => {
  const email = newEmail("undo-dismiss");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Dismissed");
  await page.getByRole("button", { name: "Dismissed" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");

  await page.keyboard.press("Escape");
  await expect(undoToast(page)).toHaveCount(0);
  await expect(page.locator(".task-title", { hasText: "Dismissed" })).toHaveCount(0);
  await expectRemoteTasks(email, []);
  await expect(page.getByRole("complementary", { name: "Task details" })).toHaveCount(0);

  await addTaskThroughForm(page, "Closed");
  await page.getByRole("button", { name: "Closed" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");

  await undoToast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(undoToast(page)).toHaveCount(0);
  await expectRemoteTasks(email, []);
});

test("the offer dismisses itself after about five seconds", async ({ page }) => {
  const email = newEmail("undo-timeout");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Short-lived offer");
  await page.getByRole("button", { name: "Short-lived offer" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");

  // still on screen well before the deadline, then gone on its own
  await page.waitForTimeout(1_000);
  await expect(undoToast(page)).toBeVisible();
  await expect(undoToast(page)).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator(".task-title", { hasText: "Short-lived offer" })).toHaveCount(0);
  await expectRemoteTasks(email, []);
});

test("the toast is a transition on opacity and translateY, keeps focus, and only fades under reduced motion", async ({ page }) => {
  const email = newEmail("undo-motion");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Motion task");
  await page.getByRole("button", { name: "Motion task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");

  const toast = undoToast(page);
  const undo = toast.getByRole("button", { name: "Undo" });
  // a real button, and the offer never takes focus
  expect(await undo.evaluate(element => element.tagName)).toBe("BUTTON");
  expect(await undo.evaluate(element => element === document.activeElement)).toBe(false);

  const motion = await toast.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      animation: style.animationName,
      properties: style.transitionProperty,
      durations: style.transitionDuration.split(",").map(value => (value.trim().endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value))),
    };
  });
  // a transition, never a keyframe animation: 200 ms in on opacity and the rise
  expect(motion.animation).toBe("none");
  expect(motion.properties).toContain("opacity");
  expect(motion.properties).toContain("transform");
  // the two identical durations are serialized once, so every entry is 200 ms
  expect(motion.durations.length).toBeGreaterThan(0);
  expect(motion.durations.every(duration => duration === 0.2)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(toast).toHaveCount(0);

  // with reduced motion the same offer still fades, and never rises
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addTaskThroughForm(page, "Still motion task");
  await page.getByRole("button", { name: "Still motion task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expectToastSentence(page, "Task deleted");

  const reduced = await undoToast(page).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      animation: style.animationName,
      properties: style.transitionProperty,
      durations: style.transitionDuration.split(",").map(value => (value.trim().endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value))),
      transform: style.transform,
    };
  });
  expect(reduced.animation).toBe("none");
  expect(reduced.properties).toBe("opacity");
  expect(reduced.durations.every(duration => duration === 0.2)).toBe(true);
  expect(reduced.transform).toBe("none");
});

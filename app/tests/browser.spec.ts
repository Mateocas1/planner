import { expect, test, type Page } from "@playwright/test";
import { readRemoteBlocks, readRemoteCompletions, readRemoteProfile, readRemoteSeries, readRemoteState, readRemoteTasks, createRemoteAccount, seedProfileAndBlock, seedTaskAndBlock, updateRemoteProfile, submitAuthForm } from "./browser-helpers.ts";

test.setTimeout(60_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

/** Signs an existing (remotely seeded) account in through the browser form. */
async function signInAs(page: Page, email: string) {
  await submitAuthForm(page, email, "sign in");
}

/** Awaits server-side propagation of a write, then asserts the exact remote state. */
async function expectRemoteTasks(email: string, expected: unknown[]) {
  await expect
    .poll(() => readRemoteTasks(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual(expected);
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  // C2: creation is collapsed on arrival; openTasks only lands the surface.
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Waits out a creation sheet that was just submitted: it stays busy for a
 * beat while the write is accepted, then plays its return animation before
 * leaving the DOM. Its controls must not be mistaken for an open form. A
 * sheet that is idle (for example showing a validation error) stays. */
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

/**
 * Opens the New task sheet (C2: creation is never permanently on the surface).
 * Idempotent: if a test already opened it, the Add task control is visible
 * and nothing is clicked.
 */
async function revealTaskForm(page: Page) {
  await settleSheet(page, "New task");
  const add = page.getByRole("button", { name: "Add task" });
  if (await add.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "New task" }).click();
  await expect(add).toBeVisible();
}

test("walking skeleton: account creation, truthful Home counts, and navigation", async ({ page }) => {
  const email = `walk-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const start = "2026-03-02T09:00:00-03:00";

  await signUp(page, email);

  await expect(page.getByText("No tasks and no work blocks yet")).toBeVisible();

  await seedTaskAndBlock(email, "Skeleton task", start, "2026-03-02T10:00:00-03:00");
  const nav = page.getByRole("navigation", { name: "Main" });
  // the open count on the Tasks entry is the truthful count of open tasks
  await expect(nav.getByRole("button", { name: "Tasks 1 open" })).toBeVisible();

  await nav.getByRole("button", { name: "Tasks" }).click();
  // C2: creation is collapsed, not permanently on the surface
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await nav.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByText("Times in")).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(nav.getByRole("button", { name: "Tasks 1 open" })).toBeVisible({ timeout: 30_000 });
  const remote = await readRemoteState(email);
  expect(remote).toEqual({ taskTitles: ["Skeleton task"], blockStarts: [start] });
});

test("Today shows what is due, what is coming up and today's schedule from the planner state", async ({ page }) => {
  const email = newEmail("home-today");
  await signUp(page, email);

  // An empty planner stays calm: one sentence, no dashboard of empty sections.
  await expect(page.getByText("No tasks and no work blocks yet")).toBeVisible();
  await expect(page.locator(".today-grid")).toHaveCount(0);

  const today = localDateKey(new Date());

  await openTasks(page);
  await addTaskThroughForm(page, "Open task");
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Due today");
  await page.getByLabel("Deadline").fill(today);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Due today" })).toBeVisible();
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Due soon");
  await page.getByLabel("Deadline").fill(dayKey(3));
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Due soon" })).toBeVisible();
  await addTaskThroughForm(page, "Done task");
  await page.getByRole("checkbox", { name: "Complete: Done task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);

  await openCalendar(page);
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${today}T09:00`);
  await page.getByLabel("End", { exact: true }).fill(`${today}T10:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(page.locator(`[data-date="${today}"] .calendar-block`)).toHaveCount(1);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Today" }).click();
  const due = page.getByRole("region", { name: "Due today" });
  await expect(due.getByRole("checkbox", { name: "Complete: Due today" })).toBeVisible();
  await expect(due.getByText("Open task")).toHaveCount(0);
  await expect(due.getByText("Done task")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Coming up" }).getByText("Due soon")).toBeVisible();
  const schedule = page.getByRole("region", { name: "Schedule" });
  await expect(schedule.getByText("Work block")).toBeVisible();
  await expect(schedule.getByText("09:00 – 10:00")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks 3 open" })).toBeVisible();

  // Completing from Today writes the same completion the Tasks list does.
  await due.getByRole("checkbox", { name: "Complete: Due today" }).click();
  await expect(due.getByText("Nothing due today.")).toBeVisible();
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Due today"), { timeout: 15_000 })
    .toEqual({ title: "Due today", completed: true, deadline: today });
});

test("creating a task with a deadline shows the row and persists it to the server", async ({ page }) => {
  const email = newEmail("create");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Write review");
  await page.getByLabel("Deadline").fill("2026-04-01");
  await page.getByRole("button", { name: "Add task" }).click();

  await expect(page.locator(".task-title", { hasText: "Write review" })).toBeVisible();
  // C1: the row shows the human date (locale pinned to en-US), not the ISO key
  await expect(page.locator(".task-deadline", { hasText: "Wed, Apr 1" })).toBeVisible();

  // the stored value stays ISO: that assertion is about the data, not the display
  await expectRemoteTasks(email, [{ title: "Write review", completed: false, deadline: "2026-04-01" }]);
});

test("pressing Enter in the revealed title field creates the task", async ({ page }) => {
  const email = newEmail("enter");
  await signUp(page, email);

  // C2: creation is collapsed by default and does not occupy the surface
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(0);

  // revealing gives a title input; Enter submits the form natively
  await page.getByRole("button", { name: "New task" }).click();
  const title = page.getByLabel("Task title");
  await expect(title).toBeVisible();
  await title.fill("Quick add");
  await title.press("Enter");

  await expect(page.locator(".task-title", { hasText: "Quick add" })).toBeVisible();
  // the successful write collapses the revealed row again
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Quick add", completed: false }]);
});

test("renaming a task persists the new title to the server", async ({ page }) => {
  const email = newEmail("rename");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Draft plan");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Draft plan" })).toBeVisible();

  // the row's title button opens the details panel; rename edits in place
  await page.getByRole("button", { name: "Draft plan" }).click();
  const rename = page.getByLabel("Rename task");
  await rename.fill("Final plan");
  await rename.press("Enter");

  await expect(page.locator(".task-title", { hasText: "Final plan" })).toBeVisible();
  await expect(page.locator(".task-title", { hasText: "Draft plan" })).toHaveCount(0);

  await expectRemoteTasks(email, [{ title: "Final plan", completed: false }]);
});

test("Escape cancels an inline rename and leaves the stored title unchanged", async ({ page }) => {
  const email = newEmail("rename-cancel");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Original title");
  await page.getByRole("button", { name: "Original title" }).click();
  const panel = page.getByRole("complementary", { name: "Task details" });
  const rename = panel.getByLabel("Rename task");

  // a pending edit is reverted: the input restores the stored title and the
  // panel stays open (Escape with nothing to cancel is what closes it)
  await rename.fill("Changed title");
  await rename.press("Escape");
  await expect(panel).toBeVisible();
  await expect(rename).toHaveValue("Original title");

  // neither the row nor the server saw the cancelled value
  await expect(page.locator(".task-title", { hasText: "Original title" })).toBeVisible();
  await expect(page.locator(".task-title", { hasText: "Changed title" })).toHaveCount(0);
  await expectRemoteTasks(email, [{ title: "Original title", completed: false }]);
});

test("completing and uncompleting a task sets completed on the server", async ({ page }) => {
  const email = newEmail("complete");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Solo task");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Solo task" })).toBeVisible();

  // completion lives on the row checkbox; click + assert because the store
  // update lands a beat after the click
  await page.getByRole("checkbox", { name: "Complete: Solo task" }).click();
  // the completed task stays listed and is visually distinguished
  await expect(page.locator("li.task.completed", { hasText: "Solo task" })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Reopen: Solo task" })).toBeChecked();
  await expectRemoteTasks(email, [{ title: "Solo task", completed: true }]);

  await page.getByRole("checkbox", { name: "Reopen: Solo task" }).click();
  await expect(page.getByRole("checkbox", { name: "Complete: Solo task" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Solo task", completed: false }]);
});

test("deleting a task removes the row and the server document", async ({ page }) => {
  const email = newEmail("delete");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Doomed task");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Doomed task" })).toBeVisible();

  // delete lives in the details panel
  await page.getByRole("button", { name: "Doomed task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();

  await expect(page.locator(".task-title", { hasText: "Doomed task" })).toHaveCount(0);
  await expectRemoteTasks(email, []);
});

test("editing the deadline in the details panel persists the change and clearing removes the field", async ({ page }) => {
  const email = newEmail("deadline");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Scheduled task");
  await page.getByRole("button", { name: "Scheduled task" }).click();
  const panel = page.getByRole("complementary", { name: "Task details" });

  await panel.getByLabel("Deadline").fill("2026-05-10");
  // C1: the panel writes ISO; the row reads back human (locale pinned to en-US)
  await expect(page.locator(".task-deadline", { hasText: "Sun, May 10" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Scheduled task", completed: false, deadline: "2026-05-10" }]);

  // clearing the control removes the field on the server entirely
  await panel.getByLabel("Deadline").fill("");
  await expect(page.locator(".task-deadline")).toHaveCount(0);
  await expectRemoteTasks(email, [{ title: "Scheduled task", completed: false }]);
});

test("a deadline of today reads as a word and an overdue task carries the overdue state", async ({ page }) => {
  const email = newEmail("human-dates");
  await signUp(page, email);
  await openTasks(page);

  const today = localDateKey(new Date());
  const yesterday = dayKey(-1);

  // C1: today's deadline is a word, not its ISO key
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Water plants");
  await page.getByLabel("Deadline").fill(today);
  await page.getByRole("button", { name: "Add task" }).click();
  const todayRow = page.locator("li.task", { hasText: "Water plants" });
  await expect(todayRow.locator(".task-deadline")).toHaveText("due today");
  await expect(todayRow.locator(".task-deadline")).not.toContainText(today);
  // the successful write collapses the row; reveal it again for the next entry
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();

  // C1: a past deadline on an unfinished task carries the overdue state
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Pay bill");
  await page.getByLabel("Deadline").fill(yesterday);
  await page.getByRole("button", { name: "Add task" }).click();
  const lateRow = page.locator("li.task", { hasText: "Pay bill" });
  await expect(lateRow.locator(".task-deadline")).toHaveClass(/task-deadline-overdue/);
  await expect(lateRow.locator(".task-deadline")).not.toContainText(yesterday);

  // completing it clears the state...
  await page.getByRole("checkbox", { name: "Complete: Pay bill" }).click();
  await expect(lateRow.locator(".task-deadline")).not.toHaveClass(/task-deadline-overdue/);

  // ...and the keys on the server stay ISO: the display changed, the data did not
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Pay bill"), { timeout: 15_000 })
    .toEqual({ title: "Pay bill", completed: true, deadline: yesterday });
  await expect
    .poll(async () => (await readRemoteTasks(email)).find(task => task.title === "Water plants"), { timeout: 15_000 })
    .toEqual({ title: "Water plants", completed: false, deadline: today });
});

async function addTaskThroughForm(page: Page, title: string) {
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  // the write may still be in flight (busy disables the form); the form only
  // collapses once it settles, so a following fill is never wiped by its reset
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

test("selecting a row opens the details panel, and it closes via Close and Escape", async ({ page }) => {
  const email = newEmail("panel");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Panel task");
  await expect(page.locator(".task-details")).toHaveCount(0);

  await page.getByRole("button", { name: "Panel task" }).click();
  const panel = page.getByRole("complementary", { name: "Task details" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toHaveValue("Panel task");

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);

  await page.getByRole("button", { name: "Panel task" }).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

/** Records the view transitions the page starts, through the app's own code
 * path: a morph is the only caller of document.startViewTransition. `ready`
 * settles only once the snapshots were taken, so an abort (a duplicate shared
 * name, an invalid state) shows up as `aborted` instead of a silent pass. */
async function recordViewTransitions(page: Page) {
  await page.addInitScript(() => {
    const scope = globalThis as { __vtStarted?: number; __vtReady?: number; __vtAborted?: number };
    scope.__vtStarted = 0;
    scope.__vtReady = 0;
    scope.__vtAborted = 0;
    const start = document.startViewTransition?.bind(document);
    if (!start) return;
    document.startViewTransition = callback => {
      scope.__vtStarted = (scope.__vtStarted ?? 0) + 1;
      const transition = start(callback);
      transition.ready.then(
        () => { scope.__vtReady = (scope.__vtReady ?? 0) + 1; },
        () => { scope.__vtAborted = (scope.__vtAborted ?? 0) + 1; },
      );
      return transition;
    };
  });
}

function viewTransitions(page: Page) {
  return page.evaluate(() => {
    const scope = globalThis as { __vtStarted?: number; __vtReady?: number; __vtAborted?: number };
    return { started: scope.__vtStarted ?? 0, ready: scope.__vtReady ?? 0, aborted: scope.__vtAborted ?? 0 };
  });
}

test("the row morphs into the details panel and focus returns to the row", async ({ page }) => {
  await recordViewTransitions(page);
  const email = newEmail("morph");
  await signUp(page, email);
  await openTasks(page);
  await addTaskThroughForm(page, "Morph task");

  const opener = page.getByRole("button", { name: "Morph task" });
  const panel = page.getByRole("complementary", { name: "Task details" });
  // only the details panel morphs: the creation sheet keeps its own entry
  expect((await viewTransitions(page)).started).toBe(0);

  await opener.click();
  await expect(panel).toBeVisible();
  // the caret lands in the panel, and the row grew into it rather than popped
  await expect(panel.getByLabel("Rename task")).toBeFocused();
  await expect.poll(async () => (await viewTransitions(page)).ready).toBe(1);
  // the morph drops the blur from the captured box only (app.css); the panel on
  // screen keeps the glass material glass.css gives it
  const material = await panel.evaluate(element => getComputedStyle(element).backdropFilter);
  expect(material).toContain("blur");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect.poll(async () => (await viewTransitions(page)).ready).toBe(2);

  // opening another task right after a close lands on a settled page, not on
  // two stacked transitions
  await opener.click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect.poll(async () => (await viewTransitions(page)).ready).toBe(4);
  expect((await viewTransitions(page)).aborted).toBe(0);
});

// A sheet whose exit is still playing finishes after the user moved on, and it
// must not take the caret back when it unmounts: the row opened meanwhile keeps
// its details field focused, and the creation sheet's origin is left alone.
test("a sheet still animating out never takes the caret back from the panel opened meanwhile", async ({ page }) => {
  const email = newEmail("focus-handoff");
  await signUp(page, email);
  await openTasks(page);
  // the row is visible before the creation sheet has finished leaving, so the
  // panel is opened inside that window
  await addTaskThroughForm(page, "Handoff");

  const panel = page.getByRole("complementary", { name: "Task details" });
  await page.getByRole("button", { name: "Handoff" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toBeFocused();
  // and it is still there once the creation sheet is gone for good
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
  await expect(panel.getByLabel("Rename task")).toBeFocused();
});

test("reduced motion opens the details panel without a view transition", async ({ page }) => {
  await recordViewTransitions(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const email = newEmail("morph-reduced");
  await signUp(page, email);
  await openTasks(page);
  await addTaskThroughForm(page, "Calm task");

  const opener = page.getByRole("button", { name: "Calm task" });
  const panel = page.getByRole("complementary", { name: "Task details" });
  await opener.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toBeFocused();
  expect((await viewTransitions(page)).started).toBe(0);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect((await viewTransitions(page)).started).toBe(0);
});

test("the list groups open and completed tasks under counted headings", async ({ page }) => {
  const email = newEmail("groups");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Open task");
  await addTaskThroughForm(page, "Done task");
  await page.getByRole("checkbox", { name: "Complete: Done task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);

  await expect(page.getByRole("heading", { name: "Open 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Completed 1" })).toBeVisible();
  await expect(page.locator("li.task:not(.completed)", { hasText: "Open task" })).toHaveCount(1);
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);
});

test("an empty title is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("invalid");
  await signUp(page, email);
  await openTasks(page);

  await revealTaskForm(page);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert")).toContainText("task title is required");
  await expectRemoteTasks(email, []);
});

test("the completion wash plays on a user completion and never for already-completed rows", async ({ page }) => {
  const email = newEmail("wash");
  await signUp(page, email);
  await openTasks(page);

  // the wash class appears only when the user performs the completion
  await addTaskThroughForm(page, "Fresh task");
  await page.getByRole("checkbox", { name: "Complete: Fresh task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Fresh task" })).toHaveCount(1);
  await expect(page.locator("li.task.task-wash")).toHaveCount(1);

  // rows that mount already completed must not replay the wash
  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await openTasks(page);
  await expect(page.locator("li.task.completed", { hasText: "Fresh task" })).toHaveCount(1);
  await expect(page.locator("li.task.task-wash")).toHaveCount(0);
});

/* ---------- state motion (S4): one gesture per state change ---------- */

/** Seconds out of a computed duration list, so an assertion reads a number. */
const durationSeconds = (value: string) =>
  value.split(",").map(entry => (entry.trim().endsWith("ms") ? parseFloat(entry) / 1000 : parseFloat(entry)));

/**
 * Records every CSS animation the document starts, with the duration it was
 * declared with. The new state animations are 160-400 ms long, so sampling a
 * frame after a round trip to the test is a race; the event never is.
 */
async function recordAnimations(page: Page) {
  await page.evaluate(() => {
    const started: Array<{ name: string; duration: string }> = [];
    (window as unknown as { startedAnimations: typeof started }).startedAnimations = started;
    document.addEventListener(
      "animationstart",
      event => {
        started.push({ name: event.animationName, duration: getComputedStyle(event.target as Element).animationDuration });
      },
      true,
    );
  });
}

async function startedAnimations(page: Page) {
  return page.evaluate(
    () => (window as unknown as { startedAnimations?: Array<{ name: string; duration: string }> }).startedAnimations ?? [],
  );
}

/**
 * Reads one @keyframes rule out of the built stylesheet. A finished animation
 * is gone from getAnimations(), so this is the stable way to prove a property
 * (a blur, say) is never animated at all.
 */
async function keyframesOf(page: Page, name: string) {
  return page.evaluate(keyframesName => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSKeyframesRule) || rule.name !== keyframesName) continue;
        return Array.from(rule.cssRules).map(frame => {
          const keyframe = frame as CSSKeyframeRule;
          const style: Record<string, string> = {};
          for (let index = 0; index < keyframe.style.length; index += 1) {
            const property = keyframe.style[index]!;
            style[property] = keyframe.style.getPropertyValue(property);
          }
          return { key: keyframe.keyText, style };
        });
      }
    }
    return null;
  }, name);
}

test("the check is one 200 ms state change and its tick only fades", async ({ page }) => {
  const email = newEmail("state-check");
  await signUp(page, email);
  await openTasks(page);
  await addTaskThroughForm(page, "State task");

  const check = page.locator("li.task input.task-check");
  // the ring fills on --dur-state, and so does the tick that lands on top of it
  const ring = await check.evaluate(element => {
    const style = getComputedStyle(element);
    return { properties: style.transitionProperty, durations: style.transitionDuration };
  });
  expect(ring.properties).toContain("background-color");
  expect(ring.properties).toContain("box-shadow");
  expect(durationSeconds(ring.durations).every(duration => duration === 0.2)).toBe(true);

  // the tick fades in place: no second scale spring on the 12 px glyph
  const tick = await check.evaluate(element => {
    const style = getComputedStyle(element, "::after");
    return { properties: style.transitionProperty, transform: style.transform, opacity: style.opacity };
  });
  expect(tick).toEqual({ properties: "opacity", transform: "none", opacity: "0" });

  await recordAnimations(page);
  await page.getByRole("checkbox", { name: "Complete: State task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "State task" })).toHaveCount(1);

  // the circle keeps its pop at --dur-state and the wash reads at 400 ms, and the
  // glyph runs no animation of its own beyond the circle it sits in
  await expect
    .poll(() => startedAnimations(page))
    .toEqual(expect.arrayContaining([{ name: "check-pop", duration: "0.2s" }]));
  await expect
    .poll(() => startedAnimations(page))
    .toEqual(expect.arrayContaining([{ name: "task-wash", duration: "0.4s" }]));
  // the sync indicator swaps on the same write (its own suite pins that motion),
  // so only the row's animations are counted here: the pop and the wash, and no
  // third animation of the glyph's own
  const names = (await startedAnimations(page)).map(entry => entry.name).filter(name => name !== "sync-swap");
  expect([...new Set(names)].sort()).toEqual(["check-pop", "task-wash"]);

  // the checked state reads its fade from the entering state: 200 ms, not the
  // press-speed exit the uncheck keeps
  expect(await check.evaluate(element => getComputedStyle(element, "::after").transitionDuration)).toBe("0.2s");
});

test("a block enters in 160 ms without a blur, and the now-bar settles in 350 ms", async ({ page }) => {
  const email = newEmail("state-block");
  await signUp(page, email);
  await openCalendar(page);

  // a block running right now, so Today can show its progress bar
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(Math.max(startOfDay.getTime(), now.getTime() - 10 * 60_000));
  const wallClock = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  await recordAnimations(page);
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(wallClock(start));
  await page.getByLabel("End", { exact: true }).fill(wallClock(new Date(now.getTime() + 30 * 60_000)));
  await page.getByRole("button", { name: "Add block" }).click();

  const day = localDateKey(now);
  await expect(page.locator(`[data-date="${day}"] .calendar-block`)).toHaveCount(1);
  await expect
    .poll(() => startedAnimations(page))
    .toEqual(expect.arrayContaining([{ name: "block-in", duration: "0.16s" }]));

  // opacity and scale only: every range change remounts the blocks, and a blur
  // on each of them reads as a smear rather than a bridge
  const frames = await keyframesOf(page, "block-in");
  expect(frames).toHaveLength(1);
  expect(frames![0]!.style.opacity).toBe("0");
  expect(frames![0]!.style).not.toHaveProperty("filter");

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Today" }).click();
  const bar = page.locator(".now-card .progress i");
  await expect(bar).toHaveCount(1);
  // the bar shows the elapsed share of the block, and settles in 350 ms
  expect(await bar.evaluate(element => getComputedStyle(element).transform)).not.toBe("none");
  expect(durationSeconds(await bar.evaluate(element => getComputedStyle(element).transitionDuration)).every(duration => duration === 0.35)).toBe(true);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the strike and the wash still mark a completion, at 150 ms", async ({ page }) => {
    const email = newEmail("state-reduce");
    await signUp(page, email);
    await openTasks(page);
    await addTaskThroughForm(page, "Reduced task");

    // completion is a colour cue, not movement: it survives the 1 ms collapse
    const title = page.locator(".task-title", { hasText: "Reduced task" });
    expect(durationSeconds(await title.evaluate(element => getComputedStyle(element).transitionDuration)).every(duration => duration === 0.15)).toBe(true);

    await recordAnimations(page);
    await page.getByRole("checkbox", { name: "Complete: Reduced task" }).click();
    await expect(page.locator("li.task.completed", { hasText: "Reduced task" })).toHaveCount(1);
    await expect
      .poll(() => startedAnimations(page))
      .toEqual(expect.arrayContaining([{ name: "task-wash", duration: "0.15s" }]));
  });
});

async function openCalendar(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  // C2: creation is collapsed on arrival; openCalendar only lands the surface.
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
}

/**
 * Reveals the collapsed Calendar creation form (C2). Idempotent: if a test
 * already revealed it, the Add block control is visible and nothing is clicked.
 */
async function revealBlockForm(page: Page) {
  await settleSheet(page, "New block");
  const add = page.getByRole("button", { name: "Add block" });
  if (await add.isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "New block" }).click();
  await expect(add).toBeVisible();
}

async function expectRemoteBlocks(email: string, expected: unknown[]) {
  await expect
    .poll(() => readRemoteBlocks(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual(expected);
}

/** Local YYYY-MM-DD key for a Date, matching the grid's browser-local timezone. */
function localDateKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local date N days from now, used as a series anchor in the future. */
function futureDateKey(daysFromNow: number) {
  return localDateKey(new Date(Date.now() + daysFromNow * 86_400_000));
}

/** A local date N days from now (negative for the past), used as a series anchor. */
function dayKey(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return localDateKey(date);
}

/** Creates a recurring series through the form and waits for its row. */
async function addSeriesThroughForm(page: Page, title: string, frequency: "Daily" | "Weekly" | "Monthly", start: string) {
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("Repeat").selectOption({ label: frequency });
  await page.getByLabel("Start date").fill(start);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".series-row", { hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

let createdSeries: Array<{ id: string; data: Record<string, string> }> = [];

/** Polls the forced-server read until exactly one series exists, then returns it. */
async function expectSingleRemoteSeries(email: string) {
  await expect
    .poll(
      async () => {
        createdSeries = await readRemoteSeries(email);
        return createdSeries.length;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return createdSeries[0]!;
}

async function expectRemoteCompletions(email: string, expected: unknown[]) {
  await expect
    .poll(() => readRemoteCompletions(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual(expected);
}

test("a series created from the UI persists with its frequency and anchor and shows its next occurrence", async ({ page }) => {
  const email = newEmail("series-create");
  await signUp(page, email);
  await openTasks(page);

  // an anchor in the future makes the next occurrence the anchor itself
  const start = futureDateKey(1);
  await addSeriesThroughForm(page, "Stretch", "Weekly", start);

  const row = page.locator(".series-row", { hasText: "Stretch" });
  await expect(row).toHaveAttribute("data-next-occurrence", start);
  await expect(row.getByText("Weekly")).toBeVisible();
  // C1: futureDateKey(1) is tomorrow, so the row reads the word; the ISO key
  // stays the row's data attribute above
  await expect(row.getByText("next tomorrow")).toBeVisible();

  const series = await expectSingleRemoteSeries(email);
  expect(series.id).not.toBe("");
  expect(series.data).toEqual({ title: "Stretch", frequency: "weekly", anchorDate: start });
});

test("completing the next occurrence records exactly that occurrence and the row advances", async ({ page }) => {
  const email = newEmail("series-complete");
  await signUp(page, email);
  await openTasks(page);

  const first = futureDateKey(1);
  const second = futureDateKey(2);
  await addSeriesThroughForm(page, "Meditate", "Daily", first);
  await page.getByRole("checkbox", { name: `Complete: Meditate on ${first}` }).click();

  const series = await expectSingleRemoteSeries(email);
  await expectRemoteCompletions(email, [
    { occurrenceId: `${series.id}:${first}`, completedAt: expect.any(String) },
  ]);

  // the row visibly advances to the following occurrence
  const row = page.locator(".series-row", { hasText: "Meditate" });
  await expect(row).toHaveAttribute("data-next-occurrence", second, { timeout: 15_000 });
  await expect(page.getByRole("checkbox", { name: `Complete: Meditate on ${second}` })).toBeVisible();
});

test("completing one occurrence never marks the following one", async ({ page }) => {
  const email = newEmail("series-isolation");
  await signUp(page, email);
  await openTasks(page);

  const first = futureDateKey(1);
  const second = futureDateKey(2);
  await addSeriesThroughForm(page, "Water plants", "Daily", first);
  await page.getByRole("checkbox", { name: `Complete: Water plants on ${first}` }).click();

  // exactly one completion exists, and it is the first occurrence, not the next
  const series = await expectSingleRemoteSeries(email);
  await expectRemoteCompletions(email, [
    { occurrenceId: `${series.id}:${first}`, completedAt: expect.any(String) },
  ]);
  const completions = await readRemoteCompletions(email);
  expect(completions.some(completion => completion.occurrenceId === `${series.id}:${second}`)).toBe(false);

  // and the following occurrence is still offered, unchecked
  const row = page.locator(".series-row", { hasText: "Water plants" });
  await expect(row).toHaveAttribute("data-next-occurrence", second, { timeout: 15_000 });
  const following = page.getByRole("checkbox", { name: `Complete: Water plants on ${second}` });
  await expect(following).toBeVisible();
  await expect(following).not.toBeChecked();
});

test("opening a series shows its frequency, anchor and upcoming occurrences in the panel", async ({ page }) => {
  const email = newEmail("series-panel");
  await signUp(page, email);
  await openTasks(page);

  // a future weekly anchor: the first upcoming occurrence is the anchor itself
  const start = futureDateKey(1);
  const second = futureDateKey(8);
  const third = futureDateKey(15);
  await addSeriesThroughForm(page, "Stretch", "Weekly", start);

  // the series row's title button opens the panel
  await page.getByRole("button", { name: "Stretch" }).click();
  const panel = page.getByRole("complementary", { name: "Series details" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename series")).toHaveValue("Stretch");
  await expect(panel.getByLabel("Frequency")).toHaveValue("weekly");
  await expect(panel.getByLabel("Anchor")).toHaveValue(start);
  // C1: the panel shows human dates; the ISO keys are gone from the display
  // (the checkbox below still addresses the occurrence by its ISO key)
  await expect(panel.locator(".series-occurrences")).not.toContainText(start);
  await expect(panel.locator(".series-occurrences")).not.toContainText(second);
  await expect(panel.locator(".series-occurrences")).not.toContainText(third);
  await expect(panel.locator(".series-occurrences")).toContainText("tomorrow");
  await expect(panel.getByRole("checkbox", { name: `Complete: Stretch on ${start}` })).toBeVisible();

  // the panel keeps the shared panel behaviour: Close dismisses it
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
});

async function openSeriesPanel(page: Page, title: string) {
  await page.getByRole("button", { name: title }).click();
  const panel = page.getByRole("complementary", { name: "Series details" });
  await expect(panel).toBeVisible();
  return panel;
}

let panelSeries: Array<{ id: string; data: Record<string, string> }> = [];

/** Polls the forced-server read until exactly one series exists, then returns it. */
async function expectOneRemoteSeries(email: string) {
  await expect
    .poll(
      async () => {
        panelSeries = await readRemoteSeries(email);
        return panelSeries.length;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return panelSeries[0]!;
}

/**
 * Waits for the single stored series to hold `key === value`, then returns it.
 * The interface reflects a write from the local cache while a forced server
 * read can still see the previous value, so reading once immediately after a
 * mutation is a race — it made the frequency test fail roughly one run in four
 * depending on timing. Polling the field keeps exactly the same assertion and
 * removes the race, and a genuine mismatch still fails naming the value it saw.
 */
async function expectRemoteSeriesField(email: string, key: string, value: string) {
  await expect
    .poll(async () => (await expectOneRemoteSeries(email)).data[key], {
      timeout: 15_000,
      intervals: [250, 500, 1_000],
    })
    .toBe(value);
}

test("renaming a series persists the new title to the server", async ({ page }) => {
  const email = newEmail("series-rename");
  await signUp(page, email);
  await openTasks(page);

  await addSeriesThroughForm(page, "Morning walk", "Daily", futureDateKey(1));
  const panel = await openSeriesPanel(page, "Morning walk");
  // the series panel renames in place, exactly like the task panel: Enter
  // commits the edit (blur would too) and there is no Save rename control
  await panel.getByLabel("Rename series").fill("Evening walk");
  await panel.getByLabel("Rename series").press("Enter");

  await expect(page.locator(".series-row", { hasText: "Evening walk" })).toBeVisible();
  await expect(page.locator(".series-row", { hasText: "Morning walk" })).toHaveCount(0);

  await expectRemoteSeriesField(email, "title", "Evening walk");
});

test("changing a series' frequency persists and the row's next occurrence updates", async ({ page }) => {
  const email = newEmail("series-frequency");
  await signUp(page, email);
  await openTasks(page);

  // A past anchor makes the frequency visible in the next occurrence: weekly
  // from three days ago lands in four days, daily lands today.
  const anchor = dayKey(-3);
  await addSeriesThroughForm(page, "Stretch", "Weekly", anchor);

  const row = page.locator(".series-row", { hasText: "Stretch" });
  await expect(row).toHaveAttribute("data-next-occurrence", dayKey(4));

  const panel = await openSeriesPanel(page, "Stretch");
  await panel.getByLabel("Frequency").selectOption({ label: "Daily" });

  await expect(row).toHaveAttribute("data-next-occurrence", dayKey(0));
  await expect(panel.getByLabel("Frequency")).toHaveValue("daily");

  await expectRemoteSeriesField(email, "frequency", "daily");
  await expectRemoteSeriesField(email, "anchorDate", anchor);
});

test("changing a series' anchor persists the new date", async ({ page }) => {
  const email = newEmail("series-anchor");
  await signUp(page, email);
  await openTasks(page);

  await addSeriesThroughForm(page, "Review", "Monthly", futureDateKey(1));
  const moved = futureDateKey(10);

  const panel = await openSeriesPanel(page, "Review");
  await panel.getByLabel("Anchor").fill(moved);

  await expect(panel.getByLabel("Anchor")).toHaveValue(moved);
  await expect(page.locator(".series-row", { hasText: "Review" })).toHaveAttribute("data-next-occurrence", moved);

  await expectRemoteSeriesField(email, "anchorDate", moved);
  await expectRemoteSeriesField(email, "frequency", "monthly");
});

test("an invalid series edit is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("series-invalid");
  await signUp(page, email);
  await openTasks(page);

  const start = futureDateKey(1);
  await addSeriesThroughForm(page, "Keep me", "Daily", start);
  const panel = await openSeriesPanel(page, "Keep me");

  // an empty title fails domain validation before any write; the in-place
  // rename commits on Enter just like a blur would
  await panel.getByLabel("Rename series").fill("");
  await panel.getByLabel("Rename series").press("Enter");
  await expect(page.getByRole("alert")).toContainText("task title is required");

  // an empty anchor is not a valid date-only value and is refused too
  await panel.getByLabel("Anchor").fill("");
  await expect(page.getByRole("alert")).toContainText("expected a valid ISO date-only value");
  await expect(panel.getByLabel("Anchor")).toHaveValue(start);

  // nothing was written: the stored series still holds its original values
  const series = await expectOneRemoteSeries(email);
  expect(series.data.title).toBe("Keep me");
  expect(series.data.anchorDate).toBe(start);
});

test("completing an occurrence from the series panel records exactly that occurrence", async ({ page }) => {
  const email = newEmail("series-panel-complete");
  await signUp(page, email);
  await openTasks(page);

  const first = futureDateKey(1);
  const second = futureDateKey(2);
  await addSeriesThroughForm(page, "Meditate", "Daily", first);

  const panel = await openSeriesPanel(page, "Meditate");
  await panel.getByRole("checkbox", { name: `Complete: Meditate on ${first}` }).click();

  // exactly one completion exists on the server, and it is the occurrence the
  // panel offered, not any other
  const series = await expectOneRemoteSeries(email);
  await expectRemoteCompletions(email, [
    { occurrenceId: `${series.id}:${first}`, completedAt: expect.any(String) },
  ]);

  // the panel reflects the completion and advances to the next occurrence
  await expect(panel.getByRole("checkbox", { name: `Completed: Meditate on ${first}` })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: `Complete: Meditate on ${second}` })).toBeVisible();
});

test("deleting a series removes it from the list and from the server", async ({ page }) => {
  const email = newEmail("series-delete");
  await signUp(page, email);
  await openTasks(page);

  const start = futureDateKey(1);
  await addSeriesThroughForm(page, "Doomed habit", "Daily", start);
  await expectOneRemoteSeries(email);

  const panel = await openSeriesPanel(page, "Doomed habit");
  await panel.getByRole("button", { name: "Delete series" }).click();

  // the row and the panel both disappear, and the server no longer holds the series
  await expect(page.locator(".series-row", { hasText: "Doomed habit" })).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect
    .poll(() => readRemoteSeries(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual([]);
});

/** Polls the forced-server read until one block exists, then returns it. */
async function expectSingleRemoteBlock(email: string) {
  let remote: Array<{ start: string; end: string; taskId?: string }> = [];
  await expect
    .poll(
      async () => {
        remote = await readRemoteBlocks(email);
        return remote.length;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(1);
  return remote[0];
}

test("creating a block through the form persists the exact entered instant and renders in its day column", async ({ page }) => {
  const email = newEmail("block-create");
  await signUp(page, email);
  await openCalendar(page);

  const day = localDateKey(new Date());
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${day}T09:30`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T10:15`);
  await page.getByRole("button", { name: "Add block" }).click();

  // The grid renders in the browser's local timezone, so the same wall-clock
  // input interpreted in this process must equal the stored instant's epoch.
  const expectedStart = new Date(`${day}T09:30:00`).getTime();
  const expectedEnd = new Date(`${day}T10:15:00`).getTime();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  const renderedStart = await block.getAttribute("data-start");
  expect(new Date(renderedStart!).getTime()).toBe(expectedStart);

  const stored = await expectSingleRemoteBlock(email);
  expect(new Date(stored.start).getTime()).toBe(expectedStart);
  expect(new Date(stored.end).getTime()).toBe(expectedEnd);
  expect(stored.start).toBe(renderedStart);
});

test("clicking an empty calendar cell prefills that slot's start and reveals the form", async ({ page }) => {
  const email = newEmail("block-prefill");
  await signUp(page, email);
  await openCalendar(page);

  // The grid covers the whole day and an hour is one hourHeight (52 px), so a
  // click 468 px into the column is 09:00. The grid scrolls inside its card,
  // so bring that hour into view first. The block list is empty, so the click
  // lands on the cell itself.
  const day = localDateKey(new Date());
  await page.locator(".cal-scroll").evaluate(element => {
    element.scrollTop = 8 * 52;
  });
  await page.locator(`[data-date="${day}"] .calendar-day-body`).click({ position: { x: 24, y: 468 } });

  await expect(page.getByLabel("Start", { exact: true })).toHaveValue(`${day}T09:00`);
});

test("a block linked to a task shows that task's title", async ({ page }) => {
  const email = newEmail("block-task");
  await signUp(page, email);
  await openTasks(page);
  await revealTaskForm(page);
  await page.getByLabel("Task title").fill("Deep work");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Deep work" })).toBeVisible();

  await openCalendar(page);
  await revealBlockForm(page);
  const day = localDateKey(new Date());
  await page.getByLabel("Start", { exact: true }).fill(`${day}T14:00`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T15:00`);
  await page.getByLabel("Task", { exact: true }).selectOption({ label: "Deep work" });
  await page.getByRole("button", { name: "Add block" }).click();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Deep work");

  const stored = await expectSingleRemoteBlock(email);
  expect(typeof stored.taskId).toBe("string");
  expect(stored.taskId!.length).toBeGreaterThan(0);
});

test("an end at or before the start is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("block-invalid");
  await signUp(page, email);
  await openCalendar(page);

  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill("2026-03-04T10:00");
  await page.getByLabel("End", { exact: true }).fill("2026-03-04T09:00");
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(page.getByRole("alert")).toContainText("duration must be positive");

  await page.getByLabel("End", { exact: true }).fill("2026-03-04T10:00");
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(page.getByRole("alert")).toContainText("duration must be positive");

  await expectRemoteBlocks(email, []);
});

test("deleting a block removes it from the grid and from the server", async ({ page }) => {
  const email = newEmail("block-delete");
  await signUp(page, email);
  await openCalendar(page);

  const day = localDateKey(new Date());
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${day}T11:00`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T12:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expectSingleRemoteBlock(email);

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  // delete lives in the block's details sheet
  await block.click();
  await page.getByRole("button", { name: "Delete block" }).click();

  await expect(block).toHaveCount(0);
  await expectRemoteBlocks(email, []);
});

test("week navigation changes the visible week", async ({ page }) => {
  const email = newEmail("block-week");
  await signUp(page, email);
  await openCalendar(page);

  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const key = localDateKey(nextWeek);
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${key}T08:00`);
  await page.getByLabel("End", { exact: true }).fill(`${key}T09:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expectSingleRemoteBlock(email);

  // The block belongs to next week, so today's week shows neither it nor any other block.
  await expect(page.locator(`[data-date="${key}"]`)).toHaveCount(0);
  await expect(page.getByText("No work blocks this week.")).toBeVisible();

  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.locator(`[data-date="${key}"] .calendar-block`)).toHaveCount(1);

  await page.getByRole("group", { name: "Calendar navigation" }).getByRole("button", { name: "Today" }).click();
  await expect(page.locator(`[data-date="${key}"]`)).toHaveCount(0);
  await expect(page.getByText("No work blocks this week.")).toBeVisible();
});

test("at a phone viewport the calendar shows one day and steps to the next day's blocks", async ({ page }) => {
  const email = newEmail("calendar-phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, email);
  await openCalendar(page);

  const today = localDateKey(new Date());
  const tomorrow = dayKey(1);

  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${today}T09:00`);
  await page.getByLabel("End", { exact: true }).fill(`${today}T10:00`);
  await page.getByRole("button", { name: "Add block" }).click();

  // One day column is rendered, and it is today's.
  await expect(page.locator(".calendar-day")).toHaveCount(1);
  await expect(page.locator(`[data-date="${today}"] .calendar-block`)).toHaveCount(1);
  await expect(page.locator(`[data-date="${tomorrow}"]`)).toHaveCount(0);

  // Stepping to the next day keeps one column and moves the view to tomorrow,
  // so today's block is out of view rather than sitting beside it as column two.
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.locator(".calendar-day")).toHaveCount(1);
  await expect(page.locator(`[data-date="${tomorrow}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-date="${today}"]`)).toHaveCount(0);
});

test("a block with an unacknowledged write is marked pending until it is acknowledged", async ({ page, context }) => {
  const email = newEmail("block-pending");
  await signUp(page, email);
  await openCalendar(page);
  await expect(page.getByText("No work blocks this week.")).toBeVisible();

  // Take the browser offline so the queued write cannot be acknowledged yet.
  // The pending state is then stable for as long as we hold the line down,
  // instead of a millisecond race against the emulator's acknowledgement.
  await context.setOffline(true);

  const day = localDateKey(new Date());
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${day}T09:00`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T10:00`);
  await page.getByRole("button", { name: "Add block" }).click();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toHaveClass(/calendar-block-pending/);

  // Reconnecting lets the server acknowledge the write, which clears the mark.
  await context.setOffline(false);
  await expect(block).not.toHaveClass(/calendar-block-pending/, { timeout: 30_000 });
});

/** Wall-clock date and HH:MM parts of an instant in a named IANA zone (Node side). */
function wallClockIn(date: Date, timeZone: string): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  return { date: `${year}-${pad(month)}-${pad(day)}`, time: `${pad(hour)}:${pad(minute)}` };
}

test.describe("profile timezone (I6b)", () => {
  // The decisive precondition: the browser zone differs from the profile zone,
  // so any browser-local rendering fails these tests.
  test.use({ timezoneId: "Asia/Tokyo" });

  test("the grid renders a block in the profile timezone, not the browser timezone", async ({ page }) => {
    const email = newEmail("tz-profile");
    const profileZone = "America/Sao_Paulo";
    expect("Asia/Tokyo").not.toEqual(profileZone);

    // 23:30-03:00 is 11:30 the *next* day in Asia/Tokyo, so the two zones
    // disagree on both the day column and the wall time.
    const day = wallClockIn(new Date(), profileZone).date;
    const start = `${day}T23:30:00-03:00`;
    const end = `${day}T23:45:00-03:00`;
    await seedProfileAndBlock(email, profileZone, start, end);

    await signInAs(page, email);
    await openCalendar(page);

    await expect(page.getByText(`Times in ${profileZone}`)).toBeVisible();
    const block = page.locator(`[data-date="${day}"] .calendar-block`);
    await expect(block).toHaveCount(1);
    await expect(block).toContainText(wallClockIn(new Date(start), profileZone).time);
    await expect(block).toHaveAttribute("data-start", start);
    // the browser zone would place this instant on a different day column
    const browserDay = wallClockIn(new Date(start), "Asia/Tokyo").date;
    expect(browserDay).not.toEqual(day);
    await expect(page.locator(`[data-date="${browserDay}"] .calendar-block`)).toHaveCount(0);
  });

  test("changing the stored profile zone changes the rendered wall time of the same instant", async ({ page }) => {
    const email = newEmail("tz-change");
    const firstZone = "America/Sao_Paulo";
    const day = wallClockIn(new Date(), firstZone).date;
    const start = `${day}T10:00:00-03:00`;
    const end = `${day}T10:45:00-03:00`;
    await seedProfileAndBlock(email, firstZone, start, end);

    await signInAs(page, email);
    await openCalendar(page);

    const block = page.locator(`[data-date="${day}"] .calendar-block`);
    await expect(block).toHaveCount(1);
    await expect(block).toContainText(wallClockIn(new Date(start), firstZone).time);
    await expect(block).toHaveAttribute("data-start", start);

    const nextZone = "Europe/Madrid";
    await updateRemoteProfile(email, nextZone);

    // Wait until the new zone has actually reached the surface before deciding
    // whether the visible week moved with it. Snapshotting the week before the
    // update lands races the propagation: the old week still holds the block,
    // the step below is skipped, and the update then hides the column. The
    // final assertions below still require the block with the new wall time.
    await expect(page.getByText(`Times in ${nextZone}`)).toBeVisible();

    // Switching zones can also roll the visible week: Madrid is five hours
    // ahead of São Paulo, so for part of every day it is already on the next
    // calendar date and the week moves with it, hiding the column that holds
    // the stored instant. Step back to it before asserting, otherwise this
    // test fails during a window that shifts with the time of day. The final
    // assertions still require the block to be there with the new wall time,
    // so a block that genuinely vanished cannot pass through this step.
    const dayColumn = page.locator(`[data-date="${day}"] .calendar-block`);
    if ((await dayColumn.count()) === 0) {
      await page.getByRole("button", { name: "Previous week" }).click();
    }

    // Same stored instant, same instant in the data, but the wall label
    // follows the newly stored zone, without any browser reload.
    await expect(dayColumn).toHaveCount(1);
    await expect(dayColumn).toContainText(wallClockIn(new Date(start), nextZone).time);
    await expect(dayColumn).toHaveAttribute("data-start", start);
    await expect(page.getByText(`Times in ${nextZone}`)).toBeVisible();
  });
});

test.describe("current day highlight", () => {
  // Pacific/Midway (UTC-11) and Pacific/Kiritimati (UTC+14) are 25 hours
  // apart, so their calendar dates can never coincide. A browser-zone
  // implementation would highlight a different column than the profile-zone
  // one, which makes the assertion decisive at any hour.
  test.use({ timezoneId: "Pacific/Midway" });

  test("the highlighted column is the profile-zone today, not the browser today", async ({ page }) => {
    const email = newEmail("tz-today");
    const profileZone = "Pacific/Kiritimati";
    await createRemoteAccount(email);
    await updateRemoteProfile(email, profileZone);

    await signInAs(page, email);
    await openCalendar(page);

    const profileToday = wallClockIn(new Date(), profileZone).date;
    const browserToday = wallClockIn(new Date(), "Pacific/Midway").date;
    expect(profileToday).not.toEqual(browserToday);

    await expect(page.locator(".calendar-day-today")).toHaveCount(1);
    await expect(page.locator(`[data-date="${profileToday}"]`)).toHaveClass(/calendar-day-today/);
  });
});

test("a clean account creates the profile on first use and renders the planner in it", async ({ page }) => {
  const email = newEmail("tz-init");
  await signUp(page, email);

  // The profile document must appear on the server, holding a valid IANA zone.
  let profile: { timeZone?: string } = {};
  await expect
    .poll(async () => {
      profile = await readRemoteProfile(email);
      return profile.timeZone ?? "";
    }, { timeout: 15_000, intervals: [250, 500, 1_000] })
    .not.toBe("");
  const zone = profile.timeZone!;
  // The same validity rule the profile layer enforces: Intl must be able to
  // format with the zone. (The host zone can legitimately be "UTC", which
  // Intl.supportedValuesOf does not list.)
  expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();

  await openCalendar(page);
  await expect(page.getByText(`Times in ${zone}`)).toBeVisible();

  // A form-created block renders in the profile (= browser) zone.
  const day = wallClockIn(new Date(), zone).date;
  await revealBlockForm(page);
  await page.getByLabel("Start", { exact: true }).fill(`${day}T09:30`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T10:15`);
  await page.getByRole("button", { name: "Add block" }).click();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("09:30");
  const stored = await expectSingleRemoteBlock(email);
  expect(new Date(stored.start).getTime()).toBe(new Date(`${day}T09:30:00`).getTime());
});


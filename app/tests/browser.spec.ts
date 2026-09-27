import { expect, test, type Page } from "@playwright/test";
import { password, readRemoteBlocks, readRemoteCompletions, readRemoteProfile, readRemoteSeries, readRemoteState, readRemoteTasks, createRemoteAccount, seedProfileAndBlock, seedTaskAndBlock, updateRemoteProfile } from "./browser-helpers.ts";

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

/** Signs an existing (remotely seeded) account in through the browser form. */
async function signInAs(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

/** Awaits server-side propagation of a write, then asserts the exact remote state. */
async function expectRemoteTasks(email: string, expected: unknown[]) {
  await expect
    .poll(() => readRemoteTasks(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual(expected);
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Add task" })).toBeVisible();
}

test("walking skeleton: account creation, truthful Home counts, and navigation", async ({ page }) => {
  const email = `walk-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const start = "2026-03-02T09:00:00-03:00";

  await signUp(page, email);

  await expect(page.getByText("No tasks and no work blocks yet")).toBeVisible();

  await seedTaskAndBlock(email, "Skeleton task", start, "2026-03-02T10:00:00-03:00");
  await expect(page.locator('[data-stat="open"] .stat-card-value')).toHaveText("1");

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Add task" })).toBeVisible();
  await nav.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByText("planner timezone")).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.locator('[data-stat="open"] .stat-card-value')).toHaveText("1", { timeout: 30_000 });
  const remote = await readRemoteState(email);
  expect(remote).toEqual({ taskTitles: ["Skeleton task"], blockStarts: [start] });
});

test("Home cards show counts that match the seeded planner state", async ({ page }) => {
  const email = newEmail("home-cards");
  await signUp(page, email);

  // An empty planner stays calm: one sentence, no dashboard of zeroes.
  await expect(page.getByText("No tasks and no work blocks yet")).toBeVisible();
  await expect(page.locator(".stat-cards")).toHaveCount(0);

  const today = localDateKey(new Date());

  await openTasks(page);
  await addTaskThroughForm(page, "Open task");
  await page.getByLabel("Task title").fill("Due today");
  await page.getByLabel("Deadline").fill(today);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Due today" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
  await addTaskThroughForm(page, "Done task");
  await page.getByRole("checkbox", { name: "Complete: Done task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);

  await addSeriesThroughForm(page, "Weekly habit", "Weekly", futureDateKey(1));

  await openCalendar(page);
  await page.getByLabel("Start", { exact: true }).fill(`${today}T09:00`);
  await page.getByLabel("End", { exact: true }).fill(`${today}T10:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(page.locator(`[data-date="${today}"] .calendar-block`)).toHaveCount(1);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Home" }).click();
  await expect(page.locator('[data-stat="open"] .stat-card-value')).toHaveText("2");
  await expect(page.locator('[data-stat="completed"] .stat-card-value')).toHaveText("1");
  await expect(page.locator('[data-stat="due"] .stat-card-value')).toHaveText("1");
  await expect(page.locator('[data-stat="week"] .stat-card-value')).toHaveText("1");
  await expect(page.locator('[data-stat="series"] .stat-card-value')).toHaveText("1");

  // Every number is a held fact; the planner keeps no history to derive a delta.
  await expect(page.locator(".stat-cards")).not.toContainText("%");
});

test("creating a task with a deadline shows the row and persists it to the server", async ({ page }) => {
  const email = newEmail("create");
  await signUp(page, email);
  await openTasks(page);

  await page.getByLabel("Task title").fill("Write review");
  await page.getByLabel("Deadline").fill("2026-04-01");
  await page.getByRole("button", { name: "Add task" }).click();

  await expect(page.locator(".task-title", { hasText: "Write review" })).toBeVisible();
  await expect(page.locator(".task-deadline", { hasText: "2026-04-01" })).toBeVisible();

  await expectRemoteTasks(email, [{ title: "Write review", completed: false, deadline: "2026-04-01" }]);
});

test("renaming a task persists the new title to the server", async ({ page }) => {
  const email = newEmail("rename");
  await signUp(page, email);
  await openTasks(page);

  await page.getByLabel("Task title").fill("Draft plan");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Draft plan" })).toBeVisible();

  // the row's title button opens the details panel; rename lives there now
  await page.getByRole("button", { name: "Draft plan" }).click();
  await page.getByLabel("Rename task").fill("Final plan");
  await page.getByRole("button", { name: "Save rename" }).click();

  await expect(page.locator(".task-title", { hasText: "Final plan" })).toBeVisible();
  await expect(page.locator(".task-title", { hasText: "Draft plan" })).toHaveCount(0);

  await expectRemoteTasks(email, [{ title: "Final plan", completed: false }]);
});

test("completing and uncompleting a task sets completed on the server", async ({ page }) => {
  const email = newEmail("complete");
  await signUp(page, email);
  await openTasks(page);

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
  await expect(page.locator(".task-deadline", { hasText: "2026-05-10" })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Scheduled task", completed: false, deadline: "2026-05-10" }]);

  // clearing the control removes the field on the server entirely
  await panel.getByLabel("Deadline").fill("");
  await expect(page.locator(".task-deadline")).toHaveCount(0);
  await expectRemoteTasks(email, [{ title: "Scheduled task", completed: false }]);
});

async function addTaskThroughForm(page: Page, title: string) {
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  // the write may still be in flight (busy disables the form); wait for it to
  // settle so a following fill is not wiped by the previous add's reset
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
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

test("the list groups open and completed tasks under counted headings", async ({ page }) => {
  const email = newEmail("groups");
  await signUp(page, email);
  await openTasks(page);

  await addTaskThroughForm(page, "Open task");
  await addTaskThroughForm(page, "Done task");
  await page.getByRole("checkbox", { name: "Complete: Done task" }).click();
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);

  await expect(page.getByRole("heading", { name: "Open (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Completed (1)" })).toBeVisible();
  await expect(page.locator("li.task:not(.completed)", { hasText: "Open task" })).toHaveCount(1);
  await expect(page.locator("li.task.completed", { hasText: "Done task" })).toHaveCount(1);
});

test("an empty title is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("invalid");
  await signUp(page, email);
  await openTasks(page);

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

async function openCalendar(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "Add block" })).toBeVisible();
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
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("Repeat").selectOption({ label: frequency });
  await page.getByLabel("Start date").fill(start);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".series-row", { hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
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
  await expect(row.getByText(`next ${start}`)).toBeVisible();

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
  await expect(panel.locator(".series-occurrences")).toContainText(start);
  await expect(panel.locator(".series-occurrences")).toContainText(second);
  await expect(panel.locator(".series-occurrences")).toContainText(third);
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

test("renaming a series persists the new title to the server", async ({ page }) => {
  const email = newEmail("series-rename");
  await signUp(page, email);
  await openTasks(page);

  await addSeriesThroughForm(page, "Morning walk", "Daily", futureDateKey(1));
  const panel = await openSeriesPanel(page, "Morning walk");
  await panel.getByLabel("Rename series").fill("Evening walk");
  await panel.getByRole("button", { name: "Save rename" }).click();

  await expect(page.locator(".series-row", { hasText: "Evening walk" })).toBeVisible();
  await expect(page.locator(".series-row", { hasText: "Morning walk" })).toHaveCount(0);

  const series = await expectOneRemoteSeries(email);
  expect(series.data.title).toBe("Evening walk");
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

  const series = await expectOneRemoteSeries(email);
  expect(series.data.frequency).toBe("daily");
  expect(series.data.anchorDate).toBe(anchor);
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

  const series = await expectOneRemoteSeries(email);
  expect(series.data.anchorDate).toBe(moved);
  expect(series.data.frequency).toBe("monthly");
});

test("an invalid series edit is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("series-invalid");
  await signUp(page, email);
  await openTasks(page);

  const start = futureDateKey(1);
  await addSeriesThroughForm(page, "Keep me", "Daily", start);
  const panel = await openSeriesPanel(page, "Keep me");

  // an empty title fails domain validation before any write
  await panel.getByLabel("Rename series").fill("");
  await panel.getByRole("button", { name: "Save rename" }).click();
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

test("a block linked to a task shows that task's title", async ({ page }) => {
  const email = newEmail("block-task");
  await signUp(page, email);
  await openTasks(page);
  await page.getByLabel("Task title").fill("Deep work");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Deep work" })).toBeVisible();

  await openCalendar(page);
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
  await page.getByLabel("Start", { exact: true }).fill(`${day}T11:00`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T12:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expectSingleRemoteBlock(email);

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await block.getByRole("button", { name: "Delete" }).click();

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
  await page.getByLabel("Start", { exact: true }).fill(`${key}T08:00`);
  await page.getByLabel("End", { exact: true }).fill(`${key}T09:00`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expectSingleRemoteBlock(email);

  // The block belongs to next week, so today's week shows neither it nor any other block.
  await expect(page.locator(`[data-date="${key}"]`)).toHaveCount(0);
  await expect(page.getByText("No work blocks this week.")).toBeVisible();

  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.locator(`[data-date="${key}"] .calendar-block`)).toHaveCount(1);

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.locator(`[data-date="${key}"]`)).toHaveCount(0);
  await expect(page.getByText("No work blocks this week.")).toBeVisible();
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

    await expect(page.getByText(`Times are shown in the planner timezone (${profileZone}).`)).toBeVisible();
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

    // Same stored instant, same day column, but the wall label follows the
    // newly stored zone, without any browser reload.
    await expect(block).toContainText(wallClockIn(new Date(start), nextZone).time);
    await expect(block).toHaveAttribute("data-start", start);
    await expect(page.getByText(`Times are shown in the planner timezone (${nextZone}).`)).toBeVisible();
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
  await expect(page.getByText(`Times are shown in the planner timezone (${zone}).`)).toBeVisible();

  // A form-created block renders in the profile (= browser) zone.
  const day = wallClockIn(new Date(), zone).date;
  await page.getByLabel("Start", { exact: true }).fill(`${day}T09:30`);
  await page.getByLabel("End", { exact: true }).fill(`${day}T10:15`);
  await page.getByRole("button", { name: "Add block" }).click();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("09:30");
  const stored = await expectSingleRemoteBlock(email);
  expect(new Date(stored.start).getTime()).toBe(new Date(`${day}T09:30:00`).getTime());
});


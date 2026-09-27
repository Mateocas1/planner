import { expect, test, type Page } from "@playwright/test";
import { password, readRemoteBlocks, readRemoteState, readRemoteTasks, seedTaskAndBlock } from "./browser-helpers.ts";

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
  await expect(page.getByText("Tasks: 1")).toBeVisible();
  await expect(page.getByText("Work blocks: 1")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Add task" })).toBeVisible();
  await nav.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByText("local timezone")).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByText("Tasks: 1")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Work blocks: 1")).toBeVisible();
  const remote = await readRemoteState(email);
  expect(remote).toEqual({ taskTitles: ["Skeleton task"], blockStarts: [start] });
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

  await page.getByRole("button", { name: "Rename Draft plan" }).click();
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

  await page.getByRole("button", { name: "Complete Solo task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Uncomplete Solo task", exact: true })).toBeVisible();
  // the completed task stays listed and is visually distinguished
  await expect(page.locator("li.task.completed", { hasText: "Solo task" })).toHaveCount(1);
  await expectRemoteTasks(email, [{ title: "Solo task", completed: true }]);

  await page.getByRole("button", { name: "Uncomplete Solo task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Complete Solo task", exact: true })).toBeVisible();
  await expectRemoteTasks(email, [{ title: "Solo task", completed: false }]);
});

test("deleting a task removes the row and the server document", async ({ page }) => {
  const email = newEmail("delete");
  await signUp(page, email);
  await openTasks(page);

  await page.getByLabel("Task title").fill("Doomed task");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: "Doomed task" })).toBeVisible();

  await page.getByRole("button", { name: "Delete Doomed task" }).click();

  await expect(page.locator(".task-title", { hasText: "Doomed task" })).toHaveCount(0);
  await expectRemoteTasks(email, []);
});

test("an empty title is refused with a visible error and writes nothing", async ({ page }) => {
  const email = newEmail("invalid");
  await signUp(page, email);
  await openTasks(page);

  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert")).toContainText("task title is required");
  await expectRemoteTasks(email, []);
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

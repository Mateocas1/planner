import { expect, test, type Page } from "@playwright/test";
import { password, readRemoteState, readRemoteTasks, seedTaskAndBlock } from "./browser-helpers.ts";

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
  await expect(page.getByText("arrives in increment I3")).toBeVisible();

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

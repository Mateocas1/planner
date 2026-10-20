import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

test.setTimeout(60_000);

const newEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

async function signUp(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

async function addTask(page: Page, title: string) {
  // wait out a sheet that is still submitting or playing its exit, exactly like
  // the main suite does, so the next creation is never typed into a closing form
  const sheet = page.getByRole("complementary", { name: "New task" });
  if ((await sheet.count()) > 0) {
    const closing = (await sheet.getAttribute("data-state")) === "closing";
    const submitting = await sheet.getByRole("button", { name: "Add task" }).isDisabled().catch(() => false);
    if (closing || submitting) await expect(sheet).toHaveCount(0);
  }
  const add = page.getByRole("button", { name: "Add task" });
  if (!(await add.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(add).toBeVisible();
  }
  await page.getByLabel("Task title").fill(title);
  await add.click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  // the sheet returns focus to "New task" only when its exit finishes; wait for
  // that, or a check clicked right after would lose focus to it mid-travel
  await expect(sheet).toHaveCount(0);
}

/** The counted section for one task group (Open or Completed). */
const groupOf = (page: Page, label: "Open" | "Completed") =>
  page.locator("section.task-group").filter({ has: page.getByRole("heading", { name: new RegExp(`^${label} `) }) });

/**
 * Samples the transform of the row carrying `title` on every frame for `ms`,
 * so the test can tell a row that travels (some matrix mid-flight) from one
 * that is simply replaced (always "none"). It re-resolves the node each frame
 * because the traveling row lands in a different list, on a different node.
 */
async function sampleTransforms(page: Page, title: string, ms: number): Promise<string[]> {
  return page.evaluate(
    async ({ title, ms }) => {
      const seen = new Set<string>();
      const until = performance.now() + ms;
      while (performance.now() < until) {
        const row = [...document.querySelectorAll("li.task")].find(node => node.textContent?.includes(title));
        if (row) seen.add(getComputedStyle(row).transform);
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      }
      return [...seen];
    },
    { title, ms },
  );
}

test("completing a task travels its row into Completed and keeps focus on the check", async ({ page }) => {
  await signUp(page, newEmail("travel"));
  await openTasks(page);
  await addTask(page, "Travel task");
  await addTask(page, "Neighbour task");

  const check = page.getByRole("checkbox", { name: "Complete: Travel task" });
  await check.click();
  const seen = await sampleTransforms(page, "Travel task", 700);

  // the row ends in Completed with its neighbour left behind
  await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Travel task" })).toHaveCount(1);
  await expect(groupOf(page, "Open").locator("li.task", { hasText: "Travel task" })).toHaveCount(0);
  await expect(groupOf(page, "Open").locator("li.task", { hasText: "Neighbour task" })).toHaveCount(1);

  // it travelled: a transform was applied mid-flight, and only a translation
  // (matrix 1,0,0,1,...) is allowed, so no text is ever scaled
  const travelled = seen.filter(value => value !== "none");
  expect(travelled.length).toBeGreaterThan(0);
  for (const value of travelled) expect(value.startsWith("matrix(1, 0, 0, 1,")).toBe(true);

  // the same control still owns focus after the row changed parents
  await expect(page.getByRole("checkbox", { name: "Reopen: Travel task" })).toBeFocused();
});

test("reopening a task travels its row back into Open", async ({ page }) => {
  await signUp(page, newEmail("travel-back"));
  await openTasks(page);
  await addTask(page, "Back task");
  await page.getByRole("checkbox", { name: "Complete: Back task" }).click();
  await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Back task" })).toHaveCount(1);

  await page.getByRole("checkbox", { name: "Reopen: Back task" }).click();
  await expect(groupOf(page, "Open").locator("li.task", { hasText: "Back task" })).toHaveCount(1);
  await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Back task" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Complete: Back task" })).toBeFocused();
});

test("the completion wash plays once, on the row that lands in Completed", async ({ page }) => {
  await signUp(page, newEmail("wash-once"));
  await openTasks(page);
  await addTask(page, "Wash task");

  // count every wash start and end on the document, so a restart on the
  // travelling node cannot hide behind a single final class check
  await page.evaluate(() => {
    const washes = { starts: 0, ends: 0 };
    (window as unknown as { washes: typeof washes }).washes = washes;
    document.addEventListener("animationstart", event => {
      if (event.animationName === "task-wash") washes.starts += 1;
    });
    document.addEventListener("animationend", event => {
      if (event.animationName === "task-wash") washes.ends += 1;
    });
  });
  const washes = () =>
    page.evaluate(() => (window as unknown as { washes: { starts: number; ends: number } }).washes);

  await page.getByRole("checkbox", { name: "Complete: Wash task" }).click();
  await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Wash task" })).toHaveCount(1);
  await expect.poll(async () => (await washes()).ends).toBe(1);

  expect((await washes()).starts).toBe(1);
});

test("a row landing under an open panel never takes the focus back", async ({ page }) => {
  await signUp(page, newEmail("travel-focus-panel"));
  await openTasks(page);
  await addTask(page, "Beat focus task");

  // Complete, then open the same row inside the beat: it is still where the
  // check is, so the panel grows out of it while the completion is in flight.
  await page.getByRole("checkbox", { name: "Complete: Beat focus task" }).click();
  await page.getByRole("button", { name: "Beat focus task" }).click();

  const panel = page.getByRole("complementary", { name: "Task details" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toBeFocused();

  // The row lands in Completed while the panel is open. The check that travelled
  // must not pull the caret out of the field the user just opened.
  await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Beat focus task" })).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(panel.getByLabel("Rename task")).toBeFocused();
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the row changes group without any transform", async ({ page }) => {
    await signUp(page, newEmail("travel-reduce"));
    await openTasks(page);
    await addTask(page, "Still task");

    await page.getByRole("checkbox", { name: "Complete: Still task" }).click();
    const seen = await sampleTransforms(page, "Still task", 500);

    await expect(groupOf(page, "Completed").locator("li.task", { hasText: "Still task" })).toHaveCount(1);
    expect(seen).toEqual(["none"]);
  });
});

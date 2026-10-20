import { expect, test, type Locator, type Page } from "@playwright/test";
import { password, readRemoteBlocks, seedTaskAndBlock } from "./browser-helpers.ts";

test.setTimeout(60_000);

const hourPx = 52;
const halfHourPx = hourPx / 2;
const minuteMs = 60_000;

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

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

async function openTasks(page: Page) {
  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

async function openCalendar(page: Page) {
  await nav(page).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
}

/** Creates a task through the New task sheet and waits for its row. */
async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

function localDateKey(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Epoch of a browser-local wall time (the profile zone equals the browser zone). */
function localEpoch(day: string, time: string) {
  return new Date(`${day}T${time}:00`).getTime();
}

/** The task id from the grip rendered for it, which is what a carry starts from. */
async function gripId(page: Page, scope: Locator, title: string): Promise<string> {
  const row = scope.filter({ hasText: title }).first();
  const grip = row.locator("[data-drag-task]");
  await expect(grip).toBeVisible();
  return (await grip.getAttribute("data-drag-task"))!;
}

/** Scrolls the grid so 08:00 sits at the top, then waits for the entry animation to settle. */
async function scrollGrid(page: Page) {
  await page.locator(".cal-scroll").evaluate(el => {
    el.scrollTop = 8 * 52;
  });
  const body = page.locator(".calendar-day-body").first();
  let last = "";
  await expect
    .poll(async () => {
      const box = await body.boundingBox();
      const now = JSON.stringify(box);
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
}

/** Viewport y of a wall-clock minute of a day column. */
async function yFor(page: Page, day: string, minute: number) {
  const box = await page.locator(`[data-date="${day}"] .calendar-day-body`).boundingBox();
  expect(box).not.toBeNull();
  return box!.y + (minute / 60) * hourPx;
}

async function xFor(page: Page, day: string) {
  const box = await page.locator(`[data-date="${day}"] .calendar-day-body`).boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width / 2;
}

async function pressOn(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
}

async function expectRemoteBlockCount(email: string, count: number) {
  await expect
    .poll(async () => (await readRemoteBlocks(email)).length, { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toBe(count);
}

/** Signs up, seeds one 10:00-11:00 block for today and lands on the settled Calendar. */
async function seededCalendar(page: Page, prefix: string) {
  const email = newEmail(prefix);
  await signUp(page, email);
  const day = localDateKey(new Date());
  await seedTaskAndBlock(email, "Seed task", `${day}T10:00:00+00:00`, `${day}T11:00:00+00:00`);
  await openCalendar(page);
  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await scrollGrid(page);
  // Wait out the block's own mount animation so geometry reads are stable.
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await block.boundingBox());
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return { email, day, block };
}

async function expectRemoteTimes(email: string, start: number, end: number) {
  await expect
    .poll(
      async () => {
        const [remote] = await readRemoteBlocks(email);
        return remote ? [Date.parse(remote.start), Date.parse(remote.end)] : null;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toEqual([start, end]);
}

async function dragEdge(page: Page, block: Locator, edge: "start" | "end", dy: number) {
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = edge === "end" ? box!.y + box!.height - 3 : box!.y + 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
}

test("dragging a task from the Unscheduled tray onto the grid creates one linked block on the snapped slot", async ({ page }) => {
  const email = newEmail("manip-tray");
  await signUp(page, email);
  await openTasks(page);
  await addTask(page, "Tray task");
  await openCalendar(page);
  await scrollGrid(page);
  const taskId = await gripId(page, page.locator(".tray-item"), "Tray task");

  const day = localDateKey(new Date());
  const grip = page.locator(`.tray [data-drag-task="${taskId}"]`);
  await expect(grip).toBeVisible();
  await pressOn(page, grip);
  // 10:07 is off the step and must snap to 10:00.
  const x = await xFor(page, day);
  const y = await yFor(page, day, 10 * 60 + 7);
  await page.mouse.move(x, y, { steps: 8 });

  await expect(page.locator("[data-drag-ghost]")).toBeVisible();
  await expect(page.locator("[data-drop-preview]")).toBeVisible();
  await page.mouse.up();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Tray task");
  await expect(block).toHaveClass(/cat-task/);
  await expect(page.locator("[data-drag-ghost]")).toHaveCount(0);
  await expect(page.locator("[data-drop-preview]")).toHaveCount(0);
  await expect(page.locator("[data-calendar-status]")).toContainText("Planned Tray task");

  await expectRemoteBlockCount(email, 1);
  const [remote] = await readRemoteBlocks(email);
  expect(remote.taskId).toBe(taskId);
  expect(Date.parse(remote.start)).toBe(localEpoch(day, "10:00"));
  expect(Date.parse(remote.end)).toBe(localEpoch(day, "11:00"));
});

test("dragging a task from the Tasks list onto the Calendar nav item switches view and the drop creates the linked block", async ({ page }) => {
  const email = newEmail("manip-cross");
  await signUp(page, email);
  await openTasks(page);
  await addTask(page, "Carried task");
  const taskId = await gripId(page, page.locator("li.task"), "Carried task");

  const grip = page.locator(`li.task [data-drag-task="${taskId}"]`);
  await pressOn(page, grip);
  const navBox = await nav(page).getByRole("button", { name: "Calendar" }).boundingBox();
  expect(navBox).not.toBeNull();
  await page.mouse.move(navBox!.x + navBox!.width / 2, navBox!.y + navBox!.height / 2, { steps: 8 });

  // The view switched, the carry did not end.
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
  await expect(page.locator("li.task")).toHaveCount(0);
  await expect(page.locator("[data-drag-ghost]")).toBeVisible();
  await scrollGrid(page);

  const day = localDateKey(new Date());
  await page.mouse.move(await xFor(page, day), await yFor(page, day, 10 * 60 + 7), { steps: 8 });
  await expect(page.locator("[data-drop-preview]")).toBeVisible();
  await page.mouse.up();

  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Carried task");
  await expect(page.locator("[data-drag-ghost]")).toHaveCount(0);

  await expectRemoteBlockCount(email, 1);
  const [remote] = await readRemoteBlocks(email);
  expect(remote.taskId).toBe(taskId);
  expect(Date.parse(remote.start)).toBe(localEpoch(day, "10:00"));
  expect(Date.parse(remote.end)).toBe(localEpoch(day, "11:00"));
});

test("Escape cancels a carry: the ghost and preview go away and nothing is written", async ({ page }) => {
  const email = newEmail("manip-cancel");
  await signUp(page, email);
  await openTasks(page);
  await addTask(page, "Cancelled task");
  await openCalendar(page);
  await scrollGrid(page);
  const taskId = await gripId(page, page.locator(".tray-item"), "Cancelled task");

  const day = localDateKey(new Date());
  await pressOn(page, page.locator(`.tray [data-drag-task="${taskId}"]`));
  await page.mouse.move(await xFor(page, day), await yFor(page, day, 10 * 60), { steps: 8 });
  await expect(page.locator("[data-drag-ghost]")).toBeVisible();
  await expect(page.locator("[data-drop-preview]")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-drag-ghost]")).toHaveCount(0);
  await expect(page.locator("[data-drop-preview]")).toHaveCount(0);

  await page.mouse.up();
  await expect(page.locator(".calendar-block")).toHaveCount(0);
  // Give a wrongly committed write time to reach the server before asserting absence.
  await page.waitForTimeout(1_000);
  expect(await readRemoteBlocks(email)).toEqual([]);
});

test("dragging the bottom edge by 30 minutes moves the end, keeps the start and persists", async ({ page }) => {
  const { email, day, block } = await seededCalendar(page, "manip-end");
  const start = localEpoch(day, "10:00");
  const end = localEpoch(day, "11:00");
  const before = await block.getAttribute("data-start");

  await dragEdge(page, block, "end", halfHourPx);
  await expect(block).toHaveAttribute("data-resizing", "end");
  await page.mouse.up();

  await expect(block).toContainText("10:00–11:30");
  await expect(block).not.toHaveAttribute("data-resizing", /.*/);
  // The release lands past the block's old edge, over the day column: it must
  // be read as the end of the resize, not as an empty-slot click.
  await expect(page.getByRole("complementary", { name: "New block" })).toHaveCount(0);
  expect(await block.getAttribute("data-start")).toBe(before);
  await expect.poll(async () => Date.parse((await block.getAttribute("data-end"))!)).toBe(end + 30 * minuteMs);
  expect(Date.parse((await block.getAttribute("data-start"))!)).toBe(start);
  await expectRemoteTimes(email, start, end + 30 * minuteMs);
});

test("dragging the top edge by 30 minutes moves the start, keeps the end and persists", async ({ page }) => {
  const { email, day, block } = await seededCalendar(page, "manip-start");
  const start = localEpoch(day, "10:00");
  const end = localEpoch(day, "11:00");
  const before = await block.getAttribute("data-end");

  await dragEdge(page, block, "start", halfHourPx);
  await expect(block).toHaveAttribute("data-resizing", "start");
  await page.mouse.up();

  await expect(block).toContainText("10:30–11:00");
  expect(await block.getAttribute("data-end")).toBe(before);
  await expect.poll(async () => Date.parse((await block.getAttribute("data-start"))!)).toBe(start + 30 * minuteMs);
  expect(Date.parse((await block.getAttribute("data-end"))!)).toBe(end);
  await expectRemoteTimes(email, start + 30 * minuteMs, end);
});

test("resizing moves the edge without distorting the content", async ({ page }) => {
  const { block } = await seededCalendar(page, "manip-distort");
  const title = block.locator("b");

  const measure = () =>
    block.evaluate(el => {
      const b = el.querySelector("b")!;
      return {
        fontSize: getComputedStyle(el).fontSize,
        titleFontSize: getComputedStyle(b).fontSize,
        titleWidth: b.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        transform: getComputedStyle(el).transform,
      };
    });
  const before = await measure();
  await expect(title).toBeVisible();

  await dragEdge(page, block, "end", halfHourPx);
  await expect(block).toHaveAttribute("data-resizing", "end");
  const during = await measure();

  expect(during.fontSize).toBe(before.fontSize);
  expect(during.titleFontSize).toBe(before.titleFontSize);
  expect(during.titleWidth).toBeCloseTo(before.titleWidth, 1);
  expect(during.height).toBeGreaterThan(before.height + 10);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(during.transform);

  await page.mouse.up();
});

test("Escape while resizing restores the stored geometry and writes nothing", async ({ page }) => {
  const { email, day, block } = await seededCalendar(page, "manip-escape");
  const start = localEpoch(day, "10:00");
  const end = localEpoch(day, "11:00");
  const startAttr = await block.getAttribute("data-start");
  const endAttr = await block.getAttribute("data-end");
  const heightBefore = (await block.boundingBox())!.height;

  await dragEdge(page, block, "end", halfHourPx);
  await expect(block).toHaveAttribute("data-resizing", "end");
  expect((await block.boundingBox())!.height).toBeGreaterThan(heightBefore + 10);

  await page.keyboard.press("Escape");
  await expect(block).not.toHaveAttribute("data-resizing", /.*/);
  expect(await block.getAttribute("data-start")).toBe(startAttr);
  expect(await block.getAttribute("data-end")).toBe(endAttr);

  await page.mouse.up();
  await expect.poll(async () => (await block.boundingBox())!.height).toBeCloseTo(heightBefore, 0);
  await expect(block).toContainText("10:00–11:00");
  await page.waitForTimeout(1_000);
  await expectRemoteTimes(email, start, end);
  expect(await block.getAttribute("data-end")).toBe(endAttr);
});

test("Shift+Arrow resizes the end by one step, persists each press and stops at the minimum", async ({ page }) => {
  const { email, day, block } = await seededCalendar(page, "manip-keys");
  const start = localEpoch(day, "10:00");
  const end = localEpoch(day, "11:00");

  await block.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expectRemoteTimes(email, start, end + 30 * minuteMs);
  await expect(block).toContainText("10:00–11:30");
  await expect(page.locator("[data-calendar-status]")).toContainText("10:00–11:30");

  await page.keyboard.press("Shift+ArrowUp");
  await expectRemoteTimes(email, start, end);
  await expect(block).toContainText("10:00–11:00");

  // Shrink past the minimum: 60 → 30 minutes, then further presses change nothing.
  await page.keyboard.press("Shift+ArrowUp");
  await expectRemoteTimes(email, start, start + 30 * minuteMs);
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForTimeout(1_000);
  const [remote] = await readRemoteBlocks(email);
  expect(Date.parse(remote.end) - Date.parse(remote.start)).toBe(30 * minuteMs);
  expect(Date.parse(remote.start)).toBe(start);
  await expect(block).toContainText("10:00–10:30");
});

test("a block that ends on another day is not resizable, so a clipped end is never persisted", async ({ page }) => {
  const email = newEmail("manip-crossday");
  await signUp(page, email);
  const day = localDateKey(new Date());
  const nextDay = localDateKey(new Date(Date.now() + 86_400_000));
  // 23:00-02:00 renders clipped at midnight in today's column (the D3 limit).
  await seedTaskAndBlock(email, "Overnight", `${day}T23:00:00+00:00`, `${nextDay}T02:00:00+00:00`);
  await openCalendar(page);
  const block = page.locator(`[data-date="${day}"] .calendar-block`);
  await expect(block).toHaveCount(1);
  const endAttr = await block.getAttribute("data-end");

  // No edge handles, and the keyboard path leaves it alone: persisting the
  // clipped midnight would destroy the real end of the block.
  await expect(block.locator(".block-handle")).toHaveCount(0);
  await block.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(1_000);
  expect(await block.getAttribute("data-end")).toBe(endAttr);
  const blocks = await readRemoteBlocks(email);
  expect(blocks).toHaveLength(1);
  expect(Date.parse(blocks[0].end)).toBe(Date.parse(`${nextDay}T02:00:00Z`));
  expect(Date.parse(blocks[0].start)).toBe(Date.parse(`${day}T23:00:00Z`));
});

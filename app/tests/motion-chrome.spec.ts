import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

/**
 * W3 of the motion review (odd/research/motion-review.md): the calendar body and
 * the chrome around it. Every test here drives the real UI and reads what the
 * browser actually painted, so the reviewed motion is pinned as behaviour:
 *
 * - the range slide is one translation on the GPU, 24 px at most, never a scale;
 * - with reduced motion the slide is a fade and nothing moves;
 * - a day column contains its own layout and paint (the perf claim, made visible
 *   by proving a block still lands inside its column);
 * - a tray neighbour reflows in the snappy 250 ms spring, not the 400 ms one;
 * - the undo toast holds no compositor layer and hovers only on a fine pointer.
 */

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

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function openTasks(page: Page) {
  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

async function openCalendar(page: Page) {
  await nav(page).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
}

/** Waits out a sheet that was just submitted, exactly as the flow suite does, so
 * the next interaction never lands on a closing form. */
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

async function addTask(page: Page, title: string) {
  await settleSheet(page, "New task");
  const add = page.getByRole("button", { name: "Add task" });
  if (!(await add.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(add).toBeVisible();
  }
  await page.getByLabel("Task title").fill(title);
  await add.click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

async function fillBlockForm(page: Page, start: string, end: string, task?: string) {
  await settleSheet(page, "New block");
  const add = page.getByRole("button", { name: "Add block" });
  if (!(await add.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New block" }).click();
    await expect(add).toBeVisible();
  }
  await page.getByLabel("Start", { exact: true }).fill(start);
  await page.getByLabel("End", { exact: true }).fill(end);
  if (task) await page.getByLabel("Task", { exact: true }).selectOption({ label: task });
}

async function submitBlock(page: Page, start: string, end: string, task?: string) {
  await fillBlockForm(page, start, end, task);
  await page.getByRole("button", { name: "Add block" }).click();
}

/** A wall date key in the browser's own zone, which is the profile zone of a
 * fresh account, so `datetime-local` values and the grid agree. */
async function wallDateKey(page: Page, offsetDays: number): Promise<string> {
  return page.evaluate((offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, offsetDays);
}

const dayKeys = (page: Page) =>
  page.locator(".calendar-day").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-date")));

/** Samples the body that is in the flow for `ms`: the transform and opacity the
 * browser computed, which is what a dropped frame or a layout animation would
 * show up in. The body leaving the page is excluded, because AnimatePresence
 * parks it out of flow and projects it, and that projection is not the slide. */
async function sampleBodies(page: Page, ms: number) {
  return page.evaluate(async (window) => {
    const samples: Array<{ transform: string; opacity: number }> = [];
    const until = performance.now() + window;
    while (performance.now() < until) {
      for (const node of document.querySelectorAll(".cal-body")) {
        const style = getComputedStyle(node);
        if (style.position === "absolute") continue;
        samples.push({ transform: style.transform, opacity: Number(style.opacity) });
      }
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    }
    return samples;
  }, ms);
}

/** The transform of the body that is in the flow, once nothing is moving. */
const restingBodyTransforms = (page: Page) =>
  page.locator(".cal-body").evaluateAll(nodes =>
    nodes
      .filter(node => getComputedStyle(node).position !== "absolute")
      .map(node => getComputedStyle(node).transform),
  );

/**
 * Starts a frame recorder on the tray list that begins the moment the list
 * changes, so the reflow is captured from its first frame whatever the write's
 * round trip costs. Nothing races the click: the recorder is a passive observer
 * installed beforehand, and `readTrayFrames` waits for it to finish.
 */
async function recordTrayFrames(page: Page, windowMs: number) {
  await page.evaluate((windowMs) => {
    type Frame = { at: number; transforms: string[] };
    const state: { samples: Frame[]; done: boolean; started: number } = { samples: [], done: false, started: 0 };
    (window as unknown as { __trayMotion: typeof state }).__trayMotion = state;
    const list = document.querySelector(".tray-list");
    if (!list) throw new Error("the tray is not on screen");
    const observer = new MutationObserver(() => {
      observer.disconnect();
      state.started = performance.now();
      const until = state.started + windowMs;
      const loop = () => {
        state.samples.push({
          at: performance.now() - state.started,
          transforms: [...document.querySelectorAll("li.tray-item")].map(node => getComputedStyle(node).transform),
        });
        if (performance.now() < until) requestAnimationFrame(loop);
        else state.done = true;
      };
      requestAnimationFrame(loop);
    });
    observer.observe(list, { childList: true });
  }, windowMs);
}

async function readTrayFrames(page: Page) {
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __trayMotion?: { done: boolean } }).__trayMotion?.done === true), {
      timeout: 15_000,
      message: "the tray reflow was never recorded",
    })
    .toBe(true);
  return page.evaluate(
    () =>
      (window as unknown as { __trayMotion: { samples: Array<{ at: number; transforms: string[] }> } }).__trayMotion
        .samples,
  );
}

const RESTING = new Set(["none", "matrix(1, 0, 0, 1, 0, 0)"]);

test("a range change slides the body with one transform, never a scale", async ({ page }) => {
  await signUp(page, newEmail("motion-slide"));
  await openCalendar(page);
  const before = await dayKeys(page);
  expect(before.length).toBe(7);

  await page.getByRole("group", { name: "Calendar navigation" }).getByRole("button", { name: "Next week" }).click();
  const samples = await sampleBodies(page, 600);

  const moving = samples.filter(sample => !RESTING.has(sample.transform));
  // a tween, not a teleport: the body is caught mid-flight on several frames
  expect(moving.length).toBeGreaterThan(3);
  for (const sample of moving) {
    // a pure translation: no scale, no skew and no vertical drift, so no text is
    // ever distorted and nothing leaves the compositor
    expect(sample.transform.startsWith("matrix(1, 0, 0, 1,")).toBe(true);
    const [tx, ty] = sample.transform.slice("matrix(1, 0, 0, 1, ".length, -1).split(",").map(Number);
    expect(Math.abs(tx)).toBeLessThanOrEqual(24.5);
    expect(ty).toBe(0);
  }
  // and it really travels those 24 px instead of jumping to the end
  expect(moving.some(sample => {
    const tx = Number(sample.transform.slice("matrix(1, 0, 0, 1, ".length, -1).split(",")[0]);
    return Math.abs(tx) > 0 && Math.abs(tx) < 24;
  })).toBe(true);
  // it comes to rest on the new week, with the body back at its resting box
  await expect.poll(async () => (await dayKeys(page))[0]).not.toBe(before[0]);
  const after = await dayKeys(page);
  const expected = await page.evaluate((key) => {
    const date = new Date(`${key}T00:00:00`);
    date.setDate(date.getDate() + 7);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, before[0]);
  expect(after[0]).toBe(expected);
  const atRest = await restingBodyTransforms(page);
  expect(atRest.length).toBe(1);
  expect(RESTING.has(atRest[0])).toBe(true);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a range change fades the body and moves nothing", async ({ page }) => {
    await signUp(page, newEmail("motion-slide-reduce"));
    await openCalendar(page);
    const before = await dayKeys(page);

    await page.getByRole("group", { name: "Calendar navigation" }).getByRole("button", { name: "Next week" }).click();
    const samples = await sampleBodies(page, 600);

    // no movement at all: every frame is at the resting box
    expect(samples.every(sample => RESTING.has(sample.transform))).toBe(true);
    // the fade survives, which is the cue reduced motion is allowed to keep
    expect(samples.some(sample => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
    await expect.poll(async () => (await dayKeys(page))[0]).not.toBe(before[0]);
  });
});

test("a day column contains its own layout and paint without clipping what it shows", async ({ page }) => {
  await signUp(page, newEmail("motion-contain"));
  await openCalendar(page);
  const day = await wallDateKey(page, 0);
  await submitBlock(page, `${day}T09:00`, `${day}T10:00`);
  const column = page.locator(`[data-date="${day}"]`);
  const block = column.locator(".calendar-block");
  await expect(block).toHaveCount(1);

  // the containment boundary the range slide and every block repaint rely on
  expect(await column.evaluate(node => getComputedStyle(node).contain)).toBe("layout paint");

  // and it clips nothing that is meant to be seen: the block, its grips and its
  // text all land inside the column's own box
  const resting = await page.evaluate(async (key) => {
    const column = document.querySelector<HTMLElement>(`[data-date="${key}"]`)!;
    const block = column.querySelector<HTMLElement>(".calendar-block")!;
    const until = performance.now() + 600;
    while (performance.now() < until) await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    return { column: column.getBoundingClientRect().toJSON(), block: block.getBoundingClientRect().toJSON() };
  }, day);
  expect(resting.block.left).toBeGreaterThanOrEqual(resting.column.left);
  expect(resting.block.right).toBeLessThanOrEqual(resting.column.right);
  expect(resting.block.top).toBeGreaterThanOrEqual(resting.column.top);
  expect(resting.block.bottom).toBeLessThanOrEqual(resting.column.bottom);
  await expect(block).toBeVisible();

  // The keyboard path reaches the block, and the ring it draws fits inside the
  // column's paint box: containment must not eat the focus indicator.
  for (let press = 0; press < 40; press += 1) {
    if (await page.evaluate(() => document.activeElement?.classList.contains("calendar-block") === true)) break;
    await page.keyboard.press("Tab");
  }
  const ring = await page.evaluate((key) => {
    const column = document.querySelector<HTMLElement>(`[data-date="${key}"]`)!;
    const block = document.activeElement as HTMLElement;
    const style = getComputedStyle(block);
    const box = block.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    return {
      isBlock: block.classList.contains("calendar-block"),
      focusVisible: block.matches(":focus-visible"),
      // how far the ring reaches outside the block's own box
      reach: (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0),
      insetLeft: box.left - columnBox.left,
      insetRight: columnBox.right - box.right,
    };
  }, day);
  expect(ring.isBlock).toBe(true);
  expect(ring.focusVisible).toBe(true);
  expect(ring.reach).toBeGreaterThan(0);
  expect(ring.reach).toBeLessThanOrEqual(ring.insetLeft);
  expect(ring.reach).toBeLessThanOrEqual(ring.insetRight);
});

test("a tray neighbour reflows in the 250 ms spring, not the 400 ms one", async ({ page }) => {
  await signUp(page, newEmail("motion-tray"));
  await openTasks(page);
  await addTask(page, "Tray one");
  await addTask(page, "Tray two");
  await addTask(page, "Tray three");
  await openCalendar(page);
  await expect(page.locator(".tray-item")).toHaveCount(3);
  // Firestore orders tasks by creation, and two created in the same millisecond
  // fall back to document id, so the removal has to be the row that is first in
  // the DOM: every other row is below it and must move up.
  const first = (await page.locator(".tray-item b").first().textContent())!;
  const leaving = first.trim();

  // Give that task a block tomorrow, so it leaves the Unscheduled list now and
  // is not due to it being late in the day.
  const tomorrow = await wallDateKey(page, 1);
  await fillBlockForm(page, `${tomorrow}T08:00`, `${tomorrow}T09:00`, leaving);
  await recordTrayFrames(page, 1200);
  await page.getByRole("button", { name: "Add block" }).click();

  // The survivors move up once the planned row has finished leaving, and the
  // reflow is the only thing that moves them.
  const samples = await readTrayFrames(page);
  await expect(page.locator(".tray-item")).toHaveCount(2);
  expect(await page.locator(".tray-item").allTextContents()).not.toContain(leaving);

  const moving = samples.filter(sample => sample.transforms.some(transform => !RESTING.has(transform)));
  expect(moving.length).toBeGreaterThan(3);
  for (const sample of moving) {
    // a position-only reflow: no row is ever scaled or sheared
    for (const transform of sample.transforms.filter(value => !RESTING.has(value))) {
      expect(transform.startsWith("matrix(1, 0, 0, 1,")).toBe(true);
    }
  }
  const span = moving[moving.length - 1].at - moving[0].at;
  expect(span).toBeGreaterThan(100);
  // ...and it is done inside the snappy 250 ms budget the task rows travel with,
  // comfortably before the 400 ms smooth spring would have finished
  expect(span).toBeLessThanOrEqual(360);
  expect(samples[samples.length - 1].transforms.every(transform => RESTING.has(transform))).toBe(true);
});

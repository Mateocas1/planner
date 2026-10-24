import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { submitAuthForm } from "./browser-helpers.ts";

/**
 * Swipe to dismiss on the shared glass sheet (odd/tasks/ronda4.md, S1):
 * a drag on the sheet's drag handle (the header) or its plain surface follows
 * the finger, and a release past a distance threshold -- or a fast flick --
 * closes the sheet in the drag direction; anything shorter springs back. Up
 * rubber-bands and never dismisses. Text fields keep their native selection.
 */

test.setTimeout(120_000);

const newEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

type Point = { x: number; y: number };

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

async function addTask(page: Page, title: string) {
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

/** The morph and the entry flight both own the sheet's box; wait until neither does. */
async function settle(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 15_000 })
    .toBe(0);
}

/** Opens a task's details sheet and waits for it to be at rest. */
async function openTaskDetails(page: Page, title: string) {
  await page.locator(".task-open", { hasText: title }).click();
  const sheet = page.getByRole("complementary", { name: "Task details" });
  await expect(sheet).toBeVisible();
  await settle(page);
  return sheet;
}

/** A point on the drag handle, away from the header's close button. */
async function handlePoint(page: Page): Promise<Point> {
  const box = (await page.locator(".sheet-head").boundingBox())!;
  return { x: box.x + 28, y: box.y + box.height / 2 };
}

async function dragMouse(page: Page, from: Point, to: Point, steps = 6): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
  }
  await page.mouse.up();
}

/** Real touch input over CDP: trusted pointer events with a live pointer id. */
async function touchSwipe(
  page: Page,
  from: Point,
  to: Point,
  { steps = 10, midway, moveDelayMs = 0 }: { steps?: number; midway?: (at: Point) => Promise<void>; moveDelayMs?: number } = {},
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const point = (step: number): Point => ({
    x: from.x + ((to.x - from.x) * step) / steps,
    y: from.y + ((to.y - from.y) * step) / steps,
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [withId(point(0))] });
  for (let step = 1; step <= steps; step += 1) {
    if (moveDelayMs) await page.waitForTimeout(moveDelayMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [withId(point(step))] });
    if (midway && step === Math.floor(steps / 2)) await midway(point(step));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const withId = (point: Point) => ({ ...point, id: 1 });

/** What the gesture wrote on the sheet and its scrim, read mid-drag. */
function swipeState(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".sheet");
    const scrim = document.querySelector<HTMLElement>(".scrim");
    if (!sheet || !scrim) return null;
    const computed = getComputedStyle(sheet);
    const clip = computed.clipPath.match(/inset\(0px round ([\d.]+)px\)/);
    return {
      transform: sheet.style.transform,
      radius: clip ? parseFloat(clip[1]) : 0,
      // The resting border-radius must stay untouched while the gesture
      // rounds the corners on clip-path instead.
      borderRadius: parseFloat(computed.borderTopLeftRadius),
      scrimOpacity: scrim.style.opacity,
    };
  });
}

/** The sheet's inline gesture styles are gone again after a snap-back. */
async function clearedUp(page: Page) {
  await expect
    .poll(async () => (await swipeState(page))?.transform ?? "", { timeout: 5_000 })
    .toBe("");
}

test.describe("mouse", () => {
  test("a short drag follows the finger and snaps back, keeping the sheet open", async ({ page }) => {
    await signUp(page, newEmail("swipe-short"));
    await addTask(page, "Short drag");
    await openTaskDetails(page, "Short drag");
    const from = await handlePoint(page);

    // 100 px is past the 8 px slop but under the commit threshold (~35% of the
    // sheet's width), and the moves are slow enough that the release carries no
    // flick velocity, so the sheet follows and then springs back.
    let mid: Awaited<ReturnType<typeof swipeState>> = null;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse.move(from.x - (100 * step) / 4, from.y);
      // Older than the velocity window: a slow drag must not read as a throw.
      await page.waitForTimeout(130);
    }
    mid = await swipeState(page);
    await page.mouse.up();

    expect(mid, "the gesture wrote its state mid-drag").not.toBeNull();
    expect(mid!.transform).toContain("translate(");
    expect(mid!.transform).toContain("scale(");
    expect(parseFloat(mid!.scrimOpacity)).toBeLessThan(1);
    await clearedUp(page);
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  });

  test("a long drag left closes the task details sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-left"));
    await addTask(page, "Drag left");
    await openTaskDetails(page, "Drag left");
    await dragMouse(page, await handlePoint(page), {
      x: (await handlePoint(page)).x - 300,
      y: (await handlePoint(page)).y,
    });
    await expect(page.locator(".sheet")).toHaveCount(0);
    // The ordinary close path still ran: the caret went back to the row.
    await expect(page.locator(".task-open", { hasText: "Drag left" })).toBeFocused();
  });

  test("a long drag down closes the sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-down"));
    await addTask(page, "Drag down");
    await openTaskDetails(page, "Drag down");
    const from = await handlePoint(page);
    await dragMouse(page, from, { x: from.x, y: from.y + 300 });
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test("a fast flick left closes from a distance the threshold alone would reject", async ({ page }) => {
    await signUp(page, newEmail("swipe-flick"));
    await addTask(page, "Flick");
    await openTaskDetails(page, "Flick");
    const from = await handlePoint(page);
    // Three coarse moves in quick succession: ~120 px, well under the distance
    // threshold, but released fast enough to read as a throw.
    await dragMouse(page, from, { x: from.x - 120, y: from.y }, 3);
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test("a flick followed by a 300 ms hold snaps back instead of committing", async ({ page }) => {
    await signUp(page, newEmail("swipe-hesitant"));
    await addTask(page, "Hesitant release");
    await openTaskDetails(page, "Hesitant release");
    const from = await handlePoint(page);
    // Three quick moves (~120 px: a flick), then the pointer holds still well
    // past the 60 ms stale bound before lifting short of the 35 % threshold:
    // a hesitant release throws nothing.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 3; step += 1) await page.mouse.move(from.x - (120 * step) / 3, from.y);
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await clearedUp(page);
  });

  test("a committed swipe holds the sheet invisible from the flight's end to the unmount", async ({ page }) => {
    // A creation sheet: not shared, so the commit takes the real flight path
    // (a task-details sheet closes through the view transition, which owns
    // the close and never flies).
    await signUp(page, newEmail("swipe-invisible-exit"));
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Tasks" }).click();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("complementary", { name: "New task" })).toBeVisible();
    await settle(page);
    // The commit flight's `done` (useSwipeDismiss) cancels the flight, clears
    // its `fill: forwards` hold and leaves the sheet holding an inline
    // `opacity: 0` before the close path runs, so the presence exit starts
    // hidden instead of flashing back to rest. Record every inline opacity-0
    // write on the sheet and its removal, in order, and pin that sequence.
    await page.evaluate(() => {
      const events: string[] = [];
      (window as unknown as { __sheetExitEvents?: string[] }).__sheetExitEvents = events;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === "attributes") {
            const target = record.target as HTMLElement;
            if (target.classList.contains("sheet") && target.style.opacity === "0") events.push("opacity0");
          } else if (record.type === "childList") {
            for (const node of record.removedNodes) {
              if (node instanceof HTMLElement && node.querySelector(".sheet")) events.push("removed");
              if (node instanceof HTMLElement && node.classList.contains("sheet")) events.push("removed");
            }
          }
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    });
    const from = await handlePoint(page);
    await dragMouse(page, from, { x: from.x + 300, y: from.y });
    await expect(page.locator(".sheet")).toHaveCount(0);
    const events = await page.evaluate(() => (window as unknown as { __sheetExitEvents?: string[] }).__sheetExitEvents ?? []);
    // The sheet went to inline opacity 0 before anything removed it: the exit
    // starts hidden (the extraction's deliberate change over the old Sheet
    // code, pinned here).
    expect(events, JSON.stringify(events)).toContain("opacity0");
    expect(events.indexOf("opacity0"), JSON.stringify(events)).toBeLessThan(events.indexOf("removed"));
  });

  test("a mouse drag on body copy selects text and never moves the sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-body-text"));
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Calendar" }).click();
    await page.getByRole("button", { name: "New block" }).click();
    const sheet = page.getByRole("complementary", { name: "New block" });
    await expect(sheet).toBeVisible();
    await settle(page);
    const note = sheet.locator(".sheet-note");
    const box = (await note.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
    const mid = await swipeState(page);
    await page.mouse.up();
    // The drag selected copy, and the sheet never followed: the gesture never
    // started, so `user-select: none` never took hold either.
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.trim().length, "the drag selected body text").toBeGreaterThan(0);
    expect(mid!.transform, "the sheet stayed at rest").toBe("");
    await expect(sheet).toBeVisible();
  });

  test("a mouse drag from the empty surface still dismisses", async ({ page }) => {
    await signUp(page, newEmail("swipe-surface"));
    await addTask(page, "Surface drag");
    await openTaskDetails(page, "Surface drag");
    // The sheet's bottom padding: not the handle, not text, not a control --
    // exactly the surface a mouse gesture must still start from.
    const box = (await page.locator(".sheet").boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height - 10 };
    await dragMouse(page, from, { x: from.x - 400, y: from.y });
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test("a click on a clickable div inside the sheet still fires", async ({ page }) => {
    await signUp(page, newEmail("swipe-click-div"));
    await addTask(page, "Clickable div");
    await openTaskDetails(page, "Clickable div");
    // A clickable non-button div is the case capture-on-pointerdown used to
    // break: the capture retargeted its click to the sheet, so onClick never
    // ran. No sheet ships one today, so the test stamps its own.
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.id = "test-clickable";
      div.style.cssText = "width: 80px; height: 40px; background: #888;";
      div.addEventListener("click", () => {
        const state = window as unknown as { __testDivClicks?: number };
        state.__testDivClicks = (state.__testDivClicks ?? 0) + 1;
      });
      document.querySelector(".sheet-body")!.appendChild(div);
    });
    const box = (await page.locator("#test-clickable").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await page.evaluate(() => (window as unknown as { __testDivClicks?: number }).__testDivClicks)).toBe(1);
    // A press that wiggles inside the 8 px slop is still a click.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2, { steps: 2 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as unknown as { __testDivClicks?: number }).__testDivClicks)).toBe(2);
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  });

  test("an upward drag never closes the sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-up"));
    await addTask(page, "Drag up");
    await openTaskDetails(page, "Drag up");
    const from = await handlePoint(page);
    await dragMouse(page, from, { x: from.x, y: from.y - 300 });
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await clearedUp(page);
  });

  test("dragging inside the title field selects text instead of dragging the sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-field"));
    await addTask(page, "Selectable task title");
    await openTaskDetails(page, "Selectable task title");
    const field = page.getByLabel("Rename task");
    const box = (await field.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const selected = await field.evaluate(
      element => (element as HTMLInputElement).selectionStart !== (element as HTMLInputElement).selectionEnd,
    );
    expect(selected, "the drag selected text").toBe(true);
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  });

  test("a creation sheet closes on a drag right through the ordinary close path", async ({ page }) => {
    await signUp(page, newEmail("swipe-newtask"));
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Tasks" }).click();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("complementary", { name: "New task" })).toBeVisible();
    await settle(page);
    const from = await handlePoint(page);
    await dragMouse(page, from, { x: from.x + 300, y: from.y });
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the sheet never follows, and a past-threshold release still closes", async ({ page }) => {
      await signUp(page, newEmail("swipe-reduced"));
      await addTask(page, "Reduced drag");
      await openTaskDetails(page, "Reduced drag");
      const from = await handlePoint(page);

      let mid: Awaited<ReturnType<typeof swipeState>> = null;
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 4; step += 1) await page.mouse.move(from.x, from.y + (300 * step) / 4);
      mid = await swipeState(page);
      await page.mouse.up();

      expect(mid, "nothing followed the pointer").not.toBeNull();
      expect(mid!.transform).toBe("");
      await expect(page.locator(".sheet")).toHaveCount(0);
    });
  });
});

test.describe("touch, phone viewport", () => {
  test.use({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test("a down drag follows the finger, rounds the corners and closes", async ({ page }) => {
    await signUp(page, newEmail("swipe-touch-close"));
    await addTask(page, "Touch drag");
    await openTaskDetails(page, "Touch drag");
    const from = await handlePoint(page);

    const mid = await readAtMidway(page, from, { x: from.x, y: from.y + 280 });
    expect(mid!.transform).toContain("translate(");
    // Phone only: the corners round as the sheet shrinks (S1). The inset phone
    // sheet rests at --r-sheet (26 px), so the drag grows the radius past it --
    // on clip-path, while the CSS border-radius stays at rest.
    expect(mid!.radius).toBeGreaterThan(26);
    expect(mid!.borderRadius).toBeCloseTo(26, 0);
    expect(parseFloat(mid!.scrimOpacity)).toBeLessThan(1);
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test("a short touch drag snaps back and keeps the sheet open", async ({ page }) => {
    await signUp(page, newEmail("swipe-touch-short"));
    await addTask(page, "Touch short");
    await openTaskDetails(page, "Touch short");
    const from = await handlePoint(page);
    // Slow enough that the release carries no flick velocity.
    await touchSwipe(page, from, { x: from.x, y: from.y + 60 }, { moveDelayMs: 130 });
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await clearedUp(page);
  });

  test("an upward touch drag never closes the sheet", async ({ page }) => {
    await signUp(page, newEmail("swipe-touch-up"));
    await addTask(page, "Touch up");
    await openTaskDetails(page, "Touch up");
    const from = await handlePoint(page);
    await touchSwipe(page, from, { x: from.x, y: from.y - 300 });
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await clearedUp(page);
  });
});

/** Drags down by touch and reads the mid-drag state while the finger is still down. */
async function readAtMidway(page: Page, from: Point, to: Point): Promise<Awaited<ReturnType<typeof swipeState>>> {
  let mid: Awaited<ReturnType<typeof swipeState>> = null;
  await touchSwipe(page, from, to, {
    midway: async () => {
      mid = await swipeState(page);
    },
  });
  return mid;
}

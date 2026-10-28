import { expect, test, type Page } from "@playwright/test";
import { seedSidebarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Turning Today to the next day (distinctive roadmap F3, "The page-turn
 * gesture"): a left drag or flick on the page, and nothing else, closes the day.
 *
 * The assertion is the page's own transform, read frame by frame after the
 * release: a commit carries it off the screen, a cancel brings it home, and the
 * reduced-motion path never moves at all. Home has no next-day navigation yet
 * (F3c adds the shutdown roll), so the provisional handler refuses the turn and
 * the page springs back; that is the resting state asserted below.
 *
 * Mouse drags go through Playwright; touch goes through CDP's real touch input,
 * because a synthetic PointerEvent cannot capture a pointer and would pass a
 * test the browser fails.
 */

test.setTimeout(150_000);

const ZONE = "UTC";
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

type Frame = { t: number; state: string; x: number; opacity: number };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const surface = (page: Page) => page.locator(".page-turn");
const pageLayer = (page: Page) => page.locator(".page-turn-top");

/** Signs in to an account with `rows` tasks due today, and waits for the day. */
async function openToday(page: Page, prefix: string, rows = 2): Promise<void> {
  const email = newEmail(prefix);
  await seedSidebarFixture(email, ZONE, {
    tasks: Array.from({ length: rows }, (_, index) => ({ title: `Turn task ${index + 1}`, deadline: today() })),
  });
  /* A local Auth round trip plus three workers on one host is slow, never
     wrong: the retry is a budget for the emulator. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card")).toBeVisible({ timeout: 30_000 });
  await expect(surface(page)).toHaveAttribute("data-page-turn-state", "rest");
}

/**
 * Every frame for `duration` after it is called, read from the page's own
 * computed transform: what the user would have seen, not what the code meant.
 */
async function sample(page: Page, duration = 900): Promise<Frame[]> {
  return page.evaluate(async ms => {
    const frames: Frame[] = [];
    const root = document.querySelector<HTMLElement>(".page-turn");
    const layer = document.querySelector<HTMLElement>(".page-turn-top");
    const started = performance.now();
    while (performance.now() - started < ms) {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      const transform = layer ? getComputedStyle(layer).transform : "none";
      frames.push({
        t: performance.now() - started,
        state: root?.getAttribute("data-page-turn-state") ?? "missing",
        x: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41,
        opacity: layer ? Number(getComputedStyle(layer).opacity) : 1,
      });
    }
    return frames;
  }, duration);
}

const travelled = (frames: Frame[]) => Math.min(...frames.map(frame => frame.x));

/**
 * A leftward mouse drag on the page, from the empty part of the header (never
 * over a control). `restMs` is how long the pointer rests before letting go,
 * which is what makes a slow release slow.
 */
async function dragLeft(page: Page, fraction: number, restMs = 0): Promise<void> {
  const box = (await pageLayer(page).boundingBox())!;
  const from = { x: box.x + box.width * 0.7, y: box.y + 62 };
  const dx = -box.width * fraction;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + (dx * step) / 10, from.y);
  if (restMs > 0) await page.waitForTimeout(restMs);
  await page.mouse.up();
}

/**
 * A leftward throw in four coarse moves. Ten small moves would be ten Playwright
 * round trips, and on a loaded host that stretches a short drag past the 80 ms
 * velocity window, turning a flick into a cancel for a reason the product does
 * not have.
 */
async function flickLeft(page: Page, distance: number): Promise<void> {
  const box = (await pageLayer(page).boundingBox())!;
  const from = { x: box.x + box.width * 0.7, y: box.y + 62 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 4; step += 1) await page.mouse.move(from.x - (distance * step) / 4, from.y);
  await page.mouse.up();
}

/** Real touch input over CDP: trusted pointer events with a live pointer id. */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  const at = (index: number) => ({
    x: from.x + ((to.x - from.x) * index) / steps,
    y: from.y + ((to.y - from.y) * index) / steps,
    id: 1,
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(step)] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("a left drag past 40% carries the day off, then back while nothing handles the turn", async ({ page }) => {
  await openToday(page, "turn-commit");
  const width = (await pageLayer(page).boundingBox())!.width;

  await dragLeft(page, 0.55);
  const frames = await sample(page);

  // The page was carried past the threshold and never came back for the release.
  expect(frames.some(frame => frame.state === "commit")).toBe(true);
  // It leaves on one transform, all the way off its own width.
  expect(travelled(frames)).toBeLessThanOrEqual(-0.9 * width);
  // Nothing has claimed the turn yet, so it settles home again (F3c: the roll).
  const last = frames[frames.length - 1];
  expect(last.state).toBe("rest");
  expect(Math.abs(last.x)).toBeLessThan(1);
});

test("a slow 30 px drag does not turn the day", async ({ page }) => {
  await openToday(page, "turn-cancel");
  const box = (await pageLayer(page).boundingBox())!;

  await page.mouse.move(box.x + box.width * 0.7, box.y + 62);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(box.x + box.width * 0.7 - 5 * step, box.y + 62);
  // Held still before letting go: no flick, so only the distance would commit.
  await page.waitForTimeout(200);
  await page.mouse.up();
  const frames = await sample(page);

  expect(frames.some(frame => frame.state === "commit")).toBe(false);
  // It never travelled further than the finger did.
  expect(travelled(frames)).toBeGreaterThanOrEqual(-31);
  const last = frames[frames.length - 1];
  expect(last.state).toBe("rest");
  expect(Math.abs(last.x)).toBeLessThan(1);
});

test("a fast flick turns the page well before the distance threshold", async ({ page }) => {
  await openToday(page, "turn-flick");
  const width = (await pageLayer(page).boundingBox())!.width;

  // 220 px of a ~960 px page is 23%: the throw is what commits, not the travel.
  await flickLeft(page, 220);
  const frames = await sample(page);

  expect(frames.some(frame => frame.state === "commit")).toBe(true);
  expect(travelled(frames)).toBeLessThanOrEqual(-0.9 * width);
});

test("a press on a control keeps its press and never starts a turn", async ({ page }) => {
  await openToday(page, "turn-control");
  // The sidebar lists the same task, so the press is scoped to the page.
  const check = pageLayer(page).getByLabel("Complete: Turn task 1").first();
  const from = (await check.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 200, from.y + from.height / 2, { steps: 6 });
  // Mid-drag, before letting go: an owned press never became a page turn.
  await expect(surface(page)).toHaveAttribute("data-page-turn-state", "rest");
  expect(Math.abs(await translateX(page))).toBeLessThan(1);
  await page.mouse.up();
});

test.describe("on a phone", () => {
  test.use(phone);

  test("a left swipe turns the page", async ({ page }) => {
    await openToday(page, "turn-swipe", 6);
    const width = (await pageLayer(page).boundingBox())!.width;
    /* Start on the page heading: a control under the finger (Plan my day sat at
       y=400 once the Full screen link left the Now card) is not a turn. */
    const head = (await page.locator(".page-head").first().boundingBox())!;
    const y = head.y + head.height / 2;

    await swipe(page, { x: 340, y }, { x: 90, y });

    const frames = await sample(page);
    expect(frames.some(frame => frame.state === "commit")).toBe(true);
    expect(travelled(frames)).toBeLessThanOrEqual(-0.9 * width);
  });

  test("a vertical swipe scrolls the page instead of turning it", async ({ page }) => {
    await openToday(page, "turn-scroll", 10);
    // Horizontal is claimed in script; the vertical axis stays the browser's.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".page-turn")!).touchAction)).toBe("pan-y");

    await swipe(page, { x: 195, y: 640 }, { x: 195, y: 280 });

    await expect(surface(page)).toHaveAttribute("data-page-turn-state", "rest");
    expect(Math.abs(await translateX(page))).toBeLessThan(1);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the page never follows the finger and the release is a 150 ms shutter", async ({ page }) => {
    await openToday(page, "turn-reduced");
    const box = (await pageLayer(page).boundingBox())!;

    await page.mouse.move(box.x + box.width * 0.7, box.y + 62);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + box.width * 0.7 - 70 * step, box.y + 62);
    // Still held, past 40%: direct manipulation is gone, the page is where it was.
    expect(Math.abs(await translateX(page))).toBeLessThan(1);
    await page.mouse.up();

    const frames = await sample(page, 700);
    expect(frames.every(frame => Math.abs(frame.x) < 1)).toBe(true);
    // No travel, but not nothing: the release fades the page out and back.
    expect(frames.some(frame => frame.opacity < 0.3)).toBe(true);
    expect(frames[frames.length - 1].opacity).toBe(1);
    expect(frames[frames.length - 1].state).toBe("rest");
  });
});

async function translateX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>(".page-turn-top");
    const transform = layer ? getComputedStyle(layer).transform : "none";
    return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
  });
}

import { expect, test, type Page } from "@playwright/test";
import { seedSidebarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Now mode (distinctive roadmap F5): a full-screen glance surface for the block
 * that is running, opened from the Today card or the palette, closed by Escape
 * or its own button.
 *
 * The clock is installed before the app loads and parked on an exact minute
 * once the day is on screen, so "25% at 14:15 of a 14:00–15:00 block" is a
 * statement about the ruler the surface draws from, not a race with the test's
 * own runtime. The ring is read through the two things it publishes: the
 * `--progress` custom property that drives its conic-gradient, and its
 * `aria-valuenow`.
 */

test.setTimeout(150_000);

/* The desktop shell: 1280x800 is one of the two viewports F5 has to work at. */
test.use({ viewport: { width: 1280, height: 800 } });

const ZONE = "UTC";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/**
 * A fake 14:00 in the profile zone, two days out: far enough ahead that no
 * assertion below can drift across the real midnight, and far enough from the
 * account's own creation that the Auth emulator mints a valid token.
 */
function futureAfternoon(): Date {
  const base = new Date();
  base.setUTCHours(14, 0, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

/** ISO instants for a block that starts `fromStart` and ends `fromEnd` minutes
 * after `base`. */
function block(base: Date, fromStart: number, fromEnd: number) {
  return {
    start: new Date(base.getTime() + fromStart * 60_000).toISOString().replace(".000Z", "Z"),
    end: new Date(base.getTime() + fromEnd * 60_000).toISOString().replace(".000Z", "Z"),
  };
}

/** Seeds the fixture, stands in for the two device APIs and signs the
 * (remotely created) account in.
 *
 * The device APIs are stubbed by default because headless Chromium really does
 * grant fullscreen: a surface that takes the whole screen cannot then be
 * resized, and Escape becomes the browser's own key. One mode per test keeps
 * the surface's behaviour the thing under test. */
async function enter(
  page: Page,
  prefix: string,
  fixture: Parameters<typeof seedSidebarFixture>[2],
  apis: ApiMode = "refused",
): Promise<void> {
  await stubNowApis(page, apis);
  const email = newEmail(prefix);
  await seedSidebarFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock plus three workers on one host is
     slow, never wrong: the retry is a budget for the emulator, and a wrong app
     still fails every attempt. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  /* The clock is frozen right after this returns, so the store has to be on
     screen first: Firestore's snapshot delivery schedules its own tasks, and a
     paused clock would leave the page on "Loading your planner…" forever. */
  await expect(page.locator(".now-card")).toBeVisible({ timeout: 30_000 });
}

const nowMode = (page: Page) => page.getByRole("dialog", { name: "Now mode" });
const fullScreen = (page: Page) => page.getByRole("button", { name: "Full screen" });
const progressRing = (page: Page) => nowMode(page).getByRole("progressbar", { name: "Block progress" });

/** Opens the overlay from the Today card's own entry point. */
async function openNow(page: Page) {
  await expect(fullScreen(page)).toBeVisible();
  await fullScreen(page).click();
  const overlay = nowMode(page);
  await expect(overlay).toBeVisible();
  return overlay;
}

/** A real 14:00–15:00 block with its task, and the 15:00 block that follows. */
function afternoonFixture(base: Date) {
  return {
    tasks: [{ title: "Write the brief", deadline: base.toISOString().slice(0, 10) }, { title: "Review" }],
    blocks: [
      { ...block(base, 0, 60), task: "Write the brief" },
      { ...block(base, 60, 90), task: "Review" },
    ],
  };
}

test("at 14:15 of a 14:00–15:00 block the ring reads 25% and the task can be finished", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-ring", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay.getByRole("heading", { name: "Write the brief" })).toBeVisible();

  /* The ring is a conic-gradient driven by one custom property: both halves of
     that contract are read, so a ring that renders but never moves fails. */
  const ring = progressRing(page);
  await expect(ring).toHaveAttribute("aria-valuenow", "25");
  const progress = await ring.evaluate(element => getComputedStyle(element).getPropertyValue("--progress"));
  expect(Number.parseFloat(progress)).toBeCloseTo(0.25, 3);
  await expect(ring).toHaveCSS("background-image", /conic-gradient/);

  await expect(overlay.getByText("45 min left")).toBeVisible();
  await expect(overlay.getByText("Next: 15:00 Review")).toBeVisible();

  /* Mark task done is the overlay's own write: it completes the block's task and
     then has nothing left to offer, because the task is done. The clock is
     resumed for the assertion: Firestore delivers the local echo through the
     page's own task queue, which a paused clock never runs. */
  await overlay.getByRole("button", { name: "Mark task done" }).click();
  await page.clock.resume();
  await expect(overlay.getByRole("button", { name: "Mark task done" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByText("Nothing due today.")).toBeVisible();
});

test("with no block running it says Free now and names the next one", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-free", {
    tasks: [{ title: "Review" }],
    blocks: [{ ...block(base, 60, 90), task: "Review" }],
  });
  await page.clock.pauseAt(new Date(base.getTime() + 40 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay.getByText("Free now")).toBeVisible();
  await expect(overlay.getByRole("heading", { name: "Next: 15:00 Review in 20 min" })).toBeVisible();
  /* Nothing to progress: no ring, and no invented percentage. */
  await expect(progressRing(page)).toHaveCount(0);
});

test("with no blocks left today it says so instead of counting down", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-empty", {
    tasks: [{ title: "Write the brief" }],
    blocks: [{ ...block(base, 0, 60), task: "Write the brief" }],
  });
  await page.clock.pauseAt(new Date(base.getTime() + 90 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay.getByText("Free now")).toBeVisible();
  await expect(overlay.getByRole("heading", { name: "Nothing else today." })).toBeVisible();
  await expect(progressRing(page)).toHaveCount(0);
});

test("a block that ends while the overlay is open moves to the next state", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-rollover", {
    tasks: [{ title: "Write the brief" }, { title: "Review" }],
    blocks: [
      { ...block(base, 0, 60), task: "Write the brief" },
      { ...block(base, 90, 150), task: "Review" },
    ],
  });
  await page.clock.pauseAt(new Date(base.getTime() + 59 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay.getByRole("heading", { name: "Write the brief" })).toBeVisible();
  await expect(overlay.getByText("01:00 left")).toBeVisible();

  /* 15:01: the block is over, 15:30 is next. Same overlay, no reload. */
  await page.clock.fastForward("00:02:00");
  await expect(overlay.getByText("Free now")).toBeVisible();
  await expect(overlay.getByRole("heading", { name: "Next: 15:30 Review in 29 min" })).toBeVisible();
  await expect(progressRing(page)).toHaveCount(0);
});

test("the chrome fades after 30 seconds without input and comes back on a key", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-idle", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  const chrome = overlay.locator(".now-chrome").first();
  const actions = overlay.locator(".now-actions");
  await expect(chrome).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("opacity", "1");

  await page.clock.fastForward("00:00:31");
  await expect(chrome).toHaveCSS("opacity", "0");
  await expect(actions).toHaveCSS("opacity", "0");

  /* A glance surface has no reason to keep its buttons lit; any key brings them
     back, and the surface itself never changes. */
  await page.keyboard.press("Shift");
  await expect(chrome).toHaveCSS("opacity", "1");
  /* 31 s later the block has 44 min left, not 45: the surface kept counting. */
  await expect(overlay.locator(".now-remaining")).toHaveText(/^\d+ min left$/);
});

test("the screen wake lock and fullscreen are requested once and released on exit", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-apis", afternoonFixture(base), "available");
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay).toHaveAttribute("data-wake-lock", "held");
  await expect(overlay).toHaveAttribute("data-fullscreen", "requested");
  expect(await apiCalls(page)).toMatchObject({ wakeRequests: 1, fullscreenRequests: 1, wakeReleases: 0 });

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect.poll(async () => (await apiCalls(page)).wakeReleases).toBe(1);
});

test("without the Wake Lock and Fullscreen APIs the overlay still works and shows no error", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-noapis", afternoonFixture(base), "missing");
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  await expect(overlay).toHaveAttribute("data-wake-lock", "unavailable");
  await expect(overlay).toHaveAttribute("data-fullscreen", "unavailable");
  await expect(overlay.getByText("45 min left")).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("Escape and the close button exit, and focus goes back where it came from", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-keys", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  /* Keyboard only from here: focus the entry point and activate it with Enter. */
  await fullScreen(page).focus();
  await page.keyboard.press("Enter");
  const overlay = nowMode(page);
  await expect(overlay).toBeVisible();

  const close = overlay.getByRole("button", { name: "Close Now mode" });
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  /* Tab is contained in both directions: the page behind is covered, so it must
     not be reachable, and the last control wraps back to the first. */
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(fullScreen(page)).toBeFocused();
  /* The page behind is the reader's again, scroll and all. */
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

  /* And the same exit by pointer: the close button. */
  await page.keyboard.press("Enter");
  await expect(overlay).toBeVisible();
  await close.click();
  await expect(overlay).toHaveCount(0);
  await expect(fullScreen(page)).toBeFocused();
});

test("Start and Pause drive the one focus timer the shell owns", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-timer", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  /* The overlay speaks the timer's own vocabulary and runs the shell's hook: the
     sidebar card shows the same session, so there is one timer, not two. */
  await overlay.getByRole("button", { name: "Start focus" }).click();
  await expect(overlay.getByRole("button", { name: "Pause focus" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Focus timer" })).toBeVisible();

  await overlay.getByRole("button", { name: "Pause focus" }).click();
  await expect(overlay.getByRole("button", { name: "Resume focus" })).toBeVisible();
});

test("reduced motion fades the surface in over 150 ms and drops the focus pull", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-reduce", afternoonFixture(base), "missing");
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));
  await page.emulateMedia({ reducedMotion: "reduce" });

  const overlay = await openNow(page);
  await expect(overlay).toHaveCSS("animation-duration", "0.15s");
  await expect(overlay.locator(".now-chrome").first()).toHaveCSS("transition-duration", "0.15s");
  /* The blur is a movement cue, so reduced motion does not get it at all. */
  await expect(overlay.locator(".now-content")).toHaveCSS("filter", "none");
  await expect(overlay.getByText("45 min left")).toBeVisible();

  /* The capture waits for the fade to land: a screenshot taken the moment the
     dialog is "visible" catches it at 20% opacity and shows the page through
     it. `getAnimations` is real time even under a paused clock. */
  await overlay.evaluate(element =>
    Promise.all(
      element.getAnimations({ subtree: true }).map(animation => animation.finished.then(() => undefined, () => undefined)),
    ),
  );
  await page.screenshot({ path: "../odd/runs/f5-now-mode-reduced.png" });
});

test("it fills the viewport at 1280x800 and at 390x844 without overflowing", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-sizes", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  const overlay = await openNow(page);
  /* `inset: 0` is the initial containing block, which is the viewport without
     its classic scrollbar -- compare with the same box, not with the window.
     The measurement waits for the entrance to land: Playwright reads the
     transformed box, and Materialize enters at scale(.96). */
  const desktop = await viewportBox(page);
  /* The page behind is locked while the surface is up: a covered page must not
     scroll under it. */
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await expect.poll(async () => (await overlay.boundingBox())?.width).toBe(desktop.width);
  /* The entrance hands its transform back rather than holding scale(1) on a
     full-screen element for the life of the surface. */
  await expect(overlay).toHaveCSS("transform", "none");
  await expect(overlay.getByText("45 min left")).toBeVisible();

  /* The phone: the same surface, still one column, still no sideways scroll. */
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await viewportBox(page);
  expect(phone).toMatchObject({ width: 390, height: 844 });
  await expect.poll(async () => (await overlay.boundingBox())?.width).toBe(phone.width);
  const phoneBox = await overlay.boundingBox();
  expect(phoneBox).toMatchObject({ x: 0, y: 0, width: phone.width, height: phone.height });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(progressRing(page)).toBeVisible();
  await expect(overlay.getByText("45 min left")).toBeVisible();

  /* Portrait tablet: wide enough for the desktop shell, far too narrow for a
     week -- the surface has one column anyway. */
  await page.setViewportSize({ width: 768, height: 1024 });
  const tablet = await viewportBox(page);
  expect(tablet).toMatchObject({ width: 768, height: 1024 });
  await expect.poll(async () => (await overlay.boundingBox())?.width).toBe(tablet.width);
  await expect(progressRing(page)).toBeVisible();
  await expect(overlay.getByText("45 min left")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("the palette offers Open Now mode and opens it", async ({ page }) => {
  const base = futureAfternoon();
  await page.clock.install({ time: base });
  await enter(page, "now-palette", afternoonFixture(base));
  await page.clock.pauseAt(new Date(base.getTime() + 15 * 60_000));

  await runPaletteCommand(page, "now", "Open Now mode");
  const overlay = nowMode(page);
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("heading", { name: "Write the brief" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});

/* ---------- helpers ---------- */

type ApiCalls = { wakeRequests: number; wakeReleases: number; fullscreenRequests: number };

type ApiMode =
  /* both APIs behave, and every call is recorded */
  | "available"
  /* both are absent: the browser F5 has to survive */
  | "missing"
  /* the wake lock is held, fullscreen is refused (the default: headless really
     grants it, and a fullscreen window cannot be resized mid-test) */
  | "refused";

/**
 * Stands in for the two device APIs. "available" records every call so the
 * request/release pairing is provable; "missing" removes both; "refused" keeps
 * the wake lock and makes the fullscreen request reject.
 */
async function stubNowApis(page: Page, mode: ApiMode) {
  await page.addInitScript((kind: string) => {
    const calls = { wakeRequests: 0, wakeReleases: 0, fullscreenRequests: 0 };
    (window as unknown as { __nowApi: typeof calls }).__nowApi = calls;
    if (kind === "missing") {
      Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, get: () => undefined });
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
      return;
    }
    Object.defineProperty(Navigator.prototype, "wakeLock", {
      configurable: true,
      get: () => ({
        request: async () => {
          calls.wakeRequests += 1;
          return {
            released: false,
            addEventListener() {},
            removeEventListener() {},
            release: async () => {
              calls.wakeReleases += 1;
            },
          };
        },
      }),
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value:
        kind === "refused"
          ? async () => {
              calls.fullscreenRequests += 1;
              throw new TypeError("fullscreen request denied by this browser");
            }
          : async () => {
              calls.fullscreenRequests += 1;
            },
    });
  }, mode);
}

async function apiCalls(page: Page): Promise<ApiCalls> {
  return page.evaluate(() => (window as unknown as { __nowApi: ApiCalls }).__nowApi);
}

/** The initial containing block a fixed `inset: 0` surface fills. */
async function viewportBox(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
}

/** Runs one palette command by keyboard: open, type, walk to the row, Enter. */
async function runPaletteCommand(page: Page, query: string, command: string) {
  await page.keyboard.press("Control+k");
  const field = page.getByRole("combobox", { name: "Search tasks or run a command" });
  await expect(field).toBeVisible();
  await field.fill(query);
  const option = page.getByRole("option", { name: command });
  await expect(option).toBeVisible();
  for (let press = 0; press < 8; press += 1) {
    if ((await option.getAttribute("aria-selected")) === "true") break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

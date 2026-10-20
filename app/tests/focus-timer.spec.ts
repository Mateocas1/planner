import { expect, test, type Page } from "@playwright/test";
import { seedSidebarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The focus timer (value roadmap §3 and §5 row 5): ▶ on an Up next row starts a
 * countdown to that block's end, the sidebar shows one live card while it runs,
 * the palette can start, pause, resume and stop it, and a reload resumes it.
 *
 * The clock is installed before the app loads and frozen once the block is on
 * screen, so every countdown below is an exact statement instead of a race with
 * the test's own runtime. Nothing here counts wall-clock seconds: the app
 * recomputes from timestamps, and the assertions prove that by jumping the
 * clock.
 */

test.setTimeout(150_000);

/* A desktop-tall window: at 720 px the sidebar drops Due soon, and at 600 px it
   drops Up next on purpose (Sidebar.css). The timer lives in Up next. */
test.use({ viewport: { width: 1440, height: 900 } });

const ZONE = "UTC";
const STORAGE_KEY = "planner-focus";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/**
 * A fake "now" at 09:00 in the profile zone, on the first day that is still
 * comfortably in the future: the Auth emulator rejects a token minted before
 * the account it belongs to, and the blocks below need the whole morning.
 */
function futureMorning() {
  const base = new Date();
  base.setUTCHours(9, 0, 0, 0);
  if (base.getTime() < Date.now() + 60 * 60_000) base.setUTCDate(base.getUTCDate() + 1);
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

/** Seeds the fixture and signs the (remotely created) account in. */
async function enter(
  page: Page,
  prefix: string,
  fixture: Parameters<typeof seedSidebarFixture>[2],
): Promise<void> {
  const email = newEmail(prefix);
  await seedSidebarFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock plus three workers on one host is
     slow, never wrong: the retry is a budget for the emulator, and a wrong app
     still fails every attempt. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
}

const upNext = (page: Page) => page.getByRole("region", { name: "Up next" });
const timer = (page: Page) => page.getByRole("group", { name: "Focus timer" });
const digits = (page: Page) => timer(page).locator(".focus-time");
const focusButtons = (page: Page) => page.getByRole("button", { name: /^Focus: / });

/** Runs one palette command by keyboard: open, type, walk to the row, Enter. */
async function runPaletteCommand(page: Page, command: string) {
  await page.keyboard.press("Control+k");
  const field = page.getByRole("combobox", { name: "Search tasks or run a command" });
  await expect(field).toBeVisible();
  await field.fill("focus");
  const option = page.getByRole("option", { name: command });
  await expect(option).toBeVisible();
  /* The first row is always "Create …"; walk down to the command itself. */
  for (let press = 0; press < 8; press += 1) {
    const selected = await page.getByRole("option", { name: command }).getAttribute("aria-selected");
    if (selected === "true") break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(page.getByRole("option", { name: command })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("the ▶ on an Up next row starts a countdown that survives a reload, a pause and a stop", async ({ page }) => {
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-run", {
    tasks: [{ title: "Write the brief" }],
    blocks: [{ ...block(base, 0, 40), task: "Write the brief" }],
  });

  /* The store loads on a live clock; freeze it once the row is on screen. */
  const up = upNext(page);
  const start = up.getByRole("button", { name: "Focus: Write the brief" });
  await expect(start).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 60_000));

  /* A block with a linked task is named by its task, and the countdown runs to
     the block's own end: 09:01 now, 09:40 end. */
  await start.click();
  await expect(timer(page)).toBeVisible();
  await expect(timer(page).getByText("Write the brief")).toBeVisible();
  await expect(digits(page)).toHaveText("0:39");
  await expect(page).toHaveTitle("0:39 · Write the brief");
  /* The focused block's row steps aside: the card already names it. */
  await expect(up.getByText("Write the brief")).toHaveCount(1);

  /* A reload keeps the timer: the stored instants are the truth, not a tick.
     Firebase's session restore needs a live clock, so it runs across the reload
     and is frozen again, one second short of two minutes in, then ticked once:
     the frozen instant the app reads is exactly 09:02. */
  await page.clock.resume();
  await page.reload();
  await expect(up.getByRole("heading", { name: "Up next" })).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 119_000));
  await page.clock.fastForward(1000);
  await expect(digits(page)).toHaveText("0:38");
  await expect(page).toHaveTitle("0:38 · Write the brief");
  const stored = await page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY);
  expect(JSON.parse(stored ?? "{}")).toMatchObject({ endAt: base.getTime() + 40 * 60_000, startedAt: base.getTime() + 60_000, pausedMs: 0 });

  /* One minute of clock: the digits follow, computed from the timestamps. */
  await page.clock.fastForward("00:01:00");
  await expect(digits(page)).toHaveText("0:37");

  /* Pause freezes both the digits and the tab title while time passes. */
  await timer(page).getByRole("button", { name: "Pause" }).click();
  await expect(timer(page).getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(digits(page)).toHaveText("0:37");
  await page.clock.fastForward("00:02:00");
  await expect(digits(page)).toHaveText("0:37");
  await expect(page).toHaveTitle("0:37 · Write the brief");

  /* Resume excludes the two paused minutes: 09:05 now, so 35 minutes are left. */
  await timer(page).getByRole("button", { name: "Resume" }).click();
  await expect(digits(page)).toHaveText("0:35");

  /* Stop clears the timer, the stored session and the tab title. */
  await timer(page).getByRole("button", { name: "Stop" }).click();
  /* Stop clears the session and the tab title, and the row is up next again.
     The card's own departure is a Motion exit, which a paused clock never runs
     (see the mounting test below): here the state is what is asserted. */
  await expect(page).toHaveTitle("Personal Planner");
  await expect(up.getByRole("button", { name: "Focus: Write the brief" })).toBeVisible();
  expect(await page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("the last five minutes count in seconds, then the block ends calmly", async ({ page }) => {
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-done", {
    tasks: [{ title: "Send invoice" }],
    blocks: [{ ...block(base, 0, 2), task: "Send invoice" }],
  });

  const up = upNext(page);
  const start = up.getByRole("button", { name: "Focus: Send invoice" });
  await expect(start).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 30_000));

  await start.click();
  await expect(digits(page)).toHaveText("01:30");
  await expect(page).toHaveTitle("01:30 · Send invoice");

  await page.clock.fastForward("00:00:30");
  await expect(digits(page)).toHaveText("01:00");

  /* The block ran out: the card settles on "Done", keeps only Stop, and puts the
     page's own title back (nothing is counting down any more). */
  await page.clock.fastForward("00:01:00");
  await expect(digits(page)).toHaveText("Done");
  await expect(page).toHaveTitle("Personal Planner");
  await expect(timer(page).getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(timer(page).getByRole("button", { name: "Resume" })).toHaveCount(0);
  await expect(timer(page).getByRole("button", { name: "Stop" })).toBeVisible();
  /* The ended block is not up next, so nothing offers to focus on it again. */
  await expect(focusButtons(page)).toHaveCount(0);
  await expect(up.getByText("Nothing else today.")).toBeVisible();

  await timer(page).getByRole("button", { name: "Stop" }).click();
  await expect(page).toHaveTitle("Personal Planner");
  expect(await page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("the palette starts, pauses, resumes and stops the timer, and offers only what applies", async ({ page }) => {
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-palette", {
    tasks: [{ title: "Draft the deck" }],
    blocks: [{ ...block(base, 0, 45), task: "Draft the deck" }],
  });
  await expect(upNext(page).getByRole("button", { name: "Focus: Draft the deck" })).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 60_000));

  await runPaletteCommand(page, "Start focus on next block");
  await expect(digits(page)).toHaveText("0:44");

  await runPaletteCommand(page, "Pause focus");
  await expect(digits(page)).toHaveText("0:44");
  await expect(timer(page).getByRole("button", { name: "Resume" })).toBeVisible();

  await runPaletteCommand(page, "Resume focus");
  await expect(timer(page).getByRole("button", { name: "Pause" })).toBeVisible();

  await runPaletteCommand(page, "Stop focus");
  expect(await page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await expect(upNext(page).getByRole("button", { name: "Focus: Draft the deck" })).toBeVisible();

  /* With no session, only "start" applies again: the block is still running, so
     pause, resume and stop are gone and the palette says so. */
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("focus");
  await expect(page.getByRole("option")).toHaveText(["Create “focus”", "Start focus on next block"]);
  await page.keyboard.press("Escape");
});

test("the timer is fully operable from the keyboard", async ({ page }) => {
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-keys", {
    tasks: [{ title: "Review the plan" }],
    blocks: [{ ...block(base, 0, 20), task: "Review the plan" }],
  });

  const start = upNext(page).getByRole("button", { name: "Focus: Review the plan" });
  await expect(start).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 60_000));

  /* Focus the ▶ and activate it with Enter: no pointer anywhere in this test. */
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(digits(page)).toHaveText("0:19");

  /* The card's controls are real buttons: Tab reaches them, Enter activates. */
  await timer(page).getByRole("button", { name: "Pause" }).focus();
  await page.keyboard.press("Enter");
  await expect(timer(page).getByRole("button", { name: "Resume" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Stop" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("Personal Planner");
  expect(await page.evaluate(key => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("reduced motion keeps the timer working and caps its transitions", async ({ page }) => {
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-reduce", {
    tasks: [{ title: "Read the RFC" }],
    blocks: [{ ...block(base, 0, 30), task: "Read the RFC" }],
  });

  const start = upNext(page).getByRole("button", { name: "Focus: Read the RFC" });
  await expect(start).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.pauseAt(new Date(base.getTime() + 60_000));
  await start.click();

  await expect(digits(page)).toHaveText("0:29");
  await expect(timer(page).getByRole("button", { name: "Pause" })).toBeVisible();
  /* The page's own reduced-motion rule is what caps the card's controls: the
     entrance itself is Motion's, and MotionConfig reducedMotion="user" owns it
     for the whole app (App.tsx). */
  const durations = await timer(page)
    .getByRole("button", { name: "Pause" })
    .evaluate(element => getComputedStyle(element).transitionDuration);
  expect(durations).toBe("0.001s");
});

test("the card lands on a running clock and leaves on Stop", async ({ page }) => {
  /* No fake clock here, on purpose: Motion schedules its frames on the page's own
     clock and a paused clock delivers none of them, so the card's entrance and
     its exit are proved where frames are real. The digits are the fake-clock
     tests' job above. */
  await enter(page, "focus-mount", {
    tasks: [{ title: "Sketch the layout" }],
    blocks: [{ ...block(new Date(), -5, 30), task: "Sketch the layout" }],
  });

  const up = upNext(page);
  await up.getByRole("button", { name: "Focus: Sketch the layout" }).click();
  await expect(timer(page)).toBeVisible();
  await expect(timer(page).getByText("Sketch the layout")).toBeVisible();
  await expect(page).toHaveTitle(/^\d+:\d\d · Sketch the layout$/);
  /* The focused block's row is replaced by the card, not repeated beside it. */
  await expect(up.getByRole("button", { name: "Focus: Sketch the layout" })).toHaveCount(0);

  await timer(page).getByRole("button", { name: "Stop" }).click();
  await expect(timer(page)).toHaveCount(0);
  await expect(page).toHaveTitle("Personal Planner");
  await expect(up.getByRole("button", { name: "Focus: Sketch the layout" })).toBeVisible();
});

test("a phone runs no timer: there is no Up next and no focus command", async ({ page }) => {
  /* 390x844: the phone shell, where the sidebar (and therefore Up next) does not
     exist. The timer is a sidebar surface today, so the phone must not start a
     timer it cannot show -- not even one stored by a desktop. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(key => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ blockId: "desktop-block", endAt: Date.now() + 600_000, startedAt: Date.now(), pausedMs: 0 }),
    );
  }, STORAGE_KEY);

  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "focus-phone", {
    tasks: [{ title: "Call the bank" }],
    blocks: [{ ...block(base, 0, 40), task: "Call the bank" }],
  });

  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(upNext(page)).toHaveCount(0);
  await expect(timer(page)).toHaveCount(0);
  await expect(focusButtons(page)).toHaveCount(0);
  await expect(page).toHaveTitle("Personal Planner");

  /* The palette is still reachable, and it offers no timer it could not show. */
  await page.getByRole("button", { name: "Command palette" }).click();
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("focus");
  await expect(page.getByRole("option")).toHaveCount(1);
});

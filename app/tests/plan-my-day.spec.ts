import { expect, test, type Locator, type Page } from "@playwright/test";
import { readRemoteBlocks, seedRadarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Plan my day as the two surfaces run it (distinctive roadmap F4, criteria 2
 * through 8 as the UI half; F4b): the "Plan my day" button in the Unscheduled
 * tray and on Today, the preview of the blocks it proposes, the one batch that
 * applies them, and the undo that removes exactly those blocks.
 *
 * The clock is installed before the app loads, so "today" is a fixed UTC
 * Monday and the placement arithmetic below states a property of the fixture
 * rather than of the day the suite happens to run on: the profile window is
 * 08:00-21:00, planning starts at the next quarter hour, and nothing is ever
 * placed in the past.
 */

test.setTimeout(150_000);

/* A write is accepted locally up to 150 ms before the server acknowledges it
   (`ui/write.ts`), so a remote read taken the instant a toast announces the
   write can still miss it. Under load it did: `a second press plans nothing`
   read zero blocks. Poll rather than weaken: the assertion still demands the
   exact count, it just gives the emulator the beat it needs. */
const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

const ZONE = "UTC";
const DAY_MS = 86_400_000;

type PlanFixture = Parameters<typeof seedRadarFixture>[2];

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** The next Monday at `hour`:`minute` UTC, at least two days out, so the day
 *  being planned is deterministic and clear of the account's creation. */
function nextMonday(hour = 7, minute = 0): Date {
  const base = new Date();
  base.setUTCHours(hour, minute, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  while (base.getUTCDay() !== 1) base.setUTCDate(base.getUTCDate() + 1);
  return base;
}

/** The profile-zone day key `offset` days after the fake now. */
function dayKey(base: Date, offset = 0): string {
  return new Date(base.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

/** A block on the planned day, wall-clock `from`-`to` in UTC. */
function blockOn(base: Date, from: string, to: string) {
  const key = dayKey(base);
  return { start: `${key}T${from}:00Z`, end: `${key}T${to}:00Z` };
}

/** The instant the app writes for a wall-clock time of the planned day, in the
 *  profile zone: `toZonedInstant` keeps the zone's own offset suffix. */
function instant(base: Date, time: string): string {
  return `${dayKey(base)}T${time}:00+00:00`;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function openCalendar(page: Page) {
  await nav(page).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
  /* The outgoing page stays mounted for the turn's exit, and Today carries its
     own plan trigger: wait until only the day view's is left, so a press
     resolves to one button instead of two pages' worth. */
  await expect(page.getByRole("button", { name: "Plan my day" })).toHaveCount(1);
}

async function openHome(page: Page) {
  await nav(page).getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}

/** The Unscheduled tray: the panel the day view plans from. */
const tray = (page: Page) => page.getByRole("complementary", { name: "Unscheduled" });
/** The proposed blocks, before anything is written. */
const preview = (page: Page) => page.getByRole("group", { name: "Proposed plan" });
const planButton = (page: Page) => page.getByRole("button", { name: "Plan my day" });

/**
 * Seeds the fixture under a fake clock and signs the account in. The clock is
 * installed before the first navigation because "today" is read once, at
 * render; the ready signal is the card Today renders once the store delivered,
 * so no assertion races the Firestore snapshots.
 */
async function open(
  page: Page,
  base: Date,
  prefix: string,
  fixture: PlanFixture,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  await page.clock.install({ time: base });
  const email = newEmail(prefix);
  const { taskIds } = await seedRadarFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock on a shared host is slow, never
     wrong: the retry is a budget for the emulator, and a wrong app still fails
     every attempt. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
  return { email, taskIds };
}

/** Await server-side propagation, then read every stored block. */
async function remoteBlocks(email: string) {
  await expect
    .poll(() => readRemoteBlocks(email).then(blocks => blocks.length), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toBeGreaterThanOrEqual(0);
  return readRemoteBlocks(email);
}

/** Walks the focus ring forward until `target` has focus: a keyboard-only route
 *  to a control without reaching into the app to focus it. */
async function tabTo(page: Page, target: Locator, limit = 60) {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("the control was never reached by pressing Tab");
}

/** True when the element paints in exactly the token's colour. */
async function paintsIn(page: Page, selector: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ selector: sel, token: name }) => {
      const element = document.querySelector(sel);
      if (!element) return false;
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const painted = getComputedStyle(element).color;
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return painted === expected;
    },
    { selector, token },
  );
}

test("the tray previews the blocks around what is already booked and applies them as one batch it can undo", async ({ page }) => {
  const base = nextMonday();
  /* Two unscheduled tasks with a 10:00-11:00 block already on the day: the plan
     fills the 08:00 slot first and continues after the existing block, never
     over it (F4 criteria 2 and 6). */
  const { email } = await open(page, base, "plan-apply", {
    tasks: [{ title: "Report", estimate: 60 }, { title: "Taxes", estimate: 30 }],
    blocks: [blockOn(base, "10:00", "11:00")],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await expect(tray(page).getByRole("button", { name: "Plan my day" })).toBeVisible();
  await planButton(page).click();

  /* The preview is the proposal, not the write: two rows, exact times. */
  const rows = preview(page).locator(".plan-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("08:00–09:00");
  await expect(rows.nth(0)).toContainText("Report");
  await expect(rows.nth(1)).toContainText("09:00–09:30");
  await expect(rows.nth(1)).toContainText("Taxes");
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);

  await preview(page).getByRole("button", { name: "Apply 2 blocks" }).click();

  /* One toast for the whole batch, and the blocks are on the grid. */
  const toast = page.locator(".undo-toast");
  await expect(toast).toContainText("Planned 2 blocks.");
  await expect(page.locator(".calendar-block")).toHaveCount(3);
  await expect(page.locator(".tray-item")).toHaveCount(0);

  /* The toast reports the local acceptance, so the server read is a wait, not
     an instant: the batch becomes visible to a fresh query a beat later. */
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(3);
  const written = await readRemoteBlocks(email);
  expect(written).toHaveLength(3);
  expect(written.filter(block => block.taskId !== undefined).map(block => [block.start, block.end]).sort()).toEqual([
    [instant(base, "08:00"), instant(base, "09:00")],
    [instant(base, "09:00"), instant(base, "09:30")],
  ]);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".calendar-block")).toHaveCount(1);
  await expect
    .poll(() => readRemoteBlocks(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual([{ start: blockOn(base, "10:00", "11:00").start, end: blockOn(base, "10:00", "11:00").end }]);
});

test("a task that does not fit is named with the exact notice, due today first and in red, and nothing is written", async ({ page }) => {
  const base = nextMonday();
  /* 08:00-20:00 leaves one free hour: neither task fits whole, and a split
     needs chunks of 45 minutes or more in two free slots (F4 criteria 3 and 4). */
  const { email } = await open(page, base, "plan-unplaced", {
    tasks: [
      { title: "Report", deadline: dayKey(base), estimate: 90 },
      { title: "Taxes", estimate: 120 },
    ],
    blocks: [blockOn(base, "08:00", "20:00")],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();

  await expect(preview(page).locator(".plan-notice")).toHaveText("2 tasks didn't fit today: Report, Taxes. Plan tomorrow?");
  await expect(page.getByRole("status").filter({ hasText: "Nothing to plan." })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Apply / })).toHaveCount(0);

  /* The due-today task is listed first and carries the red; the undated one
     does not. Order is the tray's, colour is a second signal. */
  const names = preview(page).locator(".plan-notice span");
  await expect(names).toHaveCount(2);
  await expect(names.nth(0)).toHaveText("Report");
  await expect(names.nth(0)).toHaveClass(/is-overdue/);
  await expect(names.nth(1)).toHaveText("Taxes");
  await expect(names.nth(1)).not.toHaveClass(/is-overdue/);
  expect(await paintsIn(page, ".plan-notice .is-overdue", "--red")).toBe(true);

  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);
});

test("a second press plans nothing and says so", async ({ page }) => {
  const base = nextMonday();
  const { email } = await open(page, base, "plan-twice", {
    tasks: [{ title: "Report", estimate: 60 }],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();
  await preview(page).getByRole("button", { name: "Apply 1 block" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Planned 1 block.");
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);

  await planButton(page).click();
  await expect(page.getByRole("status").filter({ hasText: "Nothing to plan." })).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);
});

test("nothing is planned into the past: at 14:07 the first block starts at 14:15", async ({ page }) => {
  const base = nextMonday(14, 7);
  await open(page, base, "plan-past", {
    tasks: [{ title: "Report", estimate: 60 }],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();
  await expect(preview(page).locator(".plan-row").nth(0)).toContainText("14:15–15:15");
});

test("the keyboard alone can preview, cancel, reopen and apply the plan", async ({ page }) => {
  const base = nextMonday();
  const { email } = await open(page, base, "plan-keyboard", {
    tasks: [{ title: "Report", estimate: 60 }],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await tabTo(page, tray(page).getByRole("button", { name: "Plan my day" }));
  await page.keyboard.press("Enter");

  /* The proposal takes focus, so the apply is the next keypress, and Escape
     puts focus back on the control that opened it. */
  const apply = preview(page).getByRole("button", { name: "Apply 1 block" });
  await expect(apply).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview(page)).toHaveCount(0);
  await expect(tray(page).getByRole("button", { name: "Plan my day" })).toBeFocused();
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(0);

  await page.keyboard.press("Enter");
  await expect(apply).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".undo-toast")).toContainText("Planned 1 block.");
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);
});

test("the proposed blocks enter as a stagger, and reduced motion fades them without one", async ({ page }) => {
  const base = nextMonday();
  const tasks = Array.from({ length: 8 }, (_, index) => ({ title: `Task ${index + 1}`, estimate: 30 }));
  await open(page, base, "plan-motion", { tasks }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();
  const rows = preview(page).locator(".plan-row");
  await expect(rows).toHaveCount(8);

  /* 40 ms apart for the first six, never longer than 400 ms in total: the
     eighth row rides the sixth row's delay. */
  const motion = await rows.evaluateAll(elements =>
    elements.map(element => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        delay: Number.parseFloat(style.animationDelay) * 1000,
        duration: Number.parseFloat(style.animationDuration) * 1000,
      };
    }),
  );
  expect(motion.map(row => row.delay)).toEqual([0, 40, 80, 120, 160, 200, 200, 200]);
  for (const row of motion) {
    expect(row.name).toBe("plan-rise");
    expect(row.duration).toBe(200);
    expect(row.delay + row.duration).toBeLessThanOrEqual(400);
  }
});

test("reduced motion keeps a short fade and no stagger", async ({ page }) => {
  const base = nextMonday();
  const tasks = Array.from({ length: 4 }, (_, index) => ({ title: `Task ${index + 1}`, estimate: 30 }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, base, "plan-motion-reduced", { tasks }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();
  const rows = preview(page).locator(".plan-row");
  await expect(rows).toHaveCount(4);
  const motion = await rows.evaluateAll(elements =>
    elements.map(element => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        delay: Number.parseFloat(style.animationDelay) * 1000,
        duration: Number.parseFloat(style.animationDuration) * 1000,
      };
    }),
  );
  expect(motion.map(row => row.delay)).toEqual([0, 0, 0, 0]);
  for (const row of motion) {
    expect(row.name).toBe("plan-fade");
    expect(row.duration).toBe(150);
  }
});

test("Today offers the same plan, with its own undo", async ({ page }) => {
  const base = nextMonday();
  const { email } = await open(page, base, "plan-home", {
    tasks: [{ title: "Report", estimate: 60 }, { title: "Taxes", estimate: 30 }],
  }, { width: 1440, height: 900 });

  await expect(planButton(page)).toBeVisible();
  await planButton(page).click();
  await expect(preview(page).locator(".plan-row")).toHaveCount(2);
  await preview(page).getByRole("button", { name: "Apply 2 blocks" }).click();

  const toast = page.locator(".undo-toast");
  await expect(toast).toContainText("Planned 2 blocks.");
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(2);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(() => readRemoteBlocks(email), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toEqual([]);
});

test("on a phone the tray sits below the grid and plans from the same button", async ({ page }) => {
  const base = nextMonday();
  const { email } = await open(page, base, "plan-phone", {
    tasks: [{ title: "Report", estimate: 60 }],
  }, { width: 390, height: 844 });

  await openCalendar(page);
  const button = tray(page).getByRole("button", { name: "Plan my day" });
  await expect(button).toBeVisible();
  const grid = await page.locator(".card.cal").boundingBox();
  const trayBox = await tray(page).boundingBox();
  expect(grid).not.toBeNull();
  expect(trayBox).not.toBeNull();
  expect(trayBox!.y).toBeGreaterThan(grid!.y);

  const target = await button.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);

  await button.click();
  await expect(preview(page).locator(".plan-row").nth(0)).toContainText("08:00–09:00");
  await preview(page).getByRole("button", { name: "Apply 1 block" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Planned 1 block.");
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);
});

test("Apply re-checks the proposal: a block added under an open plan is never overlapped, and the day is re-proposed", async ({ page }) => {
  const base = nextMonday();
  /* Report (60) and Taxes (30) are proposed at 08:00-09:00 and 09:00-09:30.
     A block then lands on the first slot through the calendar's own form, while
     the proposal stays open: Apply must write nothing and show the new plan. */
  const { email } = await open(page, base, "plan-recheck", {
    tasks: [{ title: "Report", estimate: 60 }, { title: "Taxes", estimate: 30 }],
  }, { width: 1440, height: 900 });

  await openCalendar(page);
  await planButton(page).click();
  const rows = preview(page).locator(".plan-row");
  await expect(rows.nth(0)).toContainText("08:00–09:00");

  await page.getByRole("button", { name: "New block" }).click();
  await expect(page.getByRole("button", { name: "Add block" })).toBeVisible();
  await page.getByLabel("Start", { exact: true }).fill(`${dayKey(base)}T08:00`);
  await page.getByLabel("End", { exact: true }).fill(`${dayKey(base)}T08:30`);
  await page.getByRole("button", { name: "Add block" }).click();
  await expect(page.locator(".calendar-block")).toHaveCount(1);
  await expect.poll(() => readRemoteBlocks(email).then(blocks => blocks.length), { timeout: 15_000 }).toBe(1);

  await preview(page).getByRole("button", { name: "Apply 2 blocks" }).click();

  /* The day changed, so the shown plan is replaced and nothing is written: the
     only stored block is the manual one, and no planned block sits on it. */
  await expect(page.getByRole("status").filter({ hasText: "Your day changed. Review the updated plan." })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("08:30–09:30");
  await expect(rows.nth(0)).toContainText("Report");
  await expect(rows.nth(1)).toContainText("09:30–10:00");
  await expect(rows.nth(1)).toContainText("Taxes");
  await expect(preview(page).getByRole("button", { name: "Apply 2 blocks" })).toBeFocused();
  await expect(page.locator(".undo-toast")).toHaveCount(0);
  await expect.poll(async () => (await readRemoteBlocks(email)).filter(block => block.taskId !== undefined).length, poll).toBe(0);
  await expect.poll(async () => (await readRemoteBlocks(email)).length, poll).toBe(1);

  /* The updated proposal is an ordinary proposal: Apply writes it as one batch. */
  await preview(page).getByRole("button", { name: "Apply 2 blocks" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Planned 2 blocks.");
  const written = (await readRemoteBlocks(email)).filter(block => block.taskId !== undefined);
  expect(written.map(block => [block.start, block.end]).sort()).toEqual([
    [instant(base, "08:30"), instant(base, "09:30")],
    [instant(base, "09:30"), instant(base, "10:00")],
  ]);
});

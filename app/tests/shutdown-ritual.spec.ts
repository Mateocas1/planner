import { expect, test, type Page } from "@playwright/test";
import { readRemoteShutdown, readRemoteTask, seedShutdownFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The shutdown ritual (distinctive roadmap F3, criteria 1-8 as the UI half;
 * F3c): the Home banner, the sheet with its Today and Tomorrow pages, the page
 * turn that closes the day, the exact undo, and the morning brief.
 *
 * The clock is installed before the app loads and left running, so "at 18:30 on
 * this day" is a property of the fixture rather than of the hour the suite
 * happens to run at. Every write is asserted against the server, never against
 * the app's own render: the roll is a batch of deadline changes plus one
 * profile stamp, and what matters is what the server holds afterwards.
 */

test.setTimeout(240_000);

const ZONE = "UTC";
const DAY_MS = 86_400_000;

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A wall-clock hour two days out: clear of the account's creation, and of the
 *  real midnight the suite could otherwise drift across. */
function at(hour: number, minute = 0): Date {
  const base = new Date();
  base.setUTCHours(hour, minute, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

/** The profile zone's day key `offset` days after the fake now. */
function dayKey(base: Date, offset = 0): string {
  return new Date(base.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

/** A block on the fake day, wall-clock `from`-`to` in UTC. */
function blockOn(base: Date, from: string, to: string) {
  const key = dayKey(base);
  return { start: `${key}T${from}:00Z`, end: `${key}T${to}:00Z` };
}

/** A completion instant on the fake day: what marks a task as done today. */
function doneAt(base: Date, time: string): string {
  return `${dayKey(base)}T${time}:00Z`;
}

/** The weekday the announcement names, read the way the app reads it. */
function weekday(key: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${key}T00:00:00Z`));
}

const ritual = (page: Page) => page.getByRole("complementary", { name: "Close the day" });
const banner = (page: Page) => page.locator(".shutdown-banner");
const turnPage = (page: Page) => ritual(page).locator(".page-turn-top");
/** Today's own page turn, before the ritual is on screen. */
const homePage = (page: Page) => page.locator(".page-turn-top").first();

/** The sheet's named groups: the two lists criterion 1 is about. */
const group = (page: Page, name: string) => ritual(page).getByRole("region", { name });

/** Signs a seeded account in under the fake clock, and waits for Today. */
async function open(
  page: Page,
  base: Date,
  prefix: string,
  fixture: Parameters<typeof seedShutdownFixture>[2],
): Promise<{ email: string; taskIds: Record<string, string> }> {
  await page.clock.install({ time: base });
  const email = newEmail(prefix);
  const { taskIds } = await seedShutdownFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock on a shared host is slow, never
     wrong: the retry is a budget for the emulator. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
  return { email, taskIds };
}

/** Waits for the panel's entrance (and its content's blur) to be over, so a
 *  measurement of the page is a measurement of the page at rest. */
async function panelSettled(page: Page): Promise<void> {
  await expect(ritual(page)).toBeVisible();
  await ritual(page).evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
}

/** Opens the ritual from Home's own banner action (the fine pointer's entry). */
async function openFromBanner(page: Page): Promise<void> {
  await banner(page).getByRole("button", { name: "Close day" }).click();
  await panelSettled(page);
}

/**
 * A leftward mouse drag on the ritual's page, from the empty middle of its
 * header: the same gesture the phone performs with a thumb, released slowly so
 * only the distance can commit it.
 */
async function dragPageLeft(page: Page, fraction: number, surface = turnPage(page)): Promise<void> {
  const box = (await surface.boundingBox())!;
  const from = { x: box.x + box.width * 0.7, y: box.y + 40 };
  const dx = -box.width * fraction;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + (dx * step) / 10, from.y);
  await page.mouse.up();
}

/** Real touch input over CDP: trusted pointer events with a live pointer id. */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  const at_ = (index: number) => ({
    x: from.x + ((to.x - from.x) * index) / steps,
    y: from.y + ((to.y - from.y) * index) / steps,
    id: 1,
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at_(0)] });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at_(step)] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Reads the server until the roll's writes have landed. */
async function stored(email: string) {
  await expect
    .poll(() => readRemoteShutdown(email).then(state => state.deadlines), { timeout: 15_000, intervals: [250, 500, 1_000] })
    .toBeTruthy();
  return readRemoteShutdown(email);
}

/** A day with three things finished and two left over: criterion 1's fixture. */
function busyDay(base: Date) {
  return {
    tasks: [
      { title: "Write the brief", completed: true, completedAt: doneAt(base, "09:00") },
      { title: "Call the bank", completed: true, completedAt: doneAt(base, "10:00") },
      { title: "Send the invoice", completed: true, completedAt: doneAt(base, "11:00") },
      { title: "Review the draft", deadline: dayKey(base) },
      { title: "Fix the chart axis", deadline: dayKey(base) },
      { title: "Plan the quarter", deadline: dayKey(base, 3) },
    ],
    // One leftover had a block today; the other is simply due today.
    blocks: [blockOn(base, "09:00", "10:00")],
  };
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("at 18:30 the banner offers the ritual, and the sheet counts the day by two", async ({ page }) => {
    const base = at(18, 30);
    const fixture = busyDay(base);
    // The block belongs to the second leftover task, which is what makes it one.
    await open(page, base, "ritual-copy", {
      tasks: fixture.tasks,
      blocks: [{ ...fixture.blocks[0], task: "Fix the chart axis" }],
    });

    /* Criterion 8: a fine pointer gets a visible action, not only the gesture. */
    await expect(banner(page).getByText("Time to close the day.")).toBeVisible();
    await expect(banner(page).getByRole("button", { name: "Close day" })).toBeVisible();

    await openFromBanner(page);

    /* Criterion 1: `3 done · 2 left over`, and both groups listed. */
    await expect(ritual(page).getByText("3 done · 2 left over")).toBeVisible();
    await expect(group(page, "Done").getByRole("listitem")).toHaveCount(3);
    await expect(group(page, "Done").getByText("Write the brief")).toBeVisible();
    await expect(group(page, "Done").getByText("Call the bank")).toBeVisible();
    await expect(group(page, "Done").getByText("Send the invoice")).toBeVisible();
    await expect(group(page, "Left over").getByRole("listitem")).toHaveCount(2);
    await expect(group(page, "Left over").getByText("Review the draft")).toBeVisible();
    await expect(group(page, "Left over").getByText("Fix the chart axis")).toBeVisible();
    // A future deadline belongs to neither list.
    await expect(ritual(page).getByText("Plan the quarter")).toHaveCount(0);
  });

  test("a day with nothing left over says so instead of counting", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "ritual-empty", {
      tasks: [
        { title: "Write the brief", completed: true, completedAt: doneAt(base, "09:00") },
        { title: "Plan the quarter", deadline: dayKey(base, 3) },
      ],
    });
    await openFromBanner(page);

    /* Criterion 2, verbatim. */
    await expect(ritual(page).getByText("Nothing left over. Close the day.")).toBeVisible();
    await expect(group(page, "Done")).toContainText("Write the brief");
  });

  test("turning the page closes the day: the deadlines move, the day is stamped and nothing else changes", async ({ page }) => {
    const base = at(18, 30);
    const today = dayKey(base);
    const tomorrow = dayKey(base, 1);
    const { email } = await open(page, base, "ritual-turn", {
      tasks: busyDay(base).tasks,
      blocks: [{ ...blockOn(base, "09:00", "10:00"), task: "Fix the chart axis" }],
    });
    await openFromBanner(page);

    await dragPageLeft(page, 0.55);

    /* Criterion 3: one live region, the sentence it owes, and the toast. */
    const status = ritual(page).getByRole("status");
    await expect(status).toHaveText(`Day closed. 2 tasks moved to ${weekday(tomorrow)}.`);
    const toast = page.locator(".undo-toast");
    await expect(toast).toContainText("Day closed.");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    // The turn landed on tomorrow, and the heading has the focus.
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeFocused();

    /* The roll: the two due deadlines moved to tomorrow, the future deadline and
       the completion instants did not, and the profile carries the stamp. */
    const state = await stored(email);
    expect(state.deadlines["Review the draft"]).toBe(tomorrow);
    expect(state.deadlines["Fix the chart axis"]).toBe(tomorrow);
    expect(state.deadlines["Plan the quarter"]).toBe(dayKey(base, 3));
    expect(state.deadlines["Write the brief"]).toBeUndefined();
    expect(state.completedAt["Write the brief"]).toBe(doneAt(base, "09:00"));
    expect(state.lastShutdown).toBe(today);
  });

  test("the Close day button commits the same roll from rest", async ({ page }) => {
    const base = at(18, 30);
    const tomorrow = dayKey(base, 1);
    const { email } = await open(page, base, "ritual-button", {
      tasks: busyDay(base).tasks,
      blocks: [{ ...blockOn(base, "09:00", "10:00"), task: "Fix the chart axis" }],
    });
    await openFromBanner(page);

    await ritual(page).getByRole("button", { name: "Close day" }).click();

    await expect(ritual(page).getByRole("status")).toHaveText(`Day closed. 2 tasks moved to ${weekday(tomorrow)}.`);
    const state = await stored(email);
    expect(state.deadlines["Review the draft"]).toBe(tomorrow);
    expect(state.lastShutdown).toBe(dayKey(base));
  });

  test("Undo puts every deadline back, drops the stamp, and the banner returns", async ({ page }) => {
    const base = at(18, 30);
    const today = dayKey(base);
    const { email } = await open(page, base, "ritual-undo", {
      tasks: busyDay(base).tasks,
      blocks: [{ ...blockOn(base, "09:00", "10:00"), task: "Fix the chart axis" }],
    });
    await openFromBanner(page);
    await ritual(page).getByRole("button", { name: "Close day" }).click();
    await expect(ritual(page).getByRole("status")).toHaveText(/Day closed\./);
    expect((await stored(email)).lastShutdown).toBe(today);

    await page.locator(".undo-toast").getByRole("button", { name: "Undo" }).click();

    /* Criterion 4: the exact inverse -- the deadlines are today's again and the
       day is open, so the sheet is back on Today. */
    await expect(ritual(page).getByText("3 done · 2 left over")).toBeVisible();
    const state = await stored(email);
    expect(state.deadlines["Review the draft"]).toBe(today);
    expect(state.deadlines["Fix the chart axis"]).toBe(today);
    expect(state.lastShutdown).toBeUndefined();

    await ritual(page).getByRole("button", { name: "Cancel" }).click();
    await expect(ritual(page)).toHaveCount(0);
    await expect(banner(page).getByText("Time to close the day.")).toBeVisible();
  });

  test("a day already closed on another device shows no banner", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "ritual-closed", { lastShutdown: dayKey(base), tasks: [{ title: "Review the draft", deadline: dayKey(base) }] });

    /* Criterion 6: the stamp is the profile zone's day, and the banner is gone. */
    await expect(page.locator(".now-card, .empty-state").first()).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("a refused close springs the page back and says nothing changed", async ({ page }) => {
    const base = at(18, 30);
    const today = dayKey(base);
    /* One batch holds at most 500 writes, so a day with more due tasks than that
       is refused whole (`planning/shutdown.ts`): nothing is written, and the
       sheet says so with criterion 5's sentence. */
    const tasks = Array.from({ length: 500 }, (_, index) => ({ title: `Due task ${index + 1}`, deadline: today }));
    const { email, taskIds } = await open(page, base, "ritual-refused", { tasks });
    await openFromBanner(page);

    await dragPageLeft(page, 0.55);

    await expect(ritual(page).getByText("Couldn't close the day. Nothing changed.")).toBeVisible();
    // The page came home: the turn did not happen.
    await expect(ritual(page).locator(".page-turn")).toHaveAttribute("data-page-turn-state", "rest");
    /* The REST list paginates, so the two spot checks read their documents
       directly: a refusal may not have moved anybody's deadline. */
    expect((await readRemoteTask(email, taskIds["Due task 1"]))?.deadline).toBe(today);
    expect((await readRemoteTask(email, taskIds["Due task 500"]))?.deadline).toBe(today);
    expect((await readRemoteShutdown(email)).lastShutdown).toBeUndefined();
  });

  test("the morning brief states the day once, and is dismissed for that day", async ({ page }) => {
    const base = at(10, 0);
    await open(page, base, "ritual-brief", {
      tasks: [{ title: "Review the draft", deadline: dayKey(base) }],
      blocks: [
        blockOn(base, "09:00", "10:30"),
        blockOn(base, "12:00", "13:00"),
        blockOn(base, "14:00", "15:00"),
        blockOn(base, "16:00", "17:00"),
      ],
    });

    /* Criterion 7, verbatim. */
    await expect(page.getByText("Today: 4 blocks, first at 09:00. First free slot 10:30.")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss morning brief" }).click();
    await expect(page.locator(".brief")).toHaveCount(0);

    // A dismissal is for the day, and it survives a reload of that day.
    await page.reload();
    await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".brief")).toHaveCount(0);
  });

  test("a day with no blocks has nothing to brief", async ({ page }) => {
    const base = at(10, 0);
    await open(page, base, "ritual-brief-empty", { tasks: [{ title: "Review the draft" }] });
    await expect(page.locator(".now-card, .empty-state").first()).toBeVisible();
    await expect(page.locator(".brief")).toHaveCount(0);
  });

  test("the gesture opens the ritual before anything is written", async ({ page }) => {
    const base = at(18, 30);
    const today = dayKey(base);
    const { email } = await open(page, base, "ritual-gesture-open", {
      tasks: [{ title: "Review the draft", deadline: today }],
    });

    /* Home's page turn is the ritual's entry: the day it would roll is shown
       first, so nobody rolls a day they have not seen. */
    await dragPageLeft(page, 0.55, homePage(page));
    await expect(ritual(page)).toBeVisible();
    await expect(ritual(page).getByText("0 done · 1 left over")).toBeVisible();
    expect((await stored(email)).lastShutdown).toBeUndefined();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the same sheet, swiped open and swiped closed", async ({ page }) => {
    const base = at(18, 30);
    const tomorrow = dayKey(base, 1);
    const { email } = await open(page, base, "ritual-phone", {
      tasks: busyDay(base).tasks,
      blocks: [{ ...blockOn(base, "09:00", "10:00"), task: "Fix the chart axis" }],
    });

    /* Criterion 8 on the narrow side: the banner is there, the visible button is
       not (a thumb turns the page instead), and the sheet is the same one. */
    await expect(banner(page).getByText("Time to close the day.")).toBeVisible();
    await expect(banner(page).getByRole("button", { name: "Close day" })).toHaveCount(0);

    /* The swipe starts on the banner's own words, which belong to nobody else. */
    const bar = (await banner(page).boundingBox())!;
    await swipe(page, { x: bar.x + bar.width - 30, y: bar.y + bar.height / 2 }, { x: bar.x + 20, y: bar.y + bar.height / 2 });
    await panelSettled(page);
    await expect(ritual(page).getByText("3 done · 2 left over")).toBeVisible();

    /* And the ritual's own page turns from its middle: text, never a control. */
    const box = (await turnPage(page).boundingBox())!;
    const y = box.y + box.height * 0.35;
    await swipe(page, { x: box.x + box.width * 0.6, y }, { x: box.x + 20, y });

    await expect(ritual(page).getByRole("status")).toHaveText(`Day closed. 2 tasks moved to ${weekday(tomorrow)}.`);
    const state = await stored(email);
    expect(state.deadlines["Review the draft"]).toBe(tomorrow);
    expect(state.lastShutdown).toBe(dayKey(base));
  });
});

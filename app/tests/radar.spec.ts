import { expect, test, type Page } from "@playwright/test";
import { seedRadarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The overcommit radar as the two surfaces render it (distinctive roadmap F1,
 * criteria 1, 2, 3, 6, 7 and 8): the Today "This week" row of seven segments and
 * the Calendar day-header underline.
 *
 * The clock is installed before the app loads and the fixture is one whole
 * planner week that starts at the fake "now". The radar's week is Monday to
 * Sunday in the profile zone, which is UTC here, so every label below states a
 * property of the fixture rather than of the day the suite happens to run on.
 * The expected numbers are the ones `planning/capacity.ts` documents (5 h of a
 * 13 h window is 38%, 11 h 30 min is 88% and past `PACKED_PERCENT`).
 */

test.setTimeout(150_000);

const ZONE = "UTC";
const DAY_MS = 86_400_000;

type RadarFixture = Parameters<typeof seedRadarFixture>[2];

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** The next Monday at 08:00 UTC, at least two days out: the week the radar
 *  draws is deterministic and the clock is clear of the account's creation. */
function nextMonday(): Date {
  const base = new Date();
  base.setUTCHours(8, 0, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  while (base.getUTCDay() !== 1) base.setUTCDate(base.getUTCDate() + 1);
  return base;
}

/** The profile-zone day key `offset` days after the fake now. */
function dayKey(base: Date, offset: number): string {
  return new Date(base.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

/** The day of the month of that key, which is what the column header shows. */
function dayOfMonth(base: Date, offset: number): number {
  return Number(dayKey(base, offset).slice(8));
}

/** A block on the day `offset` days after now, wall-clock `from`-`to` in UTC. */
function blockOn(base: Date, offset: number, from: string, to: string) {
  const key = dayKey(base, offset);
  return { start: `${key}T${from}:00Z`, end: `${key}T${to}:00Z` };
}

/**
 * Seeds the fixture under a fake clock and signs the account in.
 *
 * The clock is installed before the first navigation because the radar reads
 * "now" once, at render; a real clock would move the week under the assertions
 * whenever the suite ran near midnight. The ready signal is the card the Today
 * surface renders once the store has delivered, so no assertion below races the
 * Firestore snapshots.
 */
async function open(page: Page, base: Date, prefix: string, fixture: RadarFixture, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.clock.install({ time: base });
  const email = newEmail(prefix);
  await seedRadarFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock on a shared host is slow, never
     wrong: the retry is a budget for the emulator, and a wrong app still fails
     every attempt. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
}

const week = (page: Page) => page.getByRole("list", { name: "Booked share of each day this week" });

/** Every segment's accessible name, in week order. */
async function segmentLabels(page: Page): Promise<string[]> {
  return week(page).getByRole("img").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label") ?? ""));
}

/** True when the element paints in exactly the token's colour, as the browser
 *  resolves it: the token stays the source of truth, not a hex copy here.
 *  Text reads `color`; a filled bar reads `backgroundColor`. */
async function paintsIn(page: Page, selector: string, token: string, property: "color" | "backgroundColor" = "color"): Promise<boolean> {
  return page.evaluate(
    ({ selector: sel, token: name, property: prop }) => {
      const element = document.querySelector(sel);
      if (!element) return false;
      const probe = document.createElement("span");
      probe.style[prop] = `var(${name})`;
      document.body.append(probe);
      const painted = getComputedStyle(element)[prop];
      const expected = getComputedStyle(probe)[prop];
      probe.remove();
      return painted === expected;
    },
    { selector, token, property },
  );
}

test("the week row reports each day's booked share and names it for assistive tech", async ({ page }) => {
  const base = nextMonday();
  /* 09:00-12:00 and 11:00-14:00 overlap: 5 h booked of the 13 h window, once,
     never 6 h (criterion 1). */
  await open(page, base, "radar-week", {
    blocks: [blockOn(base, 1, "09:00", "12:00"), blockOn(base, 1, "11:00", "14:00")],
  }, { width: 390, height: 844 });

  await expect(page.getByRole("heading", { name: "This week" })).toBeVisible();
  await expect(week(page).getByRole("listitem")).toHaveCount(7);
  expect(await segmentLabels(page)).toEqual([
    "Mon, 0% booked",
    "Tue, 38% booked",
    "Wed, 0% booked",
    "Thu, 0% booked",
    "Fri, 0% booked",
    "Sat, 0% booked",
    "Sun, 0% booked",
  ]);

  // The share is written, not only painted: the bar is the second signal.
  const tuesday = page.getByRole("img", { name: "Tue, 38% booked" });
  await expect(tuesday).toContainText("Tue");
  await expect(tuesday).toContainText("38%");
  await expect(page.locator(".radar-week .capacity-bar-fill").nth(1)).toHaveAttribute("style", /scaleX\(0?\.38\)/);

  /* Criterion 7's 44 px target, and a row that fits a phone without scrolling
     sideways: seven segments plus the page padding have to be inside 390 px. */
  const boxes = await week(page).getByRole("img").evaluateAll(elements =>
    elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, right: rect.right, width: rect.width, height: rect.height };
    }),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(boxes[0].x).toBeGreaterThanOrEqual(0);
  expect(boxes[6].right).toBeLessThanOrEqual(390);

  // Nothing is overcommitted, so nothing claims it is (criterion 3's other half).
  await expect(page.getByText(/over for/)).toHaveCount(0);
});

test("a day past 85% says Packed in words and in --orange", async ({ page }) => {
  const base = nextMonday();
  /* Thursday 08:00-19:30 is 11 h 30 min of the 13 h window: 88%, packed. */
  await open(page, base, "radar-packed", {
    blocks: [blockOn(base, 3, "08:00", "19:30")],
  }, { width: 1440, height: 900 });

  const thursday = page.getByRole("img", { name: "Thu, Packed, 88% booked" });
  await expect(thursday).toBeVisible();
  // colour is never the only signal
  await expect(thursday).toContainText("Packed");
  expect(await paintsIn(page, ".radar-day-value.is-packed", "--orange")).toBe(true);
  // and only that day is packed
  await expect(page.getByRole("img", { name: /Packed/ })).toHaveCount(1);
});

test("a deadline that no longer fits is named with its shortfall", async ({ page }) => {
  const base = nextMonday();
  /* Monday to Thursday fully booked leave Friday 18:30-21:00 free, so the 3 h 30
     task due Friday is one hour over (criterion 3). */
  const blocks = [0, 1, 2, 3].map(offset => blockOn(base, offset, "08:00", "21:00")).concat(blockOn(base, 4, "08:00", "18:30"));
  await open(page, base, "radar-over", {
    blocks,
    tasks: [{ title: "Ship the report", deadline: dayKey(base, 4), estimate: 210 }],
  }, { width: 1440, height: 900 });

  await expect(page.getByText("1h over for Fri. Move something or push a deadline.")).toBeVisible();
  // the message is about the week on screen, and Friday itself is not packed
  await expect(page.getByRole("img", { name: "Fri, 81% booked" })).toBeVisible();
});

test("an empty planner shows no radar at all", async ({ page }) => {
  const base = nextMonday();
  await open(page, base, "radar-empty", {}, { width: 1440, height: 900 });

  await expect(page.getByText("No tasks and no work blocks yet. Your planner is empty.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This week" })).toHaveCount(0);
});

test("with no estimates anywhere the radar asks for them instead", async ({ page }) => {
  const base = nextMonday();
  await open(page, base, "radar-no-estimates", {
    tasks: [{ title: "Call the bank", deadline: dayKey(base, 1) }],
    blocks: [blockOn(base, 1, "09:00", "10:00")],
  }, { width: 1440, height: 900 });

  await expect(page.getByText("Add estimates to see how full your week is.")).toBeVisible();
  // The load itself is still measured: the prompt replaces the estimate talk,
  // not the bars.
  await expect(page.getByRole("img", { name: "Tue, 8% booked" })).toBeVisible();
  await expect(page.getByText(/Assumed 1h for/)).toHaveCount(0);
});

test("a repeating task with no estimate is reported, not counted as zero work", async ({ page }) => {
  const base = nextMonday();
  await open(page, base, "radar-series", {
    series: [
      { title: "Morning stretch", frequency: "daily", anchorDate: dayKey(base, 0) },
      { title: "Weekly planning", frequency: "weekly", anchorDate: dayKey(base, 0) },
    ],
  }, { width: 1440, height: 900 });

  await expect(page.getByText("2 repeating tasks have no estimate.")).toBeVisible();
});

test("each Calendar day header carries the load as an underline and as minutes", async ({ page }) => {
  const base = nextMonday();
  await open(page, base, "radar-header", {
    blocks: [blockOn(base, 1, "09:00", "12:00"), blockOn(base, 1, "11:00", "14:00"), blockOn(base, 3, "08:00", "19:30")],
  }, { width: 1440, height: 900 });

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  // One underline per day column, 3 px thick, with the minutes in words.
  const underlines = page.locator(".cal-head .day-load");
  await expect(underlines).toHaveCount(7);
  await expect(underlines.first()).toHaveCSS("height", "3px");
  await expect(page.getByRole("img", { name: `Tue ${dayOfMonth(base, 1)}, 5 h booked, 8 h free` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Thu ${dayOfMonth(base, 3)}, Packed, 11 h 30 min booked, 1 h 30 min free` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Mon ${dayOfMonth(base, 0)}, 0 min booked, 13 h free` })).toBeVisible();

  // The fill is the booked share of the window, not a full underline.
  await expect(underlines.nth(1).locator(".capacity-bar-fill")).toHaveAttribute("style", /scaleX\(0?\.38\)/);
  expect(await paintsIn(page, ".cal-head .capacity-bar.is-packed .capacity-bar-fill", "--orange", "backgroundColor")).toBe(true);
});

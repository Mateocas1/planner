import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hitArea, seedSidebarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The sidebar fill (value roadmap §3): the two blocks that answer "what comes
 * next" from the chrome the Tasks and Calendar surfaces already show, the dense
 * footer row (account, sync, theme), and the PWA update prompt that surfaces a
 * waiting service worker instead of silently running a stale build (§2 row 1).
 *
 * Every assertion is what the user reads or measures: the section names, the
 * rows in their order, the times in the profile zone, the buttons, the hit
 * areas, and the page width. The clock tests install a fake clock before the
 * app loads and freeze it after sign-in, so "in 25 min" is an exact statement
 * and not a race against the test's own runtime.
 */

test.setTimeout(150_000);

/* A desktop-tall window by default: at the Playwright default (1280x720) the
   sidebar is already in its "short window" state, where Due soon is dropped on
   purpose. The phone and height tests set their own sizes. */
test.use({ viewport: { width: 1440, height: 900 } });

const ZONE = "UTC";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Seeds the fixture, then signs the (remotely created) account in. */
async function enter(
  page: Page,
  prefix: string,
  fixture: Parameters<typeof seedSidebarFixture>[2] = {},
  options: { url?: string } = {},
) {
  const email = newEmail(prefix);
  await seedSidebarFixture(email, ZONE, fixture);
  await submitAuthForm(page, email, "sign in", options);
  return email;
}

/** How far the sidebar's content overflows its own column (0 or less is fine). */
function sidebarOverflow(page: Page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    return sidebar.scrollHeight - sidebar.clientHeight;
  });
}

const upNext = (page: Page) => page.getByRole("region", { name: "Up next" });
const dueSoon = (page: Page) => page.getByRole("region", { name: "Due soon" });

/** HH:MM of an instant in the seeded profile zone (UTC). */
function hhmm(at: Date) {
  return at.toISOString().slice(11, 16);
}

/** A wall-clock day key `days` away from the browser's real today. */
function dayKey(days = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * A fake "now" at 09:00 in the profile zone, on the first day that is still
 * comfortably in the future: the Auth emulator rejects a token whose issue time
 * is before the account it was minted for, and the blocks this test seeds need
 * the whole morning and afternoon inside one day.
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

test("Up next shows the next block in the profile zone and follows the clock", async ({ page }) => {
  /* A fake clock one hour ahead of the real one, so a sign-in never looks like
     it came from the past, then frozen: every label below is exact. */
  const base = futureMorning();
  await page.clock.install({ time: base });
  await enter(page, "up-next", {
    tasks: [{ title: "Design review" }, { title: "Write the brief" }],
    blocks: [
      { ...block(base, -120, -60), task: "Design review" },
      { ...block(base, 60, 120), task: "Design review" },
      { ...block(base, 210, 240) },
    ],
  });
  /* The store loads on a live clock: freezing time before the profile arrives
     would hold the Firestore scheduler. Once the block is on screen the clock is
     frozen, so every label below is exact. */
  const up = upNext(page);
  await expect(up.getByRole("heading", { name: "Up next" })).toBeVisible();
  await page.clock.pauseAt(new Date(base.getTime() + 5 * 60_000));
  await expect(up.getByText("Design review")).toBeVisible();
  await expect(up.getByText(`in 55 min · ${hhmm(new Date(base.getTime() + 60 * 60_000))} – ${hhmm(new Date(base.getTime() + 120 * 60_000))}`)).toBeVisible();
  /* The block that already ended is not "up next". */
  await expect(up.getByText(/^now · /)).toHaveCount(0);

  /* Two hours later the first block is over and the second one is next. */
  await page.clock.fastForward("01:55:00");
  await expect(up.getByText("Design review")).toHaveCount(0);
  await expect(up.getByText("Work block")).toBeVisible();
  await expect(up.getByText(`in 1 h 30 min · ${hhmm(new Date(base.getTime() + 210 * 60_000))} – ${hhmm(new Date(base.getTime() + 240 * 60_000))}`)).toBeVisible();

  /* Its own start makes it the running block, still with its time. */
  await page.clock.fastForward("01:45:00");
  await expect(up.getByText(`now · ${hhmm(new Date(base.getTime() + 210 * 60_000))} – ${hhmm(new Date(base.getTime() + 240 * 60_000))}`)).toBeVisible();

  /* And when the day has nothing left, it says so instead of going blank. */
  await page.clock.fastForward("00:15:00");
  await expect(up.getByText("Nothing else today.")).toBeVisible();
});

test("both blocks say plainly when they have nothing to show", async ({ page }) => {
  await enter(page, "side-empty", { tasks: [{ title: "Someday" }, { title: "Far future", deadline: dayKey(40) }] });

  await expect(upNext(page).getByText("Nothing else today.")).toBeVisible();
  await expect(dueSoon(page).getByText("Nothing due this week.")).toBeVisible();
  /* No deadline and a deadline past the week are not "due soon". */
  await expect(dueSoon(page).getByText("Someday")).toHaveCount(0);
  await expect(dueSoon(page).getByText("Far future")).toHaveCount(0);
});

test("Due soon is overdue-first, capped at five, checkable, and opens the task panel", async ({ page }) => {
  await enter(page, "due-soon", {
    tasks: [
      { title: "Renew passport", deadline: dayKey(6) },
      { title: "Send invoice", deadline: dayKey(-3) },
      { title: "Book the venue", deadline: dayKey(3) },
      { title: "Plan the trip", deadline: dayKey(40) },
      { title: "Call the bank", deadline: dayKey(-1) },
      { title: "Sign the lease", deadline: dayKey(0) },
      { title: "Fix the sink", deadline: dayKey(1) },
      { title: "Already done", deadline: dayKey(-2), completed: true },
    ],
  });

  const due = dueSoon(page);
  await expect(due.getByRole("heading", { name: "Due soon" })).toBeVisible();
  await expect(due.locator(".side-due-title")).toHaveText([
    "Send invoice",
    "Call the bank",
    "Sign the lease",
    "Fix the sink",
    "Book the venue",
  ]);
  /* Overdue reads as overdue; today does not. */
  await expect(due.locator(".side-due-meta").first()).toHaveClass(/is-overdue/);
  await expect(due.locator(".side-due-meta").nth(2)).not.toHaveClass(/is-overdue/);
  /* Over the cap and beyond the week are left out, completed is never listed. */
  await expect(due.getByText("Renew passport")).toHaveCount(0);
  await expect(due.getByText("Plan the trip")).toHaveCount(0);
  await expect(due.getByText("Already done")).toHaveCount(0);

  /* Checking a row completes the task, so it leaves the list and the next
     deadline (the sixth one) takes the free slot. */
  await due.getByRole("checkbox", { name: "Complete: Send invoice" }).click();
  await expect(due.getByText("Send invoice")).toHaveCount(0);
  await expect(due.locator(".side-due-title")).toHaveCount(5);
  await expect(due.locator(".side-due-title").last()).toHaveText("Renew passport");

  /* The row itself is a link to the task: the panel opens on Tasks. */
  await due.getByRole("button", { name: /Call the bank/ }).click();
  await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
});

test("the footer is one row: the account, the sync line and the theme control", async ({ page }) => {
  const email = await enter(page, "side-foot", { tasks: [{ title: "Anything" }] });

  const foot = page.locator(".side-foot");
  await expect(foot.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(foot.getByText("Synced")).toBeVisible();
  /* The theme control shares the row with the identity, not a row of its own. */
  const row = page.locator(".side-foot-row");
  await expect(row.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  await expect(row.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  /* It is still the same control: picking Dark paints the dark tokens. */
  await row.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(row.getByRole("radio", { name: "Dark", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("the sidebar makes room on a short screen instead of scrolling its chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await enter(page, "side-height", {
    tasks: [{ title: "Send invoice", deadline: dayKey(-1) }, { title: "Sign the lease", deadline: dayKey(0) }],
    blocks: [block(new Date(Date.now() + 3600_000), 30, 90)],
  });

  await expect(upNext(page)).toBeVisible();
  await expect(dueSoon(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(await sidebarOverflow(page), "the chrome fits its own column").toBeLessThanOrEqual(0);

  /* A 700 px sidebar has no room for due deadlines: Up next keeps the space. */
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect(upNext(page)).toBeVisible();
  await expect(dueSoon(page)).toBeHidden();
  await expect(page.locator(".side-foot")).toBeVisible();
  expect(await sidebarOverflow(page), "the chrome fits its own column").toBeLessThanOrEqual(0);

  /* And a short window drops the whole content stack, never the chrome. */
  await page.setViewportSize({ width: 1440, height: 600 });
  await expect(upNext(page)).toBeHidden();
  await expect(dueSoon(page)).toBeHidden();
  await expect(page.locator(".side-nav")).toBeVisible();
  await expect(page.locator(".side-foot")).toBeVisible();
  expect(await sidebarOverflow(page), "the chrome fits its own column").toBeLessThanOrEqual(0);
});

test("the sidebar never widens the page, even with a long title", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await enter(page, "side-overflow", {
    tasks: [
      {
        title: "Supercalifragilisticexpialidociousness_and_an_unbreakable_token_that_never_wraps",
        deadline: dayKey(0),
      },
    ],
    blocks: [block(new Date(Date.now() + 3600_000), 30, 90)],
  });

  await expect(dueSoon(page).getByText("Supercalifragilistic", { exact: false })).toBeVisible();
  const widths = await page.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector<HTMLElement>(".side-due .side-card")!;
    return { page: root.scrollWidth - root.clientWidth, card: card.scrollWidth - card.clientWidth };
  });
  expect(widths.page, "no horizontal page scroll").toBeLessThanOrEqual(0);
  expect(widths.card, "the card clips its own long title").toBeLessThanOrEqual(0);

  /* The same at the smallest phone, where there is no sidebar at all. */
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.locator(".sidebar"), "a phone has no sidebar").toHaveCount(0);
  await expect(page.locator(".tabbar")).toBeVisible();
  const phone = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(phone, "no horizontal scroll at 320 px").toBeLessThanOrEqual(0);
});

test("a phone keeps the same content on Home and the theme behind the account button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "side-phone", {
    tasks: [{ title: "Sign the lease", deadline: dayKey(0) }],
    blocks: [block(new Date(Date.now() + 3600_000), 30, 90)],
  });

  await expect(page.locator(".sidebar")).toHaveCount(0);
  /* Nothing is lost: Home already answers "now" and "what is due" there. */
  await expect(page.getByRole("heading", { name: "Due today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
  await expect(page.getByText("Sign the lease")).toBeVisible();

  /* The theme control is not lost either: it lives in the account popover. */
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.locator(".popover").getByRole("radiogroup", { name: "Theme" })).toBeVisible();
});

test.describe("a thumb on a coarse pointer", () => {
  test.use({ viewport: { width: 1500, height: 1000 }, isMobile: true, hasTouch: true });

  test("the sidebar rows and their checks are 44 px targets", async ({ page }) => {
    await enter(page, "side-coarse", { tasks: [{ title: "Send invoice", deadline: dayKey(0) }] });
    await expect(dueSoon(page).getByText("Send invoice")).toBeVisible();

    const check = await hitArea(page, ".side-due .check");
    expect(check, "the due row's check exists").not.toBeNull();
    expect(check!.misses, `the check keeps a 44 px hit area (${check!.width}x${check!.height})`).toBe(0);
    const row = await page.locator(".side-due-open").first().boundingBox();
    expect(row!.height, "the due row's opener is 44 px tall").toBeGreaterThanOrEqual(44);
  });
});

test("a waiting service worker offers Reload, and Reload activates it", async ({ page }) => {
  /* The service worker script is fetched by the browser's worker machinery, not
     by the page, so `page.route` cannot see it. The built app is therefore
     served from a test-owned origin where `/sw.js` is ours: version "a" starts
     active, version "b" is installed as the waiting update. */
  const script = (version: string) => `
    self.addEventListener('install', () => {});
    self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
    self.addEventListener('message', event => {
      if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
      if (event.data?.type === 'version') event.ports[0]?.postMessage({ version: '${version}' });
    });
  `;
  const worker = { body: script("a") };
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(worker.body);
      return;
    }
    const file = path === "/" ? "/index.html" : path;
    try {
      const body = readFileSync(join(dist, file));
      response.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const activeVersion = () =>
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const active = registration?.active;
      if (!active) return "no-active";
      return await new Promise<string>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolve(String(event.data?.version ?? "no-answer"));
        active.postMessage({ type: "version" }, [channel.port2]);
        setTimeout(() => resolve("timeout"), 5000);
      });
    });

  try {
    await enter(page, "update-prompt", {}, { url: origin });
    await expect.poll(activeVersion, { timeout: 30_000 }).toBe("a");
    await expect(page.locator(".update-prompt")).toHaveCount(0);

    /* A new build lands: the waiting worker is a different script, so it waits
       instead of taking over the tab. */
    worker.body = script("b");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect
      .poll(
        () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null),
        { timeout: 30_000 },
      )
      .toBe("installed");

    const prompt = page.locator(".update-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText("Update available")).toBeVisible();
    await expect(prompt.getByText("Reload to use the new version.")).toBeVisible();

    /* Reloading is the user's decision and activates that exact worker. */
    await prompt.getByRole("button", { name: "Reload" }).click();
    await expect(page.locator(".update-prompt")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(activeVersion, { timeout: 30_000 }).toBe("b");
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting ?? null)).toBeNull();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

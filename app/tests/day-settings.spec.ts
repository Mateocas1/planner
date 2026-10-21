import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  readRemoteDaySettings,
  seedDaySettings,
  submitAuthForm,
  type RemoteDaySettings,
} from "./browser-helpers.ts";

/**
 * S1 (odd/research/distinctive-roadmap.md §3, F3/F6): one working window for
 * every day, the time the day shuts down, and the keyboard-shortcuts toggle,
 * edited in a Day settings sheet opened from the account entry (the desktop
 * sidebar row and the phone's account menu).
 *
 * Every assertion is what the user reads or what the server holds. Rejected
 * input is asserted twice: the calm message on screen, and the profile document
 * still holding the last accepted values -- a form that shows an error and
 * writes anyway is the failure this unit exists to prevent.
 */

test.setTimeout(120_000);

/* A desktop-tall window by default: the account row is the sidebar footer
   entry, which only exists at the desktop width. */
test.use({ viewport: { width: 1440, height: 900 } });

const ZONE = "UTC";

/* Screenshots are evidence for the parent review, not assertions. */
const shotDir = fileURLToPath(new URL("../../odd/runs/day-settings-shots", import.meta.url));

/** A capture waits for the panel's flight to land and the planner to load: a
 * screenshot taken mid-entrance shows the trigger's rectangle, not the sheet. */
async function shot(page: Page, name: string) {
  await expect(page.getByText("Loading your planner…")).toHaveCount(0);
  await page.waitForFunction(() => {
    const sheet = document.querySelector(".sheet");
    return sheet !== null && sheet.getAnimations({ subtree: true }).every(animation => animation.playState !== "running");
  });
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

const sheet = (page: Page) => page.getByRole("complementary", { name: "Day settings" });
const entry = (page: Page) => page.getByRole("button", { name: "Day settings" });
const shortcuts = (page: Page) => page.getByRole("switch", { name: "Keyboard shortcuts" });

/** Signs a fresh account in with the given day settings already stored. */
async function enter(page: Page, prefix: string, settings: Parameters<typeof seedDaySettings>[1]) {
  const email = newEmail(prefix);
  await seedDaySettings(email, { timeZone: ZONE, ...settings });
  await submitAuthForm(page, email, "sign in");
  return email;
}

/** Opens the sheet from the sidebar account row, the way a pointer user does. */
async function openFromSidebar(page: Page) {
  await entry(page).click();
  await expect(sheet(page)).toBeVisible();
}

/** Fills a field and commits it by leaving the field. */
async function typeInto(page: Page, label: string, value: string) {
  await page.getByLabel(label).fill(value);
  await page.keyboard.press("Tab");
}

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

async function expectRemote(email: string, expected: RemoteDaySettings) {
  await expect.poll(() => readRemoteDaySettings(email), poll).toEqual(expected);
}

/** A profile whose day settings were never written: every field reads its
 * default in the app, and the document holds only the seeded timezone. */
const untouched: RemoteDaySettings = { timeZone: ZONE, workStart: null, workEnd: null, shutdownTime: null, shortcutsEnabled: null };

test("the sidebar account row opens Day settings with the stored values", async ({ page }) => {
  const email = await enter(page, "day-defaults", {});
  await openFromSidebar(page);

  await expect(page.getByLabel("Work starts")).toHaveValue("08:00");
  await expect(page.getByLabel("Work ends")).toHaveValue("21:00");
  await expect(page.getByLabel("Shut down at")).toHaveValue("18:00");
  await expect(shortcuts(page)).toBeChecked();
  await shot(page, "desktop-1440x900");

  /* Nothing was written by simply looking at it: the profile still holds only
     the seeded timezone, and every new field falls back to its default. */
  expect(await readRemoteDaySettings(email), "opening the sheet writes nothing").toEqual(untouched);
});

test("an end before the start is rejected inline and never reaches the profile", async ({ page }) => {
  const email = await enter(page, "day-order", {
    workStart: 9 * 60,
    workEnd: 17 * 60,
    shutdownTime: 18 * 60,
    shortcutsEnabled: true,
  });
  await openFromSidebar(page);
  await expect(page.getByLabel("Work starts")).toHaveValue("09:00");
  await expect(page.getByLabel("Work ends")).toHaveValue("17:00");

  /* 18:00 -> 17:00: the end is no longer after the start. */
  await typeInto(page, "Work starts", "18:00");
  await typeInto(page, "Work ends", "08:00");
  await expect(sheet(page).getByText("Work ends before it starts. Set an end later than the start.")).toBeVisible();
  expect(await readRemoteDaySettings(email), "a rejected range is not written").toEqual({
    timeZone: ZONE,
    workStart: 540,
    workEnd: 1020,
    shutdownTime: 1080,
    shortcutsEnabled: true,
  });
  /* The message is a calm line, not a dialog: the fields stay editable. */
  await expect(page.getByLabel("Work ends")).toHaveValue("08:00");

  /* A later end is accepted and written. */
  await typeInto(page, "Work ends", "20:00");
  await expect(sheet(page).getByText("Work ends before it starts. Set an end later than the start.")).toHaveCount(0);
  await expectRemote(email, { timeZone: ZONE, workStart: 1080, workEnd: 1200, shutdownTime: 1080, shortcutsEnabled: true });
});

test("times outside the day and unreadable times are rejected inline", async ({ page }) => {
  const email = await enter(page, "day-range", { workStart: 9 * 60, workEnd: 17 * 60, shutdownTime: 18 * 60 });
  await openFromSidebar(page);

  await typeInto(page, "Work starts", "25:00");
  await expect(sheet(page).getByText("Stay inside the day: 00:00 to 24:00.")).toBeVisible();
  await typeInto(page, "Work starts", "half past");
  await expect(sheet(page).getByText("Use a time like 09:00.")).toBeVisible();
  await typeInto(page, "Shut down at", "24:30");
  await expect(sheet(page).getByText("Stay inside the day: 00:00 to 24:00.")).toBeVisible();

  expect(await readRemoteDaySettings(email), "no rejected value is written").toEqual({
    timeZone: ZONE,
    workStart: 540,
    workEnd: 1020,
    shutdownTime: 1080,
    shortcutsEnabled: null,
  });
});

test("the window, the shutdown time and the toggle survive a reload", async ({ page }) => {
  const email = await enter(page, "day-reload", {});
  await openFromSidebar(page);

  await typeInto(page, "Work starts", "09:15");
  await typeInto(page, "Work ends", "17:45");
  await typeInto(page, "Shut down at", "20:00");
  await shortcuts(page).click();
  await expect(shortcuts(page)).not.toBeChecked();

  const stored: RemoteDaySettings = { timeZone: ZONE, workStart: 555, workEnd: 1065, shutdownTime: 1200, shortcutsEnabled: false };
  await expectRemote(email, stored);

  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await openFromSidebar(page);
  await expect(page.getByLabel("Work starts")).toHaveValue("09:15");
  await expect(page.getByLabel("Work ends")).toHaveValue("17:45");
  await expect(page.getByLabel("Shut down at")).toHaveValue("20:00");
  await expect(shortcuts(page)).not.toBeChecked();
  await expectRemote(email, stored);
});

test("the sheet is usable with the keyboard alone", async ({ page }) => {
  const email = await enter(page, "day-keys", { workStart: 8 * 60, workEnd: 21 * 60, shutdownTime: 18 * 60 });

  /* Enter on the account row's entry, no pointer involved. */
  await entry(page).focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  /* The sheet puts the caret in its first field, so the panel is reachable
     without tabbing through the page behind it. */
  await expect(page.getByLabel("Work starts")).toBeFocused();

  await page.getByLabel("Work starts").fill("07:30");
  await page.keyboard.press("Tab");
  await page.getByLabel("Work ends").fill("16:30");
  await page.keyboard.press("Tab");
  await page.getByLabel("Shut down at").fill("19:00");
  await page.keyboard.press("Tab");
  await expect(shortcuts(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(shortcuts(page)).not.toBeChecked();

  await expectRemote(email, { timeZone: ZONE, workStart: 450, workEnd: 990, shutdownTime: 1140, shortcutsEnabled: false });

  /* Escape closes the sheet and the caret returns to the control that opened it. */
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(entry(page)).toBeFocused();
});

test("on a phone the same sheet opens from the account menu and fits 390 x 844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = await enter(page, "day-phone", {});
  await expect(page.locator(".sidebar"), "a phone has no sidebar").toHaveCount(0);

  await page.getByRole("button", { name: "Account" }).click();
  const menuEntry = page.locator(".popover").getByRole("button", { name: "Day settings" });
  await expect(menuEntry).toBeVisible();
  await menuEntry.click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByLabel("Work starts")).toHaveValue("08:00");
  await expect(page.getByLabel("Work ends")).toHaveValue("21:00");
  await expect(page.getByLabel("Shut down at")).toHaveValue("18:00");
  await expect(shortcuts(page)).toBeVisible();
  await shot(page, "phone-390x844");

  /* The panel is inside the phone: no horizontal scroll, and the panel's own
     box sits inside the viewport. */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
  const box = await sheet(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);

  /* The phone edits the same document. */
  await page.getByLabel("Work starts").fill("10:00");
  await page.keyboard.press("Tab");
  await expectRemote(email, { timeZone: ZONE, workStart: 600, workEnd: 1260, shutdownTime: null, shortcutsEnabled: null });
});

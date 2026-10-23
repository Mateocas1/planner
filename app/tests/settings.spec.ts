import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { readRemoteDaySettings, seedDaySettings, submitAuthForm } from "./browser-helpers.ts";

/**
 * S1 + S2 (Ronda 2): the Settings view — how it opens (gear, palette,
 * `Ctrl+,`), how the tabs behave (the desktop-only ones never render on the
 * web), that the moved controls still write, and the shortcut recorder's
 * conflict and restore rules on the palette's row.
 *
 * Screenshots are evidence for the parent review, not assertions, and land in
 * odd/runs/r2-w1-shots/.
 */

test.setTimeout(120_000);

test.use({ viewport: { width: 1440, height: 900 } });

const ZONE = "UTC";
const shotDir = fileURLToPath(new URL("../../odd/runs/r2-w1-shots", import.meta.url));

const view = (page: Page) => page.getByRole("region", { name: "Settings" });
const gear = (page: Page) => page.getByRole("button", { name: "Settings", exact: true });
const rail = (page: Page) => view(page).getByRole("navigation", { name: "Settings sections" });

async function shot(page: Page, name: string) {
  await expect(page.getByText("Loading your planner…")).toHaveCount(0);
  await page.waitForFunction(() =>
    // The subtree option is newer than this build's DOM types.
    (document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] })
      .getAnimations({ subtree: true }).every(animation => animation.playState !== "running"),
  );
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function enter(
  page: Page,
  prefix: string,
  settings: Parameters<typeof seedDaySettings>[1] = {},
) {
  const email = newEmail(prefix);
  await seedDaySettings(email, { timeZone: ZONE, ...settings });
  await submitAuthForm(page, email, "sign in");
  return email;
}

test("Settings opens from the gear, the palette and Ctrl+, and switches tabs", async ({ page }) => {
  await enter(page, "settings-open");

  /* The gear. */
  await gear(page).click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).getByRole("heading", { name: "General" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);

  /* Ctrl+, — the fixed chord. */
  await page.keyboard.press("Control+,");
  await expect(view(page)).toBeVisible();
  /* Escape returns, the view never traps. */
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);

  /* The palette: the generic command and a per-tab deep link. */
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("settings");
  const option = page.getByRole("option", { name: "Settings: Shortcuts" });
  await expect(option).toBeVisible();
  await option.click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).getByRole("heading", { name: "Shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
});

test("the rail switches tabs, and the desktop-only tabs never render on the web", async ({ page }) => {
  await enter(page, "settings-tabs");
  await gear(page).click();
  await expect(view(page)).toBeVisible();

  /* Desktop and AI are desktop-only: no disabled teaser on the web. */
  await expect(rail(page).getByRole("button", { name: "Desktop" })).toHaveCount(0);
  await expect(rail(page).getByRole("button", { name: "AI" })).toHaveCount(0);
  await expect(rail(page).getByRole("button")).toHaveCount(3);

  for (const tab of ["Rituals", "Shortcuts", "General"]) {
    await rail(page).getByRole("button", { name: tab }).click();
    await expect(view(page).getByRole("heading", { name: tab, exact: true })).toBeVisible();
  }

  /* Rituals' placeholder rows say what is coming, without pretending to work. */
  await rail(page).getByRole("button", { name: "Rituals" }).click();
  await expect(view(page).getByText("Coming with the weekly review.")).toBeVisible();
  await expect(view(page).getByRole("switch", { name: "Enable nudges" })).toBeDisabled();
});

test("a changed work window still persists from the new container", async ({ page }) => {
  const email = await enter(page, "settings-window", { workStart: 9 * 60, workEnd: 17 * 60 });
  await gear(page).click();
  await expect(view(page)).toBeVisible();
  await page.getByLabel("Work starts").fill("08:30");
  await page.getByLabel("Work ends").fill("16:00");
  await page.keyboard.press("Tab");
  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect
    .poll(() => readRemoteDaySettings(email), poll)
    .toEqual({ timeZone: ZONE, workStart: 510, workEnd: 960, shutdownTime: null, shortcutsEnabled: null });
});

test("time fields show the full value at every font scale, and the web hides desktop-only rows", async ({ page }) => {
  await enter(page, "settings-fit", { workStart: 9 * 60, workEnd: 17 * 60, shutdownTime: 18 * 60 });
  await gear(page).click();
  await expect(view(page)).toBeVisible();

  /* The work-start field holds "09:00" in full: nothing clipped. */
  const start = page.getByLabel("Work starts");
  await expect(start).toHaveValue("09:00");
  const fits = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate(el => el.scrollWidth <= el.clientWidth);
  await expect.poll(() => fits(start)).toBe(true);

  /* The widest value the field takes still fits, at the default scale and at a
     larger root font. Nothing is committed: the value is put back before blur,
     and the same time is not written. */
  await start.fill("88:88");
  await expect.poll(() => fits(start)).toBe(true);
  await start.fill("09:00");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "22px";
  });
  await expect.poll(() => fits(start)).toBe(true);
  await expect.poll(() => fits(page.getByLabel("Work ends"))).toBe(true);
  await expect.poll(() => fits(page.getByLabel("Shut down at"))).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  /* The desktop-only quick-add row has no label on the web: it is not rendered. */
  await rail(page).getByRole("button", { name: "Shortcuts" }).click();
  await expect(view(page).getByRole("heading", { name: "Shortcuts" })).toBeVisible();
  await expect(view(page).getByText("Quick add anywhere")).toHaveCount(0);
  await expect(view(page).getByRole("button", { name: /Command palette shortcut/ })).toBeVisible();

  /* Built-in keys and recorder keycaps draw in the UI font, not the monospace default. */
  const keycap = view(page).locator(".keycap").first();
  await expect(keycap).toBeVisible();
  await expect.poll(() => keycap.evaluate(el => getComputedStyle(el).fontFamily)).not.toContain("monospace");
});

test("the palette recorder refuses a conflict and restores the default", async ({ page }) => {
  await enter(page, "settings-recorder");
  await gear(page).click();
  await rail(page).getByRole("button", { name: "Shortcuts" }).click();
  await expect(view(page).getByRole("heading", { name: "Shortcuts" })).toBeVisible();

  const paletteRow = view(page).locator(".shortcut-recorder").first();
  const chip = paletteRow.getByRole("button", { name: /Command palette shortcut/ });
  await expect(chip).toContainText("Ctrl");
  await expect(chip).toContainText("K");

  /* Recording starts on one click and says so. */
  await chip.click();
  await expect(paletteRow).toHaveAttribute("data-recording", "true");
  await expect(view(page).getByText("Recording — press the new combination, Escape to cancel.")).toBeVisible();

  /* The chip's accessible name changes while recording, so the locator below
     addresses the chip by its class, not its name. */
  const chipButton = paletteRow.locator(".shortcut-chip");

  /* A chord another rebindable shortcut holds is refused, and the chip keeps
     the old value. (Ctrl+W and friends are unit-tested reserved combos; the
     browser itself owns them here, so the browser test never sends them.) */
  await page.keyboard.press("Control+j");
  await expect(view(page).getByText("Already used by Chat. Pick a different combination.")).toBeVisible();
  await expect(chipButton).toContainText("K");

  /* The fixed in-app chord is refused too, by its own sentence. */
  await chipButton.click();
  await page.keyboard.press("Control+,");
  await expect(view(page).getByText("Ctrl+, is reserved for Settings.")).toBeVisible();
  await expect(chipButton).toContainText("K");

  /* Escape cancels a recording without changing anything. */
  await chipButton.click();
  await page.keyboard.press("Escape");
  await expect(paletteRow).not.toHaveAttribute("data-recording", "true");
  await expect(chipButton).toContainText("K");

  /* A free chord is saved, survives a reload, and restores. */
  await chipButton.click();
  await page.keyboard.press("Control+Shift+p");
  await expect(paletteRow.locator(".shortcut-saved")).toContainText("Saved");
  await expect(paletteRow.getByRole("button", { name: "Restore default" })).toBeVisible();
  await page.reload();
  await gear(page).click();
  await rail(page).getByRole("button", { name: "Shortcuts" }).click();
  const chipAfterReload = view(page).locator(".shortcut-recorder").first().locator(".shortcut-chip");
  await expect(chipAfterReload).toContainText("P");

  await view(page).locator(".shortcut-recorder").first().getByRole("button", { name: "Restore default" }).click();
  await expect(chipAfterReload).toContainText("K");
});

test("screenshots of the web tabs, desktop light and dark, and phone", async ({ page }) => {
  await enter(page, "settings-shots", { workStart: 9 * 60, workEnd: 17 * 60, shutdownTime: 18 * 60 });
  await gear(page).click();
  await expect(view(page)).toBeVisible();
  await shot(page, "desktop-1440x900-general-light");

  for (const [tab, name] of [
    ["Rituals", "rituals"],
    ["Shortcuts", "shortcuts"],
    ["General", "general"],
  ] as const) {
    await rail(page).getByRole("button", { name: tab }).click();
    await expect(view(page).getByRole("heading", { name: tab, exact: true })).toBeVisible();
    await shot(page, `desktop-1440x900-${name}-light`);
  }

  /* Dark: the theme follows the OS, so emulating it is enough. */
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await rail(page).getByRole("button", { name: "Rituals" }).click();
  await shot(page, "desktop-1440x900-rituals-dark");
  await rail(page).getByRole("button", { name: "Shortcuts" }).click();
  await shot(page, "desktop-1440x900-shortcuts-dark");
  await rail(page).getByRole("button", { name: "General" }).click();
  await shot(page, "desktop-1440x900-general-dark");
  await page.emulateMedia({ colorScheme: "light" });
});

test("phone screenshot at 390 x 844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page, "settings-phone");
  await page.getByRole("button", { name: "Account" }).click();
  await page.locator(".popover").getByRole("button", { name: "Settings" }).click();
  await expect(view(page)).toBeVisible();
  await shot(page, "phone-390x844-general");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
});

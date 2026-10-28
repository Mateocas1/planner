import { expect, test, type Page } from "@playwright/test";
import { seedTasks, submitAuthForm } from "./browser-helpers.ts";

test.setTimeout(90_000);

/**
 * Keyboard containment (Ronda 5, S7, R5-03 / R5-04b): a sheet looks modal, so
 * Tab must not reach the page under its scrim, and a skip link is the first
 * stop on every surface.
 */

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Whether the focused element is inside the open sheet (or the body, between stops). */
const focusInside = (page: Page, label: string) =>
  page.evaluate(name => {
    const active = document.activeElement;
    if (active === null || active === document.body) return "body";
    return active.closest(`aside[aria-label="${name}"]`) !== null ? "inside" : `outside: ${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent ?? ""}`;
  }, label);

async function settled(page: Page, label: string) {
  const sheet = page.getByRole("complementary", { name: label });
  await expect(sheet).toBeVisible();
  await expect.poll(() => sheet.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  return sheet;
}

test("30 Tab presses with the create sheet open never leave it, and Escape returns focus to the opener", async ({ page }) => {
  await submitAuthForm(page, newEmail("sheet-focus"), "sign up");
  const opener = page.getByRole("button", { name: "New task" });
  await opener.click();
  await settled(page, "New task");

  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(page, "New task"), `Tab press ${step + 1}`).not.toMatch(/^outside/);
  }
  // the page under the scrim is not reachable by assistive technology either
  expect(await page.locator(".main").evaluate(element => (element as HTMLElement).inert)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.locator(".main").evaluate(element => (element as HTMLElement).inert)).toBe(false);
});

test("30 Tab presses inside the task details sheet stay inside it, and Escape lands on the row", async ({ page }) => {
  const email = newEmail("sheet-focus-details");
  await submitAuthForm(page, email, "sign up");
  await seedTasks(email, [{ title: "Keep focus inside" }]);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  const row = page.getByRole("button", { name: "Keep focus inside" });
  await row.click();
  await settled(page, "Task details");

  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(page, "Task details"), `Tab press ${step + 1}`).not.toMatch(/^outside/);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Task details" })).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("a popover opened from a sheet still works while the page is inert", async ({ page }) => {
  await submitAuthForm(page, newEmail("sheet-focus-select"), "sign up");
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = await settled(page, "New task");
  const repeat = sheet.getByRole("combobox", { name: "Repeat", exact: true });
  await repeat.click();
  const list = page.getByRole("listbox", { name: "Repeat", exact: true });
  await expect(list).toBeVisible();
  await list.getByRole("option").nth(1).click();
  await expect(list).toHaveCount(0);
  await expect(repeat).toBeFocused();
});

test("the skip link is the first Tab stop, shows on focus, and moves focus to the main region", async ({ page }) => {
  await submitAuthForm(page, newEmail("skip-link"), "sign up");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toHaveCount(1);
  // hidden until focused: it is off the visible page at rest
  expect((await skip.boundingBox())!.y + (await skip.boundingBox())!.height).toBeLessThanOrEqual(0);

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  const box = (await skip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeGreaterThan(40);

  await page.keyboard.press("Enter");
  await expect(page.locator("main#content")).toBeFocused();
  // the hash target must not leave the page scrolled or the URL polluted
  await expect(page.locator("main#content")).toHaveAttribute("tabindex", "-1");
});

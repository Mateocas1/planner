import { expect, test, type Locator, type Page } from "@playwright/test";
import { chooseOption, expectChoice, pickDate, submitAuthForm } from "./browser-helpers.ts";

test.setTimeout(90_000);

/**
 * The Select family (src/ui/Select.tsx on the Popover primitive) proven through
 * the create sheet's Repeat field: the field the user named as "una apertura
 * seca". Every spec here drives the real production build.
 */

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Signs up, opens the create sheet and waits for its entrance to finish. */
async function openCreateSheet(page: Page) {
  await submitAuthForm(page, newEmail("select"), "sign up");
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  await expect.poll(() => sheet.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  return sheet;
}

const trigger = (scope: Page | Locator) => scope.getByRole("combobox", { name: "Repeat", exact: true });
const listbox = (page: Page) => page.getByRole("listbox", { name: "Repeat", exact: true });

/** Which transition properties are running on the popover and on its body. */
function runningTransitions(pop: Locator) {
  return pop.evaluate(element => ({
    surface: element.getAnimations().map(animation => (animation as CSSTransition).transitionProperty).sort(),
    body: (element.querySelector(".pop-body")?.getAnimations() ?? []).map(animation => (animation as CSSTransition).transitionProperty).sort(),
  }));
}

/** Computed look of the popover surface and body at this instant. */
function look(pop: Locator) {
  return pop.evaluate(element => {
    const surface = getComputedStyle(element);
    const body = getComputedStyle(element.querySelector(".pop-body")!);
    return { opacity: Number(surface.opacity), transform: surface.transform, filter: body.filter };
  });
}

const isIdentity = (transform: string) => transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";

test.describe("Select on a desktop viewport", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("opening grows the list in: opacity, scale and a focus-pull blur that all settle", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    const pop = sheet.locator(".select-pop");
    // Open and sample inside the page, two frames in, so the read is not at the
    // mercy of a protocol round trip.
    const mid = await trigger(sheet).evaluate(async (element: HTMLElement) => {
      const popover = document.getElementById(element.getAttribute("aria-controls")!)!;
      element.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const surface = getComputedStyle(popover);
      const body = getComputedStyle(popover.querySelector(".pop-body")!);
      return {
        opacity: Number(surface.opacity),
        transform: surface.transform,
        filter: body.filter,
        surface: popover.getAnimations().map(a => (a as CSSTransition).transitionProperty),
        body: popover.querySelector(".pop-body")!.getAnimations().map(a => (a as CSSTransition).transitionProperty),
      };
    });
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.surface).toEqual(expect.arrayContaining(["opacity", "transform"]));
    expect(mid.body).toEqual(expect.arrayContaining(["filter"]));
    expect(mid.transform === "none" || mid.transform.startsWith("matrix")).toBe(true);

    await expect.poll(async () => (await runningTransitions(pop)).surface.length).toBe(0);
    const settled = await look(pop);
    expect(settled.opacity).toBe(1);
    expect(isIdentity(settled.transform)).toBe(true);
    expect(settled.filter).toBe("none");
  });

  test("closing leaves without a blur, and the closed list is out of the accessibility tree", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(0);
    await trigger(sheet).click();
    await expect(listbox(page)).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(trigger(sheet)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(0);
    // The name exists only while open, so the row label stays unique.
    await expect(sheet.getByLabel("Repeat")).toHaveCount(1);
  });

  test("Escape closes the list and not the sheet; a second Escape closes the sheet", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).click();
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(listbox(page)).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(trigger(sheet)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
  });

  test("a press on the scrim closes only the list", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).click();
    await expect(listbox(page)).toBeVisible();
    await page.locator(".scrim").click({ position: { x: 8, y: 8 } });
    await expect(listbox(page)).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // A second press is the sheet's own.
    await page.locator(".scrim").click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
  });

  test("Tab picks the highlighted option, closes the list and moves on without stealing focus back", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).focus();
    await page.keyboard.press("ArrowDown");
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expectChoice(sheet, "Repeat", "Daily");
    await expect(trigger(sheet)).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.closest("aside, [role=complementary]") !== null)).toBe(true);
    await expect(sheet).toBeVisible();
  });

  test("choosing with the pointer returns focus to the trigger", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).click();
    await page.getByRole("option", { name: "Monthly", exact: true }).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(trigger(sheet)).toBeFocused();
    await expect(trigger(sheet)).toHaveAttribute("data-value", "monthly");
    await expectChoice(sheet, "Repeat", "Monthly");
    // The conditional Start date row follows the stored value.
    await expect(sheet.getByLabel("Start date")).toBeVisible();
  });

  test("keyboard map: open keys, arrows without wrap, Home/End/Page, Enter, Space, Escape, type-ahead", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    const field = trigger(sheet);
    const active = async () => {
      const id = await field.getAttribute("aria-activedescendant");
      return id ? page.locator(`[id="${id}"]`).innerText() : null;
    };
    await field.focus();

    // ArrowDown opens on the selected option; ArrowUp at the top does not wrap.
    await page.keyboard.press("ArrowDown");
    await expect(listbox(page)).toBeVisible();
    expect(await active()).toBe("Never");
    await page.keyboard.press("ArrowUp");
    expect(await active()).toBe("Never");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await active()).toBe("Weekly");
    await page.keyboard.press("End");
    expect(await active()).toBe("Monthly");
    await page.keyboard.press("ArrowDown");
    expect(await active()).toBe("Monthly");
    await page.keyboard.press("Home");
    expect(await active()).toBe("Never");
    await page.keyboard.press("PageDown");
    expect(await active()).toBe("Monthly");
    await page.keyboard.press("PageUp");
    expect(await active()).toBe("Never");

    // Escape leaves the value alone and keeps focus on the trigger.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectChoice(sheet, "Repeat", "Never");

    // Enter chooses.
    await page.keyboard.press("Enter");
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectChoice(sheet, "Repeat", "Weekly");

    // Space opens on the selected option, and chooses.
    await page.keyboard.press("Space");
    await expect(listbox(page)).toBeVisible();
    expect(await active()).toBe("Weekly");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expectChoice(sheet, "Repeat", "Monthly");

    // Alt+ArrowDown opens; type-ahead moves the highlight while open and opens when closed.
    await page.keyboard.press("Alt+ArrowDown");
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press("d");
    expect(await active()).toBe("Daily");
    // A pause longer than the 500 ms buffer starts a new prefix.
    await page.waitForTimeout(600);
    await page.keyboard.press("w");
    expect(await active()).toBe("Weekly");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await page.keyboard.press("n");
    await expect(listbox(page)).toBeVisible();
    expect(await active()).toBe("Never");
    await page.keyboard.press("Enter");
    await expectChoice(sheet, "Repeat", "Never");
  });

  test("the pointer moves the highlight; reopening mid-exit still leaves a complete list", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    const field = trigger(sheet);
    await field.click();
    await page.getByRole("option", { name: "Weekly", exact: true }).hover();
    await expect(page.getByRole("option", { name: "Weekly", exact: true })).toHaveAttribute("data-active", "true");
    // Escape, then press again before the 120 ms exit has finished.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    await expect(listbox(page)).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(field).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("the list opens inside the viewport, under the trigger, wide enough for it", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).click();
    const pop = page.getByRole("listbox", { name: "Repeat", exact: true });
    await expect(pop).toBeVisible();
    await expect.poll(async () => (await runningTransitions(pop)).surface.length).toBe(0);
    const box = (await pop.boundingBox())!;
    const field = (await trigger(sheet).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.y).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(1366 - 12);
    expect(box.y + box.height).toBeLessThanOrEqual(768 - 12);
    expect(box.width).toBeGreaterThanOrEqual(field.width - 1);
    expect(box.width).toBeGreaterThanOrEqual(168);
    // Below the trigger when there is room, one gap away.
    expect(box.y).toBeGreaterThan(field.y + field.height);
  });

  test("a native select is gone from the create sheet, and the stored value is what the form submits", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await expect(sheet.locator("select")).toHaveCount(0);
    await sheet.getByLabel("Task title").fill("Water the plants");
    await chooseOption(sheet, "Repeat", "Daily");
    await pickDate(sheet, "Start date", "2026-11-02");
    await sheet.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
    await expect(page.locator(".series-row", { hasText: "Water the plants" })).toBeVisible();
  });
});

test.describe("Select with reduced motion", () => {
  test.use({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });

  test("the entrance is a fade only: no scale and no blur", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    const mid = await trigger(sheet).evaluate(async (element: HTMLElement) => {
      const popover = document.getElementById(element.getAttribute("aria-controls")!)!;
      element.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      return {
        surface: popover.getAnimations().map(a => (a as CSSTransition).transitionProperty),
        body: popover.querySelector(".pop-body")!.getAnimations().map(a => (a as CSSTransition).transitionProperty),
        transform: getComputedStyle(popover).transform,
        filter: getComputedStyle(popover.querySelector(".pop-body")!).filter,
      };
    });
    expect(mid.surface).toContain("opacity");
    expect(mid.surface).not.toContain("transform");
    expect(mid.body).not.toContain("filter");
    expect(isIdentity(mid.transform)).toBe(true);
    expect(mid.filter).toBe("none");
    await expect(listbox(page)).toBeVisible();
  });
});

test.describe("Select on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the list opens inside the viewport with 44 px rows, and a tap chooses", async ({ page }) => {
    const sheet = await openCreateSheet(page);
    await trigger(sheet).tap();
    const pop = page.getByRole("listbox", { name: "Repeat", exact: true });
    await expect(pop).toBeVisible();
    await expect.poll(async () => (await runningTransitions(pop)).surface.length).toBe(0);
    const box = (await pop.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.y).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 12);
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 12);
    const row = (await page.getByRole("option", { name: "Daily", exact: true }).boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("option", { name: "Daily", exact: true }).tap();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expectChoice(sheet, "Repeat", "Daily");
  });
});

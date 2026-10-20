import { expect, test, type Locator, type Page } from "@playwright/test";
import { submitAuthForm } from "./browser-helpers.ts";

/**
 * CP1 (odd/tasks/centered-panels.md, S2/S3): every detail and creation panel
 * opens as a card centred in what the user can see, not docked to the right
 * edge, and on a phone it is centred in the band the on-screen keyboard leaves.
 *
 * These are geometry assertions on the resting panel, so every read happens
 * after the panel's own flight and its content's blur have finished: measuring
 * mid-entry would read the trigger's rectangle, which is what the panel is
 * laid over on its first frame.
 */

test.setTimeout(120_000);

const newEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

/**
 * Installs a writable `window.visualViewport` before the app loads, so a test
 * can raise a simulated on-screen keyboard (the same stub tests/mobile.spec.ts
 * uses: Playwright cannot raise a real one, and the real API is read-only).
 */
const fakeVisualViewport = `(() => {
  const viewport = Object.assign(new EventTarget(), {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
  });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  window.__simulateKeyboard = height => {
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
  };
})();`;

type Box = { x: number; y: number; width: number; height: number };

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

async function openTasks(page: Page) {
  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** The band of the layout viewport the user can actually see, in page Y: the
 * layout height minus the part an on-screen keyboard covers. */
async function visibleBand(page: Page): Promise<{ top: number; bottom: number }> {
  const box = await page.evaluate(() => {
    const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
    return { height: window.innerHeight, inset };
  });
  return { top: 0, bottom: box.height - box.inset };
}

/** Waits until the panel's flight and its content's blur have both finished. */
async function settlePanel(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".sheet");
        if (!sheet) return "no panel";
        const body = sheet.querySelector<HTMLElement>(".sheet-body");
        const filter = body ? getComputedStyle(body).filter : "none";
        return `${sheet.getAnimations().length}:${body?.getAnimations().length ?? 0}:${filter}`;
      }),
    )
    .toBe("0:0:none");
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  return box!;
}

/**
 * The panel rests with its box centred in the visible band: horizontally on
 * the viewport's midline, vertically on the band's, and fully inside both.
 */
async function expectCentered(page: Page, panel: Locator, band: { top: number; bottom: number }): Promise<Box> {
  const viewport = page.viewportSize()!;
  const rect = await boxOf(panel, "the panel");
  expect(Math.abs(rect.x + rect.width / 2 - viewport.width / 2), "the panel is centred horizontally").toBeLessThanOrEqual(2);
  expect(
    Math.abs(rect.y + rect.height / 2 - (band.top + band.bottom) / 2),
    "the panel is centred in the visible band",
  ).toBeLessThanOrEqual(2);
  expect(rect.x, "the panel's left edge is on screen").toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, "the panel's right edge is on screen").toBeLessThanOrEqual(viewport.width);
  expect(rect.y, "the panel's top edge is on screen").toBeGreaterThanOrEqual(band.top - 0.5);
  expect(rect.y + rect.height, "the panel's bottom edge is above the keyboard").toBeLessThanOrEqual(band.bottom + 0.5);
  return rect;
}

/** A control inside the panel and, by implication, inside the visible band. */
async function expectInPanel(control: Locator, panel: Box, name: string) {
  const rect = await boxOf(control, name);
  expect(rect.y, `${name} starts inside the panel`).toBeGreaterThanOrEqual(panel.y - 0.5);
  expect(rect.y + rect.height, `${name} ends inside the panel`).toBeLessThanOrEqual(panel.y + panel.height + 0.5);
}

async function addTask(page: Page, title: string) {
  await openTasks(page);
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

const SCREENS = [
  { width: 1440, height: 900, name: "desktop" },
  { width: 768, height: 1024, name: "tablet" },
] as const;

for (const { width, height, name } of SCREENS) {
  test.describe(`${name} ${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test("the New task panel is a centred card with its form in view", async ({ page }) => {
      await signUp(page, newEmail(`centre-${name}`));
      await page.getByRole("button", { name: "New task" }).click();
      const panel = page.getByRole("complementary", { name: "New task" });
      await expect(panel).toBeVisible();
      await settlePanel(page);

      const rect = await expectCentered(page, panel, await visibleBand(page));
      // A centred card is readable, not a second sidebar: it keeps a form's
      // width instead of taking the screen.
      expect(rect.width).toBeLessThanOrEqual(520);
      expect(rect.width).toBeGreaterThan(360);

      await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
      await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
      await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
    });

    test("a task's details panel is centred too", async ({ page }) => {
      await signUp(page, newEmail(`centre-details-${name}`));
      await addTask(page, "Buy paint");
      await page.getByRole("button", { name: "Buy paint" }).click();
      const panel = page.getByRole("complementary", { name: "Task details" });
      await expect(panel).toBeVisible();
      await settlePanel(page);

      const rect = await expectCentered(page, panel, await visibleBand(page));
      await expectInPanel(panel.getByLabel("Rename task"), rect, "the name field");
      await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
      await expectInPanel(panel.getByRole("button", { name: "Delete task" }), rect, "the primary action");
    });
  });
}

test.describe("phone 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the New task panel is a centred card, near full width", async ({ page }) => {
    await signUp(page, newEmail("centre-phone"));
    await page.getByRole("button", { name: "New task" }).click();
    const panel = page.getByRole("complementary", { name: "New task" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const rect = await expectCentered(page, panel, await visibleBand(page));
    // "Centrado también en celular": the card uses the width it has.
    expect(rect.width).toBeGreaterThanOrEqual(360);

    await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
    await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
    await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
  });

  test("with the keyboard up the panel is centred in the visible band and the whole form stays above it", async ({
    page,
  }) => {
    await page.addInitScript(fakeVisualViewport);
    await signUp(page, newEmail("centre-phone-keyboard"));

    // The keyboard opens on the field the sheet focuses, so it is raised before
    // the panel is laid out: the panel must centre itself in what is left.
    await page.evaluate(() => (window as any).__simulateKeyboard(360));
    await page.getByRole("button", { name: "New task" }).click();
    const panel = page.getByRole("complementary", { name: "New task" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const band = await visibleBand(page);
    // 844 layout px, 360 visible: the stub moves the visual viewport, and the
    // covered band is published as --kb-inset.
    expect(band.bottom).toBe(360);
    const rect = await expectCentered(page, panel, band);
    // Nothing is covered by the keyboard: the title it focuses, the deadline and
    // the action that submits it are all in the visible band, unscrolled.
    await expectInPanel(page.getByLabel("Task title"), rect, "the name field");
    await expectInPanel(panel.getByLabel("Deadline"), rect, "the deadline field");
    await expectInPanel(panel.getByRole("button", { name: "Add task" }), rect, "the primary action");
  });

  test("a task's details panel is centred on a phone", async ({ page }) => {
    await signUp(page, newEmail("centre-phone-details"));
    await addTask(page, "Call the vet");
    await page.getByRole("button", { name: "Call the vet" }).click();
    const panel = page.getByRole("complementary", { name: "Task details" });
    await expect(panel).toBeVisible();
    await settlePanel(page);

    const rect = await expectCentered(page, panel, await visibleBand(page));
    await expectInPanel(panel.getByLabel("Rename task"), rect, "the name field");
  });
});

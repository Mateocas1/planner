import { expect, test, type Locator, type Page } from "@playwright/test";
import { submitAuthForm, chooseOption } from "./browser-helpers.ts";

test.setTimeout(90_000);

/**
 * A phone in portrait, the way the report came in: 390 x 664 CSS px of layout
 * viewport (an iPhone 13 with the browser's own bars showing), touch input,
 * Chromium's mobile emulation. Chromium is the only engine installed here, so
 * the geometry measured below is the emulated one; the iOS path is the same code
 * reading a real visual viewport instead of the stub.
 */
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

/** The visible height the simulated keyboard leaves, 304 px covered. */
const keyboardOpenHeight = 360;

/**
 * Installs a writable `window.visualViewport` before the app loads, so a test
 * can open a simulated keyboard. The real API's geometry is read-only and
 * Playwright cannot raise a virtual keyboard, so the stub keeps the API's shape
 * -- a real EventTarget carrying height/offsetTop/scale -- and `__simulateKeyboard`
 * moves it and fires the same `resize` the platform fires, which is the contract
 * `ui/viewport.ts` consumes. Every other property the app reads is unchanged.
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

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** The covered band the app publishes for CSS to size bottom-anchored surfaces. */
async function readInset(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0);
}

/** The band of the layout viewport the visual viewport still shows, in page Y. */
async function visibleBand(page: Page): Promise<{ top: number; bottom: number; height: number }> {
  return page.evaluate(() => {
    const viewport = window.visualViewport!;
    return { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height, height: viewport.height };
  });
}

type Box = { x: number; y: number; width: number; height: number } | null;

/**
 * The sheet's entrance is a 400 ms FLIP on `transform`, so its box is only the
 * laid-out box once the flight has landed; measuring mid-entry would read the
 * origin's rectangle instead of the resting geometry.
 */
async function settled(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate(element => element.getAnimations().length)).toBe(0);
}

/** A surface or control the user must be able to see and reach: fully inside the band. */
function expectInside(box: Box, band: { top: number; bottom: number }, name: string) {
  expect(box, `${name} has a box`).not.toBeNull();
  expect(box!.y, `${name} top edge`).toBeGreaterThanOrEqual(band.top - 0.5);
  expect(box!.y + box!.height, `${name} bottom edge`).toBeLessThanOrEqual(band.bottom + 0.5);
}

/** Computed font size of a field: iOS zooms the page on focus below 16 px. */
async function fontSize(page: Page, label: string): Promise<number> {
  return page.evaluate(locatorLabel => {
    const field = document.querySelector<HTMLElement>(`#${locatorLabel}`)!;
    return parseFloat(getComputedStyle(field).fontSize);
  }, label);
}

async function expectNoSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the page does not scroll sideways",
  ).toBe(true);
}

test("the New task sheet stays inside the visible area with the on-screen keyboard open", async ({ page }) => {
  await page.addInitScript(fakeVisualViewport);
  await submitAuthForm(page, newEmail("mobile-keyboard"), "sign up");

  // The keyboard opens on the field the sheet focuses, which is why it opens
  // before the sheet does: the sheet is then laid out with the band already gone.
  await page.evaluate(height => (window as any).__simulateKeyboard(height), keyboardOpenHeight);
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Task title")).toBeFocused();

  // The covered band reaches CSS as a custom property: 664 layout px, 360 visible.
  await expect.poll(() => readInset(page)).toBe(304);

  const band = await visibleBand(page);
  await settled(sheet);
  expectInside(await sheet.boundingBox(), band, "the sheet");
  expectInside(await sheet.getByLabel("Task title").boundingBox(), band, "the title field");
  expectInside(await sheet.getByLabel("Deadline").boundingBox(), band, "the deadline field");

  // The primary action sits at the end of the sheet's own scroller, and scrolling
  // it is what makes it reachable: nothing is parked under the keyboard.
  await sheet.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  expectInside(await sheet.getByRole("button", { name: "Add task" }).boundingBox(), band, "the primary action");

  await expectNoSidewaysScroll(page);

  // A field under 16 px makes iOS zoom the page when it takes focus.
  expect(await fontSize(page, "task-title")).toBeGreaterThanOrEqual(16);
  expect(await fontSize(page, "task-deadline")).toBeGreaterThanOrEqual(16);

  // The palette is the app's other text dialog: it settles inside the same band,
  // its field first and its list scrolling under it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await settled(palette);
  expectInside(await palette.boundingBox(), band, "the palette");
  expectInside(
    await palette.getByRole("combobox", { name: "Search tasks or run a command" }).boundingBox(),
    band,
    "the palette field",
  );
});

test("a sheet that shrinks under a field it already focused keeps that field above the keyboard", async ({ page }) => {
  await page.addInitScript(fakeVisualViewport);
  await submitAuthForm(page, newEmail("mobile-late-keyboard"), "sign up");

  // The sequence iOS actually runs: the field is focused while the layout is still
  // full height, and the visual viewport shrinks a beat later as the keyboard
  // animates in. No second focus event fires, so the sheet has to re-reveal the
  // field it already holds.
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  await settled(sheet);
  await chooseOption(page, "Repeat", "Weekly");
  const start = sheet.getByLabel("Start date");
  await start.focus();
  expectInside(await start.boundingBox(), await visibleBand(page), "the start date before the keyboard");

  // A keyboard that leaves a third of the screen: the sheet now cannot show the
  // row it has focused, so its own scroller has to move.
  const visible = 220;
  await page.evaluate(height => (window as any).__simulateKeyboard(height), visible);
  const band = await visibleBand(page);

  await expect
    .poll(async () => {
      const box = await start.boundingBox();
      return box === null ? Number.POSITIVE_INFINITY : box.y + box.height;
    })
    .toBeLessThanOrEqual(band.bottom);
  expectInside(await start.boundingBox(), band, "the focused start date");
  expectInside(await sheet.boundingBox(), band, "the sheet");
  // The reveal moved the sheet's own scroller, not the page behind it.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expectNoSidewaysScroll(page);
});

test("the layout viewport the keyboard resizes needs no second inset and no sideways scroll", async ({ page }) => {
  await submitAuthForm(page, newEmail("mobile-widget"), "sign up");

  const meta = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "");
  expect(meta).toContain("interactive-widget=resizes-content");
  expect(meta).toContain("viewport-fit=cover");

  // Chrome on Android with interactive-widget=resizes-content shrinks the layout
  // viewport itself when the keyboard opens, so the same keyboard is simulated by
  // shrinking the viewport: the app must follow it without subtracting anything.
  await page.setViewportSize({ width: 390, height: keyboardOpenHeight });
  await expect.poll(() => readInset(page)).toBe(0);

  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  await settled(sheet);

  const box = await sheet.boundingBox();
  expect(box, "the sheet has a box").not.toBeNull();
  expect(box!.y, "the sheet top edge").toBeGreaterThanOrEqual(-0.5);
  expect(box!.y + box!.height, "the sheet bottom edge").toBeLessThanOrEqual(keyboardOpenHeight + 0.5);
  await expectNoSidewaysScroll(page);

  // The palette is centred in what is left, not in the full-height layout viewport.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  const paletteBox = await palette.boundingBox();
  expect(paletteBox!.y + paletteBox!.height, "the palette bottom edge").toBeLessThanOrEqual(keyboardOpenHeight + 0.5);
});

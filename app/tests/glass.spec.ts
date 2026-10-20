import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

// 2x so the 1px specular rim is actually legible in the saved screenshots.
test.use({ deviceScaleFactor: 2 });
test.setTimeout(60_000);

/* Screenshots are evidence for the parent review, not assertions. */
const shotDir = fileURLToPath(new URL("../../odd/runs/glass-shots", import.meta.url));

async function shot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

function newEmail() {
  return `glass-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Signs a fresh account in through the UI: the cheapest way to reach the app shell. */
async function enterApp(page: Page) {
  const email = newEmail();
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  // The shell renders before the planner loads; screenshots want the loaded page.
  await expect(page.getByText("Loading your planner…")).toHaveCount(0);
}

/**
 * Playwright 1.63 has no `reducedTransparency` option in `emulateMedia`, but
 * `prefers-reduced-transparency` is a media feature and CDP is the same switch
 * the browser exposes for the ones Playwright does wrap.
 */
async function emulateReducedTransparency(page: Page, value: "reduce" | "no-preference") {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value }],
  });
  await expect
    .poll(() => page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches))
    .toBe(value === "reduce");
}

/** `rgb(248 248 250 / 0.68)` -> 0.68, so the tint reads as a measured value. */
function alphaOf(color: string) {
  const inner = color.slice(color.indexOf("(") + 1, color.lastIndexOf(")"));
  const parts = inner.split("/");
  if (parts.length === 2) return Number(parts[1].trim());
  const commas = inner.split(",");
  return commas.length === 4 ? Number(commas[3].trim()) : 1;
}

test("materials: tint, blur and specular rim in light and dark", async ({ page }) => {
  await enterApp(page);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();

  const material = async () =>
    sidebar.evaluate((element) => {
      const style = getComputedStyle(element);
      const rim = getComputedStyle(element, "::after");
      return {
        backdropFilter: style.backdropFilter,
        background: style.backgroundColor,
        rimImage: rim.backgroundImage,
        rimMask: rim.maskImage,
      };
    });

  /* Light: the regular material, 20px / 170% / tint 0.68. */
  const light = await material();
  expect(light.backdropFilter).toContain("blur(20px)");
  expect(light.backdropFilter).toContain("saturate(1.7)");
  expect(alphaOf(light.background)).toBeCloseTo(0.68, 2);
  expect(light.rimImage).toContain("linear-gradient");
  expect(light.rimMask).not.toBe("none");

  await shot(page, "light-page");
  await sidebar.screenshot({ path: `${shotDir}/light-sidebar.png` });

  /* Dark: the same geometry, a thicker tint and a rim that actually shows. */
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(async () => alphaOf((await material()).background))
    .toBeCloseTo(0.72, 2);
  const dark = await material();
  expect(dark.backdropFilter).toContain("blur(20px)");
  expect(dark.rimImage).toContain("linear-gradient");
  await shot(page, "dark-page");
  await sidebar.screenshot({ path: `${shotDir}/dark-sidebar.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  const tabbar = page.locator(".tabbar");
  await expect(tabbar).toBeVisible();
  const thin = await tabbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backdropFilter: style.backdropFilter, background: style.backgroundColor };
  });
  expect(thin.backdropFilter).toContain("blur(12px)");
  expect(alphaOf(thin.background)).toBeCloseTo(0.5, 2);
  await shot(page, "light-phone-tabbar");
});

test("reduced transparency: solid surfaces instead of blur", async ({ page }) => {
  await enterApp(page);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();

  const read = async () =>
    sidebar.evaluate((element) => {
      const style = getComputedStyle(element);
      const rim = getComputedStyle(element, "::after");
      return {
        backdropFilter: style.backdropFilter,
        background: style.backgroundColor,
        rimDisplay: rim.display,
      };
    });

  expect((await read()).backdropFilter).toContain("blur");

  await emulateReducedTransparency(page, "reduce");
  const solid = await read();
  expect(solid.backdropFilter).toBe("none");
  expect(alphaOf(solid.background)).toBe(1);
  expect(solid.rimDisplay).toBe("none");

  await emulateReducedTransparency(page, "no-preference");
  expect((await read()).backdropFilter).toContain("blur");
});

test("forced colors: solid canvas surfaces with a real border", async ({ page }) => {
  await enterApp(page);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  await page.emulateMedia({ forcedColors: "active" });

  const surface = await sidebar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backdropFilter: style.backdropFilter,
      borderTopWidth: style.borderTopWidth,
      borderTopStyle: style.borderTopStyle,
      rimDisplay: getComputedStyle(element, "::after").display,
      blobDisplay: getComputedStyle(document.body, "::before").display,
    };
  });

  expect(surface.backdropFilter).toBe("none");
  expect(surface.borderTopWidth).toBe("1px");
  expect(surface.borderTopStyle).toBe("solid");
  expect(surface.rimDisplay).toBe("none");
  expect(surface.blobDisplay).toBe("none");
});

test("controls: rim, pill styling and an opacity-only press", async ({ page }) => {
  await enterApp(page);

  /* This slice is CSS-only and must not reach other crews' surfaces. */
  const glassCss = readFileSync(new URL("../src/ui/glass.css", import.meta.url), "utf8");
  for (const forbidden of [".calendar-block", ".toast", ".palette", "sync-line", "view-transition-name", "transform-origin"]) {
    expect(glassCss).not.toContain(forbidden);
  }

  const navPill = page.locator(".nav-pill").first();
  await expect(navPill).toBeVisible();
  const pill = await navPill.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, shadow: style.boxShadow };
  });
  expect(pill.background).toContain("linear-gradient");
  expect(pill.shadow).toContain("inset");

  const accent = page.locator(".button.button-accent").first();
  await expect(accent).toBeVisible();
  const read = () =>
    accent.evaluate((element) => {
      const rim = getComputedStyle(element, "::before");
      const press = getComputedStyle(element, "::after");
      const box = getComputedStyle(element);
      return {
        rimImage: rim.backgroundImage,
        rimMask: rim.maskImage,
        pressTransition: press.transitionProperty,
        pressDuration: press.transitionDuration,
        pressColor: press.backgroundColor,
        pressOpacity: press.opacity,
        transform: box.transform,
      };
    });

  const idle = await read();
  expect(idle.rimImage).toContain("linear-gradient");
  expect(idle.rimMask).not.toBe("none");
  /* Press animates opacity and nothing else: no transform or layout property. */
  expect(idle.pressTransition).toBe("opacity");
  expect(idle.pressOpacity).toBe("0");
  /* A saturated fill keeps the white brightening overlay from the spec. */
  expect(alphaOf(idle.pressColor)).toBeCloseTo(0.16, 2);

  /* Reduced motion: no transition left to run, but the feedback still lands. */
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await read();
  expect(parseDuration(reduced.pressDuration)).toBeLessThanOrEqual(1);

  await accent.hover();
  await page.mouse.down();
  await expect.poll(async () => (await read()).pressOpacity).toBe("1");
  await page.mouse.up();

  /* Screenshot the controls in place: segment track, pills and buttons. */
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.locator(".segmented")).toBeVisible();
  await shot(page, "light-calendar");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "dark-calendar");
});

function parseDuration(value: string) {
  const [amount, unit] = value.split(/(?=[a-z]+$)/);
  return unit === "s" ? Number(amount) * 1000 : Number(amount);
}

/**
 * The sheen is state held in two custom properties on the hovered element and
 * rendered by the pill's ::after. This reads all of it in one shot.
 */
async function readSheen(page: Page) {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>("[data-sheen]");
    const pill = button?.querySelector<HTMLElement>(".nav-pill, .tab-pill");
    if (!button || !pill) return null;
    const sheen = getComputedStyle(pill, "::after");
    const box = button.getBoundingClientRect();
    return {
      inline: button.getAttribute("style") ?? "",
      x: button.style.getPropertyValue("--sheen-x"),
      y: button.style.getPropertyValue("--sheen-y"),
      width: box.width,
      height: box.height,
      content: sheen.content,
      display: sheen.display,
      opacity: sheen.opacity,
      transition: sheen.transitionProperty,
      transform: sheen.transform,
    };
  });
}

test("sheen: one pointer-tracked highlight, written as custom properties", async ({ page }) => {
  await enterApp(page);

  /* Restraint is the spec: at most three tracked elements, and only the one
     holding the active slug exists at a time. */
  const tracked = await page.locator("[data-sheen]").count();
  expect(tracked).toBeGreaterThan(0);
  expect(tracked).toBeLessThanOrEqual(3);

  const idle = await readSheen(page);
  expect(idle).not.toBeNull();
  expect(idle!.inline).toBe("");
  expect(idle!.content).not.toBe("none");
  expect(idle!.opacity).toBe("0");
  /* Nothing but opacity is animated, and nothing waits on a layout property. */
  expect(idle!.transition).toBe("opacity");

  const button = page.locator("[data-sheen]").first();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.58);
  await expect.poll(async () => (await readSheen(page))!.x).not.toBe("");

  const hovered = (await readSheen(page))!;
  /* The variables carry the pointer offset inside the element, in pixels. */
  expect(Number.parseFloat(hovered.x)).toBeGreaterThan(hovered.width * 0.6);
  expect(Number.parseFloat(hovered.x)).toBeLessThanOrEqual(hovered.width);
  expect(Number.parseFloat(hovered.y)).toBeGreaterThan(0);
  expect(Number.parseFloat(hovered.y)).toBeLessThanOrEqual(hovered.height);
  /* Only custom properties are written: no inline width, top or transform. */
  expect(hovered.inline.replace(/--sheen-[xy]: -?[\d.]+px;?\s*/g, "").trim()).toBe("");
  /* The highlight is a transform on the layer, never a re-layout. */
  expect(hovered.transform).toContain("matrix");
  await expect.poll(async () => (await readSheen(page))!.opacity).toBe("1");
  mkdirSync(shotDir, { recursive: true });
  await page.locator(".sidebar").screenshot({ path: `${shotDir}/light-sheen.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".sidebar").screenshot({ path: `${shotDir}/dark-sheen.png` });
  await page.emulateMedia({ colorScheme: "light" });

  /* Leaving the slug clears the state instead of freezing the highlight. */
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await readSheen(page))!.opacity).toBe("0");
  expect((await readSheen(page))!.inline).toBe("");

  /* Reduced motion: the layer is gone and a move writes nothing. */
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await readSheen(page))!.display).toBe("none");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForTimeout(120);
  expect((await readSheen(page))!.inline).toBe("");
});

test.describe("coarse pointer", () => {
  /* A touch context reports (hover: none) and (pointer: coarse), which is the
     media query the sheen gate reads. */
  test.use({ hasTouch: true });

  test("sheen: no listener and no layer under (hover: none)", async ({ page }) => {
    await enterApp(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

    const button = page.locator("[data-sheen]").first();
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(120);

    const state = await readSheen(page);
    expect(state).not.toBeNull();
    expect(state!.inline).toBe("");
    expect(state!.content).toBe("none");
  });
});

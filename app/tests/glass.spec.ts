import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { password } from "./browser-helpers.ts";

// 2x so the 1px specular rim is actually legible in the saved screenshots.
test.use({ deviceScaleFactor: 2 });
test.setTimeout(60_000);

/* Screenshots are evidence for the parent review, not assertions. */
const shotDir = fileURLToPath(new URL("../../odd/runs/glass-shots", import.meta.url));

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

  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/light-page.png` });
  await sidebar.screenshot({ path: `${shotDir}/light-sidebar.png` });

  /* Dark: the same geometry, a thicker tint and a rim that actually shows. */
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(async () => alphaOf((await material()).background))
    .toBeCloseTo(0.72, 2);
  const dark = await material();
  expect(dark.backdropFilter).toContain("blur(20px)");
  expect(dark.rimImage).toContain("linear-gradient");
  await page.screenshot({ path: `${shotDir}/dark-page.png` });
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
  await page.screenshot({ path: `${shotDir}/light-phone-tabbar.png` });
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

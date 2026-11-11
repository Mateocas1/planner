import { expect, test, type Page } from "@playwright/test";
import { submitAuthForm } from "./browser-helpers.ts";

test.setTimeout(90_000);

/**
 * The creation sheet's flight pulls focus on its body with a
 * filter blur, except where the compositor handoff is installed (WebKitGTK),
 * where the body only fades. The shell marks that page with `__WEBKITGTK__`
 * before app scripts; here the flag is set the same way, before load.
 */

const newEmail = () => `sheet-flight-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

/** Records the keyframe properties of every animation started on `.sheet-body`. */
async function recordBodyAnimations(page: Page, webkitgtk: boolean) {
  await page.addInitScript(flag => {
    if (flag) (window as unknown as { __WEBKITGTK__?: boolean }).__WEBKITGTK__ = true;
    const seen: string[][] = [];
    (window as unknown as { __bodyFlights: string[][] }).__bodyFlights = seen;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (this.classList.contains("sheet-body") && Array.isArray(keyframes)) {
        seen.push([...new Set(keyframes.flatMap(frame => Object.keys(frame)))]);
      }
      return original.call(this, keyframes, options);
    };
  }, webkitgtk);
}

async function openNewTask(page: Page) {
  await submitAuthForm(page, newEmail(), "sign up");
  await page.getByRole("button", { name: "New task" }).click();
  const sheet = page.getByRole("complementary", { name: "New task" });
  await expect(sheet).toBeVisible();
  await expect.poll(() => sheet.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
}

const flights = (page: Page) => page.evaluate(() => (window as unknown as { __bodyFlights: string[][] }).__bodyFlights);

test("without the handoff the creation sheet's body animates a blur filter", async ({ page }) => {
  await recordBodyAnimations(page, false);
  await openNewTask(page);
  expect((await flights(page)).some(properties => properties.includes("filter"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-compositor-handoff"))).toBe(false);
});

test("under the compositor handoff the creation sheet's body animates no filter", async ({ page }) => {
  await recordBodyAnimations(page, true);
  await openNewTask(page);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-compositor-handoff"))).toBe(true);
  expect((await flights(page)).some(properties => properties.includes("filter"))).toBe(false);
  // the content still arrives: it is opacity-only, not skipped
  await expect(page.getByRole("complementary", { name: "New task" }).locator(".sheet-body")).toHaveCSS("opacity", "1");
});

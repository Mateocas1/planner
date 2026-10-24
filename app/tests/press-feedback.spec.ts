import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The press language spec (odd/tasks/ronda4.md S2): every pressable sinks
 * instantly on press, springs back with one small overshoot on release,
 * disabled controls never scale, and reduced motion keeps identity. It runs on
 * the auth gate, which renders before any account exists, so no emulator
 * sign-in is needed -- the shared `.button` styles under test are the app's
 * own, loaded through the production bundle the suite's webServer builds.
 */

const scaleX = (transform: string): number | null => {
  const match = transform.match(/^matrix\(([^)]+)\)$/);
  return match ? parseFloat(match[1].split(",")[0]) : null;
};

const computedTransform = (button: Locator) =>
  button.evaluate((el) => getComputedStyle(el).transform);

/** Samples the element's computed scaleX every frame for `duration` ms, in the
 * page (where `matrix` parsing must live). A `none` transform is identity and
 * contributes nothing: callers assert on the samples that exist. */
const sampleScales = (button: Locator, duration: number) =>
  button.evaluate(
    (el, ms) =>
      new Promise<number[]>((resolve) => {
        const parse = (transform: string): number | null => {
          const match = transform.match(/^matrix\(([^)]+)\)$/);
          return match ? parseFloat(match[1].split(",")[0]) : null;
        };
        const samples: number[] = [];
        const sample = () => {
          const scale = parse(getComputedStyle(el).transform);
          if (scale !== null) samples.push(scale);
          requestAnimationFrame(() => setTimeout(sample, 8));
        };
        sample();
        setTimeout(() => resolve(samples), ms);
      }),
    duration,
  );

test("a pressed button scales down and springs back with one overshoot", async ({ page }) => {
  const button = page.getByRole("button", { name: "Create account" });
  await page.goto("/");
  await expect(button).toBeVisible();

  await button.hover();
  await page.mouse.down();
  // Held: the press language's fixed depth, --press-scale 0.96.
  await expect
    .poll(() => computedTransform(button), { message: "the button sits at press depth while held" })
    .toBe("matrix(0.96, 0, 0, 0.96, 0, 0)");

  await page.mouse.up();
  // Release: sample the whole spring. The damped curve must cross identity
  // (overshoot > 1) and settle back to it; a plain ease-out would never cross.
  const scales = await sampleScales(button, 700);
  expect(
    Math.max(...scales),
    "the release overshoots identity before settling",
  ).toBeGreaterThan(1.002);
  await expect
    .poll(() => computedTransform(button), { message: "the button settles back to identity" })
    .toBe("none");
});

test("a disabled button does not scale", async ({ page }) => {
  // The gate disables its buttons while a sign-in is in flight; a route that
  // never settles parks the form in that state without an account.
  await page.route(/127\.0\.0\.1:9199\//, () => {
    /* the request hangs on purpose: busy stays true */
  });
  await page.goto("/");
  await page.getByLabel("Email").fill(`press-disabled-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("press-disabled");
  await page.keyboard.press("Enter");
  const button = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(button).toBeDisabled();

  await button.hover();
  await page.mouse.down();
  const scales = await sampleScales(button, 300);
  expect(
    scales.filter((scale) => Math.abs(scale - 1) > 0.001),
    "a held press on a disabled button never leaves identity",
  ).toEqual([]);
  await page.mouse.up();
});

test("reduced motion keeps identity on press", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const button = page.getByRole("button", { name: "Create account" });
  await page.goto("/");
  await expect(button).toBeVisible();

  await button.hover();
  await page.mouse.down();
  const scales = await sampleScales(button, 300);
  expect(
    scales.filter((scale) => Math.abs(scale - 1) > 0.001),
    "reduced motion presses with color/opacity only, never scale",
  ).toEqual([]);
  await page.mouse.up();
});

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { seedShutdownFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The Close day sheet is one surface at rest:
 * the page is transparent, so the colour under its content is the colour of the
 * panel's padding, on every look. The page beneath (Tomorrow) is not painted at
 * rest, and while the page is in motion an opaque backing hides it.
 *
 * Chromium is the engine under test; the flat look is the attribute main.tsx
 * sets on WebKitGTK, marked here before load.
 */

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);

const shotDir = fileURLToPath(new URL("../../odd/runs/r9-pagesurface-shots", import.meta.url));
const DAY_MS = 86_400_000;
/** Per-channel tolerance between the panel's padding and the page's content area. */
const TOLERANCE = 3;

type Rgb = [number, number, number];

/** A wall-clock 18:30 two days out, so the Home banner offers the ritual. */
function at1830(): Date {
  const base = new Date();
  base.setUTCHours(18, 30, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

/** Reads pixels out of a PNG screenshot by drawing it on a canvas in the page. */
async function pixels(png: Buffer, page: Page, points: Array<{ x: number; y: number }>): Promise<Rgb[]> {
  return page.evaluate(
    async ({ data, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return points.map(({ x, y }) => {
        const [r, g, b] = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [r, g, b] as [number, number, number];
      });
    },
    { data: png.toString("base64"), points },
  );
}

function maxDelta(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

for (const look of ["flat", "default"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`${look} look, ${theme}: Close day is one surface at rest, and tomorrow stays hidden`, async ({ page }) => {
      await page.addInitScript(
        ({ flat, theme }) => {
          window.localStorage.setItem("planner-theme", theme);
          window.localStorage.setItem("planner-replay-mode", "request");
          const mark = () => {
            if (document.documentElement === null) return false;
            document.documentElement.dataset.webkitgtk = "flat";
            return true;
          };
          if (flat && !mark()) {
            const observer = new MutationObserver(() => {
              if (mark()) observer.disconnect();
            });
            observer.observe(document, { childList: true });
          }
        },
        { flat: look === "flat", theme },
      );
      const base = at1830();
      await page.clock.install({ time: base });
      const key = base.toISOString().slice(0, 10);
      const email = `shutdown-surface-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
      await seedShutdownFixture(email, "UTC", {
        tasks: [
          { title: "Write the brief", completed: true, completedAt: `${key}T09:00:00Z` },
          { title: "Review the draft", deadline: key },
          { title: "Plan the quarter", deadline: new Date(base.getTime() + 3 * DAY_MS).toISOString().slice(0, 10) },
        ],
        blocks: [{ start: `${key}T09:00:00Z`, end: `${key}T10:00:00Z` }],
      });
      await expect(async () => {
        await submitAuthForm(page, email, "sign in");
      }).toPass({ timeout: 60_000 });
      await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (look === "flat") await expect(page.locator("html")).toHaveAttribute("data-webkitgtk", "flat");

      await page.locator(".shutdown-banner").getByRole("button", { name: "Close day" }).click();
      const sheet = page.getByRole("complementary", { name: "Close the day" });
      await expect(sheet).toBeVisible();
      await expect
        .poll(() => sheet.evaluate(element => element.getAnimations({ subtree: true }).filter(a => a.playState === "running").length))
        .toBe(0);

      const turn = sheet.locator(".page-turn");
      const top = sheet.locator(".page-turn-top");
      const under = sheet.locator(".page-turn-under");
      const backing = () => top.evaluate(element => Number(getComputedStyle(element, "::before").opacity));

      // At rest: tomorrow is not painted and the leaf's backing is off.
      await expect(turn).toHaveAttribute("data-page-turn-state", "rest");
      await expect(under).toHaveCSS("visibility", "hidden");
      expect(await backing()).toBe(0);
      await expect(top).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      // Pixel check, in the gap under the summary line (no text, no row card):
      // across the page's left and right edges, the padding and the page's own
      // content area. They are 16 px apart, so the sheet's diagonal sheen is
      // the same on both sides of each pair.
      const sheetBox = (await sheet.boundingBox())!;
      const topBox = (await top.boundingBox())!;
      const summary = (await sheet.locator(".shutdown-summary").boundingBox())!;
      const y = summary.y + summary.height + 8;
      mkdirSync(shotDir, { recursive: true });
      writeFileSync(`${shotDir}/${look}-${theme}-rest.png`, await page.screenshot({ clip: sheetBox }));
      const right = topBox.x + topBox.width;
      const [padL, bodyL, bodyR, padR] = await pixels(await page.screenshot(), page, [
        { x: topBox.x - 8, y },
        { x: topBox.x + 8, y },
        { x: right - 8, y },
        { x: right + 8, y },
      ]);
      expect(maxDelta(padL, bodyL), `${look}/${theme} left: padding rgb(${padL}) vs page rgb(${bodyL})`).toBeLessThanOrEqual(TOLERANCE);
      expect(maxDelta(padR, bodyR), `${look}/${theme} right: padding rgb(${padR}) vs page rgb(${bodyR})`).toBeLessThanOrEqual(TOLERANCE);

      // During a drag tomorrow comes into play, and an opaque backing covers it.
      const from = { x: topBox.x + topBox.width * 0.7, y: topBox.y + 40 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 6; step += 1) await page.mouse.move(from.x - step * 20, from.y);
      await expect(turn).toHaveAttribute("data-page-turn-state", "drag");
      await expect(under).toHaveCSS("visibility", "visible");
      expect(await backing()).toBe(1);
      // Opaque: a backing with any alpha lets tomorrow ghost through today.
      const paint = await top.evaluate(element => getComputedStyle(element, "::before").backgroundColor);
      expect(paint, `${look}/${theme}: the backing colour`).not.toMatch(/\/\s*0?\.\d+\)$/);
      writeFileSync(`${shotDir}/${look}-${theme}-drag.png`, await page.screenshot({ clip: sheetBox }));
      // Held still, a slow release is decided by distance alone: it springs back.
      await page.waitForTimeout(400);
      await page.mouse.up();
      // A short drag springs back: the leaf returns, the backing fades, tomorrow hides.
      await expect(turn).toHaveAttribute("data-page-turn-state", "rest");
      await expect(under).toHaveCSS("visibility", "hidden");
      await expect.poll(() => backing()).toBe(0);
    });
  }
}

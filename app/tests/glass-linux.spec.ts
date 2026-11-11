import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedShutdownFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Flat glass on Linux: `html[data-webkitgtk="flat"]` (set by
 * main.tsx on the WebKitGTK webview) turns the sheet into a near-opaque panel
 * with no backdrop filter and a stronger scrim. Chromium is the engine under
 * test, so the attribute is set before load by hand; the assertions are about
 * the computed style the CSS produces, and that nothing changes without it.
 */

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.setTimeout(120_000);

const shotDir = fileURLToPath(new URL("../../odd/runs/r9-flat-shots", import.meta.url));
const DAY_MS = 86_400_000;

type Theme = "light" | "dark";

/** The values the CSS declares, per look and scheme (glass.css, glass-linux.css). */
const expected = {
  default: { light: { tint: 0.88, scrim: 0.16 }, dark: { tint: 0.9, scrim: 0.42 } },
  flat: { light: { tint: 0.96, scrim: 0.28 }, dark: { tint: 0.97, scrim: 0.6 } },
} as const;

function alphaOf(color: string): number {
  const inner = color.slice(color.indexOf("(") + 1, color.lastIndexOf(")"));
  const slash = inner.split("/");
  if (slash.length === 2) return Number(slash[1].trim());
  const commas = inner.split(",");
  return commas.length === 4 ? Number(commas[3].trim()) : 1;
}

/** A wall-clock 18:30 two days out, so the Home banner offers the ritual. */
function at1830(): Date {
  const base = new Date();
  base.setUTCHours(18, 30, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

async function settle(sheet: Locator) {
  await expect(sheet).toBeVisible();
  // A finished animation that fills forwards is at rest; only running ones count.
  await expect
    .poll(() => sheet.evaluate(element => element.getAnimations({ subtree: true }).filter(a => a.playState === "running").length))
    .toBe(0);
}

async function measure(page: Page, sheet: Locator) {
  const material = await sheet.evaluate(element => {
    const style = getComputedStyle(element);
    return { backdropFilter: style.backdropFilter, background: style.backgroundColor, boxShadow: style.boxShadow };
  });
  const scrim = await page.locator(".scrim").last().evaluate(element => getComputedStyle(element).backgroundColor);
  return { ...material, scrim };
}

async function shot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

for (const look of ["flat", "default"] as const) {
  for (const theme of ["dark", "light"] as const satisfies readonly Theme[]) {
    test(`${look} look, ${theme}: Close day and New task sheets`, async ({ page }) => {
      await page.addInitScript(
        ({ flat, theme }) => {
          window.localStorage.setItem("planner-theme", theme);
          window.localStorage.setItem("planner-replay-mode", "request");
          // The init script can run before <html> exists; mark it the moment it does.
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
      const email = `glass-linux-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
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
      else await expect(page.locator("html")).not.toHaveAttribute("data-webkitgtk", /.*/);

      const want = expected[look][theme];
      const check = async (sheet: Locator, name: string) => {
        await settle(sheet);
        const m = await measure(page, sheet);
        if (look === "flat") expect(m.backdropFilter, `${name} backdrop-filter`).toBe("none");
        else expect(m.backdropFilter, `${name} backdrop-filter`).toContain("blur(32px)");
        expect(alphaOf(m.background), `${name} tint`).toBeCloseTo(want.tint, 2);
        expect(alphaOf(m.scrim), `${name} scrim`).toBeCloseTo(want.scrim, 2);
        // The rim, the sheen and the shadow stay in both looks.
        expect(m.boxShadow, `${name} shadow`).not.toBe("none");
        await shot(page, `${look}-${theme}-${name}`);
      };

      // Close day (Today): the Home banner opens the ritual sheet.
      await page.locator(".shutdown-banner").getByRole("button", { name: "Close day" }).click();
      const ritual = page.getByRole("complementary", { name: "Close the day" });
      await check(ritual, "close-day");
      await page.keyboard.press("Escape");
      await expect(page.locator(".sheet")).toHaveCount(0);

      // New task: the Motion/WAAPI creation sheet.
      await page.getByRole("button", { name: "New task" }).click();
      await check(page.getByRole("complementary", { name: "New task" }), "new-task");
      await page.keyboard.press("Escape");
      await expect(page.locator(".sheet")).toHaveCount(0);
    });
  }
}

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  seedShutdownFixture,
  submitAuthForm,
} from "./browser-helpers.ts";

/**
 * S8 (unit x5): the rituals read in Spanish on a device that chose it.
 * The shutdown sheet, the weekly review flow and their sentences are asserted,
 * and each surface is photographed at desktop and phone width for the clipping
 * review.
 */

test.setTimeout(180_000);

const shotDir = fileURLToPath(new URL("../../odd/runs/r5-x5-shots", import.meta.url));
const newEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

async function shot(page: Page, name: string) {
  await page.waitForFunction(() =>
    (document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] })
      .getAnimations({ subtree: true }).every(animation => animation.playState !== "running"),
  );
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

async function overflowing(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll(elements =>
    elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
  );
}

async function signIn(page: Page, email: string) {
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
  // The auth form is English-labelled in the shared helper: switch this device afterwards.
  await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test.describe(label, () => {
    test.use(label === "phone" ? { viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport });

    test("the shutdown sheet reads in Spanish", async ({ page }) => {
      const base = new Date();
      base.setUTCHours(18, 30, 0, 0);
      base.setUTCDate(base.getUTCDate() + 2);
      const key = base.toISOString().slice(0, 10);
      await page.clock.install({ time: base });
      const email = newEmail("x5-shutdown");
      await seedShutdownFixture(email, "UTC", {
        tasks: [
          { title: "Write the brief", completed: true, completedAt: `${key}T09:00:00Z` },
          { title: "Review the draft", deadline: key },
          { title: "Fix the chart axis", deadline: key },
        ],
      });
      await signIn(page, email);

      const banner = page.locator(".shutdown-banner");
      if (label === "phone") {
        // A thumb turns the page: swipe the banner's own words, as the shutdown spec does.
        await expect(banner).toBeVisible();
        const bar = (await banner.boundingBox())!;
        const cdp = await page.context().newCDPSession(page);
        const y = bar.y + bar.height / 2;
        const xs = Array.from({ length: 11 }, (_, index) => bar.x + bar.width - 30 - ((bar.width - 50) * index) / 10);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: xs[0], y, id: 1 }] });
        for (const x of xs.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      } else {
        await banner.getByRole("button").first().click();
      }
      const sheet = page.getByRole("complementary", { name: "Cerrar el día" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Hechas: 1 · Pendientes: 2")).toBeVisible();
      await expect(sheet.getByRole("region", { name: "Hecho" })).toBeVisible();
      await expect(sheet.getByRole("region", { name: "Pendiente" })).toBeVisible();
      await expect(sheet.getByText(label === "phone" ? "Desliza a la izquierda para cerrar el día" : "Arrastrar a la izquierda o pulsar Cerrar el día")).toBeVisible();
      if (label === "desktop") await expect(sheet.getByRole("button", { name: "Cerrar el día" })).toBeVisible();
      await sheet.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
      });
      expect(await overflowing(page, ".shutdown-sheet *")).toEqual([]);
      await shot(page, `shutdown-es-${label}-light`);
    });

    test("the weekly review reads in Spanish", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-10-23T17:30:00Z"));
      const email = newEmail("x5-weekly");
      await seedShutdownFixture(email, "UTC", {
        tasks: [
          { title: "Spec review", completed: true, completedAt: "2026-10-20T10:00:00Z" },
          { title: "Old report", deadline: "2026-10-19" },
        ],
        blocks: [{ start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z", task: "Spec review" }],
      });
      await signIn(page, email);

      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").first().fill("semanal");
      await page.getByRole("option", { name: "Revisión semanal" }).click();
      const flow = page.getByRole("region", { name: "Revisión semanal" });
      await expect(flow).toBeVisible();
      await expect(flow).toContainText("Semana 43");
      await expect(flow).toContainText("Paso 1 de 4");
      await expect(flow.getByRole("list", { name: "Pasos de la revisión" })).toContainText("Limpiar");
      await expect(flow).toContainText("Cómo fue realmente la semana.");
      await expect(flow).toContainText("Planificado frente a real");
      await expect(flow).toContainText("1 de 1 tarea planificada completada");
      expect(await overflowing(page, ".weekly *")).toEqual([]);
      await shot(page, `weekly-review-es-${label}-light`);

      await flow.getByRole("button", { name: "Siguiente" }).click();
      await expect(flow).toContainText("Decidir qué hacer con lo que ha quedado pendiente.");
      await expect(flow.getByRole("button", { name: "Esta semana" })).toBeVisible();
    });
  });
}

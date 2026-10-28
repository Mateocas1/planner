import { expect, test } from "@playwright/test";
import { expectSignedIn, seedRadarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Ronda 5, S8 (unit x4): the Calendar and plan-my-day in Spanish. The language
 * is pinned on this device after sign-in, as the Language switch would leave it.
 */

test.setTimeout(120_000);

const shots = "../odd/runs/r5-x4-shots";

for (const [name, viewport] of [
  ["1440x900", { width: 1440, height: 900 }],
  ["390x844", { width: 390, height: 844 }],
] as const) {
  test(`the Calendar and Plan my day read in Spanish (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const email = `x4-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
    await seedRadarFixture(email, "UTC", { tasks: [{ title: "Informe trimestral", estimate: 90 }, { title: "Pagar impuestos", estimate: 45 }] });
    await submitAuthForm(page, email, "sign in");
    await expectSignedIn(page, email);
    await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
    await page.reload();
    await expectSignedIn(page, email);
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await page.locator("nav").first().getByRole("button", { name: /^(Calendar|Calendario)$/ }).click();
    await expect(page.getByRole("heading", { level: 3, name: "Sin programar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nuevo bloque" })).toBeVisible();
    // The sidebar / tab bar also carry a "Hoy" button: scope to the calendar's own navigation.
    await expect(page.getByRole("group", { name: "Navegación del calendario" }).getByRole("button", { name: "Hoy", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Planificar mi día" }).click();
    await expect(page.getByRole("group", { name: "Plan propuesto" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Aplicar \d+ bloques?$/ })).toBeVisible();
    await page.waitForTimeout(700); // let the proposal rows finish their entrance
    await page.screenshot({ path: `${shots}/calendar-${name}.png` });
  });
}

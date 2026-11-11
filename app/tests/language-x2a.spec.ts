import { expect, test } from "@playwright/test";
import { expectSignedIn, seedDaySettings, submitAuthForm } from "./browser-helpers.ts";

/**
 * The app shell in Spanish -- navigation, sync line,
 * New task sheet and the account menu -- plus two screenshots for the layout check.
 */

test.setTimeout(120_000);

/* Next to this checkout's, not an absolute path into another checkout. */
const shots = new URL("../test-results/shots/r5-x2a-shots/", import.meta.url).pathname;

const newEmail = () => `lang-x2a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`the shell reads in Spanish (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const email = newEmail();
    await seedDaySettings(email, { timeZone: "UTC" });
    await submitAuthForm(page, email, "sign in");
    await expectSignedIn(page, email);
    // The sign-in form is Spanish too: sign in in English, then pick the language.
    await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
    await page.reload();
    await expectSignedIn(page, email);

    const nav = page.getByRole("navigation", { name: "Principal" });
    await expect(nav.getByRole("button", { name: /^Hoy/ })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Tareas/ })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Calendario/ })).toBeVisible();
    await expect(page).toHaveTitle("Hoy · Personal Planner");

    if (name === "desktop") {
      await expect(page.getByRole("button", { name: "Revisión semanal" })).toBeVisible();
      await expect(page.getByText("Sincronizado")).toBeVisible();
      await expect(page.getByRole("heading", { name: "A continuación" })).toBeVisible();
      await page.getByRole("button", { name: "Nueva tarea" }).first().click();
    } else {
      await page.getByRole("button", { name: "Nueva tarea" }).click();
    }
    const sheet = page.getByRole("complementary", { name: "Nueva tarea" });
    await expect(sheet.getByPlaceholder("¿Qué hay que hacer?")).toBeVisible();
    await expect(sheet.getByText("Fecha límite")).toBeVisible();
    await expect(sheet.getByText("Repetir", { exact: true }).first()).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Añadir tarea" })).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}shell-es-${name}.png` });
  });
}

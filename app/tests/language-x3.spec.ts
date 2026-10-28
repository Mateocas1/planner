import { expect, test } from "@playwright/test";
import { expectSignedIn, seedDaySettings, seedTasks, submitAuthForm } from "./browser-helpers.ts";

/**
 * Ronda 5, S8 (unit x3): Today, Tasks and the task sheet read in Spanish when
 * this device is set to Español. The language is pinned through the device
 * override (`planner-language`) before the app starts, as Settings would.
 */

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

test("Today, Tasks and the task sheet are in Spanish", async ({ page }) => {
  const email = `x3-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const today = new Date().toISOString().slice(0, 10);
  await seedDaySettings(email, { timeZone: "UTC" });
  await seedTasks(email, [{ title: "Pagar el alquiler", deadline: today }, { title: "Sin fecha" }]);
  await submitAuthForm(page, email, "sign in");
  await expectSignedIn(page, email);
  // This device switches to Español, as Settings does, and the app follows after a reload.
  await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("heading", { name: "Hoy", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vence hoy" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Completar: Pagar el alquiler" })).toBeVisible();

  await page.locator("nav").getByRole("button", { name: /^(Tasks|Tareas)\b/ }).click();
  await expect(page.getByRole("heading", { name: "Tareas", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Abiertas/ })).toBeVisible();
  await expect(page.getByText("vence hoy")).toBeVisible();

  await page.getByRole("button", { name: "Pagar el alquiler vence hoy" }).click();
  const sheet = page.getByRole("complementary", { name: "Detalles de la tarea" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Fecha límite")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Eliminar tarea" })).toBeVisible();
});

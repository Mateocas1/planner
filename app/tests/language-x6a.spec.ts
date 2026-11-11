import { expect, test, type Page } from "@playwright/test";
import { expectSignedIn, seedDaySettings, submitAuthForm } from "./browser-helpers.ts";

/**
 * S8 (U6a): the Settings tabs read in Spanish. Representative strings
 * of General, Rituals and Shortcuts; the section and tab names; and the unchanged
 * English once the device switches back. `X6A_SHOTS=<dir>` also saves the Spanish
 * screenshots the unit's report cites.
 */

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

async function enterSpanishSettings(page: Page) {
  const email = `x6a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await seedDaySettings(email, { timeZone: "UTC" });
  await submitAuthForm(page, email, "sign in");
  await expectSignedIn(page, email);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Only on this device" }).click();
  await page.getByRole("button", { name: "Español", exact: true }).click();
  await expect(page.getByRole("region", { name: "Ajustes" })).toBeVisible();
  return page.getByRole("region", { name: "Ajustes" });
}

async function shot(page: Page, name: string) {
  const dir = process.env.X6A_SHOTS;
  if (dir) await page.waitForTimeout(500); // let the pane cross-fade settle
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test("General, Rituals and Shortcuts are in Spanish and the rail is named in Spanish", async ({ page }) => {
  const view = await enterSpanishSettings(page);
  const rail = view.getByRole("navigation", { name: "Secciones de Ajustes" });
  await expect(rail.getByRole("button", { name: "Rituales" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Atajos" })).toBeVisible();

  await expect(view.getByRole("heading", { name: "Jornada" })).toBeVisible();
  await expect(view.getByText("Inicio del trabajo")).toBeVisible();
  await expect(view.getByRole("switch", { name: "Atajos de teclado" })).toBeVisible();
  await shot(page, "general-desktop");

  // A refused time says so in Spanish.
  await view.getByLabel("Inicio del trabajo").fill("nope");
  await view.getByLabel("Inicio del trabajo").blur();
  await expect(view.getByText("Usa una hora como 09:00.")).toBeVisible();

  await rail.getByRole("button", { name: "Rituales" }).click();
  await expect(view.getByRole("heading", { name: "Cierre diario" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Editar en General" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Añadir un momento" })).toBeVisible();
  await expect(view.getByRole("group", { name: "Pasos" }).getByRole("button", { name: "Planificar", exact: true }).first()).toBeVisible();
  await shot(page, "rituals-desktop");

  await rail.getByRole("button", { name: "Atajos" }).click();
  await expect(view.getByRole("heading", { name: "Personalizar" })).toBeVisible();
  await expect(view.getByRole("heading", { name: "Integrados" })).toBeVisible();
});

test("the Spanish tabs fit a phone", async ({ page }) => {
  const view = await enterSpanishSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await view.getByRole("navigation", { name: "Secciones de Ajustes" }).getByRole("button", { name: "Rituales" }).click();
  await expect(view.getByRole("heading", { name: "Cierre diario" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "rituals-phone");
});

import { expect, test } from "@playwright/test";
import { expectSignedIn, seedDaySettings, submitAuthForm } from "./browser-helpers.ts";

/**
 * S8 (unit x2b): the command palette and the shortcut sheet in
 * Spanish. The language is pinned on this device after sign-in (the auth form is
 * another unit's), as the Language switch would have left it.
 */

test.setTimeout(120_000);

const shots = "../odd/runs/r5-x2b-shots";

for (const [name, viewport] of [
  ["1440x900", { width: 1440, height: 900 }],
  ["390x844", { width: 390, height: 844 }],
] as const) {
  test(`palette and shortcut sheet read in Spanish (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const email = `x2b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
    await seedDaySettings(email, { timeZone: "UTC", shortcutsEnabled: true });
    await submitAuthForm(page, email, "sign in");
    await expectSignedIn(page, email);
    await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
    await page.reload();
    await expectSignedIn(page, email);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Paleta de comandos" });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox", { name: "Buscar tareas o ejecutar un comando" })).toBeVisible();
    await palette.getByRole("combobox").fill("semanal");
    await expect(palette.getByRole("option", { name: "Revisión semanal" })).toBeVisible();
    await expect(palette.getByRole("option", { name: /^Crear «semanal»/ })).toBeVisible();
    await page.screenshot({ path: `${shots}/palette-${name}.png` });
    await page.keyboard.press("Escape");

    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Atajos de teclado" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Actuar sobre la fila enfocada" })).toBeVisible();
    await expect(sheet.getByText("Completar la tarea")).toBeVisible();
    await page.screenshot({ path: `${shots}/shortcuts-${name}.png` });
    const overflow = await sheet.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
  });
}

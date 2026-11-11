import { expect, test, type Page } from "@playwright/test";
import { expectSignedIn, readRemoteProfile, seedDaySettings, submitAuthForm } from "./browser-helpers.ts";

/**
 * The app can be read in Spanish. The effective language is the
 * device override ?? the account's synced choice ?? English, switched live from
 * Settings > General > Language. What the user reads is asserted: the section
 * title, the Today date line, `<html lang>`, and that the choice survives a
 * reload; and, for the account scope, what the server holds.
 */

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

const englishDay = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}/;
const spanishDay = /^(Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo), \d{1,2} de [a-zé]+/;

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

const newEmail = () => `lang-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

async function enter(page: Page) {
  const email = newEmail();
  await seedDaySettings(email, { timeZone: "UTC" });
  await submitAuthForm(page, email, "sign in");
  await expectSignedIn(page, email);
  return email;
}

const dateLine = (page: Page) => page.locator("#home-heading + .subtitle");
const settings = (page: Page) => page.getByRole("region", { name: /^(Settings|Ajustes)$/ });
const english = (page: Page) => page.getByRole("button", { name: "English", exact: true });
const spanish = (page: Page) => page.getByRole("button", { name: "Español", exact: true });
const deviceOnly = (page: Page) => page.getByRole("switch", { name: /^(Only on this device|Solo en este dispositivo)$/ });

async function openSettings(page: Page) {
  await page.getByRole("button", { name: /^(Settings|Ajustes)$/ }).click();
  await expect(settings(page)).toBeVisible();
}

test("English is the default and Settings offers the Language choice", async ({ page }) => {
  await enter(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(dateLine(page)).toHaveText(englishDay);
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Language" })).toBeVisible();
  await expect(english(page)).toHaveAttribute("aria-pressed", "true");
  await expect(spanish(page)).toHaveAttribute("aria-pressed", "false");
  await expect(deviceOnly(page)).toHaveAttribute("aria-checked", "false");
});

test("Español on this device only: text and dates switch live, survive a reload, and switch back", async ({ page }) => {
  const email = await enter(page);
  await openSettings(page);
  await deviceOnly(page).click();
  await spanish(page).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("heading", { name: "Idioma" })).toBeVisible();
  await expect(spanish(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(dateLine(page)).toHaveText(spanishDay);

  await page.reload();
  await expectSignedIn(page, email);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(dateLine(page)).toHaveText(spanishDay);

  // The account was left alone: nothing was written to the profile.
  expect(((await readRemoteProfile(email)) as { language?: string }).language).toBeUndefined();

  await openSettings(page);
  await english(page).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Language" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dateLine(page)).toHaveText(englishDay);
});

test("Español for every device is saved to the account and a second device follows it", async ({ page, browser }) => {
  const email = await enter(page);
  await openSettings(page);
  await spanish(page).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect.poll(async () => ((await readRemoteProfile(email)) as { language?: string }).language, poll).toBe("es");

  // A fresh browser context is another device: no override, no cache, an account.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const second = await other.newPage();
    await submitAuthForm(second, email, "sign in");
    await expect(second.locator("html")).toHaveAttribute("lang", "es", { timeout: 15_000 });
    await expect(dateLine(second)).toHaveText(spanishDay);

    // Setting this device apart does not move the account's choice.
    await openSettings(second);
    await deviceOnly(second).click();
    await english(second).click();
    await expect(second.locator("html")).toHaveAttribute("lang", "en");
    expect(((await readRemoteProfile(email)) as { language?: string }).language).toBe("es");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  } finally {
    await other.close();
  }
});

test("Spanish dates start with a capital, the DateField reads Mañana and the mini-month starts on L", async ({ page }) => {
  await enter(page);
  await openSettings(page);
  await deviceOnly(page).click();
  await spanish(page).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.keyboard.press("Escape");

  // The Today subtitle opens the line with a capital letter ("Martes, 29 de septiembre").
  await expect(dateLine(page)).toHaveText(spanishDay);

  // The mini-month: weekday letters from Intl, Monday first, and a capitalised title.
  const month = page.locator(".mini-month");
  await expect(month.locator(".mini-dow")).toHaveText(["L", "M", "X", "J", "V", "S", "D"]);
  await expect(month.locator(".mini-title")).toHaveText(/^[A-ZÁÉÍÓÚÑ]/);

  // The DateField trigger: tomorrow is a word, capitalised because it is a label.
  await page.getByRole("button", { name: "Nueva tarea" }).first().click();
  const sheet = page.getByRole("complementary", { name: "Nueva tarea" });
  const deadline = sheet.getByLabel("Fecha límite");
  await deadline.click();
  // The quick rows keep their (not yet translated) labels; the second one is tomorrow.
  await page.locator(".date-quick .date-row").nth(1).click();
  await expect(deadline).toHaveText("Mañana");
});

import { expect, test, type Page } from "@playwright/test";
import { createRemoteAccount, expectSignedIn, submitAuthForm, updateRemoteProfile } from "./browser-helpers.ts";

/**
 * S8 (unit x6b): the Google Calendar import reads in Spanish. Google is
 * stubbed at the network edge exactly as in gcal-import.spec.ts; the language is
 * this device's override, set before the app loads.
 */

test.setTimeout(90_000);

const dayMs = 86_400_000;
const dayKey = (offset = 0) => new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);
const shots = process.env.X6B_SHOTS;

async function stubGoogle(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient(config: { callback: (response: { access_token: string }) => void }) {
            return { requestAccessToken: () => config.callback({ access_token: "stub-access-token" }) };
          },
          revoke() {},
        },
      },
    };
  });
  await page.route("https://accounts.google.com/gsi/client", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "/* stub */" }),
  );
  const today = dayKey(0);
  const event = (id: string, extra: object) => ({
    id,
    status: "confirmed",
    summary: id,
    updated: "2026-10-18T09:00:00.000Z",
    start: { dateTime: `${today}T10:00:00+00:00` },
    end: { dateTime: `${today}T11:00:00+00:00` },
    ...extra,
  });
  await page.route("https://www.googleapis.com/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/calendarList")) {
      return route.fulfill({ json: { items: [{ id: "primary", summary: "Calendario principal", primary: true }] } });
    }
    return route.fulfill({
      json: {
        items: [
          event("evt-a", {}),
          event("evt-b", { start: { dateTime: `${today}T12:00:00+00:00` }, end: { dateTime: `${today}T13:00:00+00:00` } }),
          event("evt-tax", { start: { date: dayKey(3) }, end: { date: dayKey(4) } }),
          event("evt-cancelled", { status: "cancelled" }),
        ],
      },
    });
  });
}

test("the Google Calendar import sheet reads in Spanish and imports with a Spanish toast", async ({ page }) => {
  const email = `x6b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  await stubGoogle(page);
  await submitAuthForm(page, email, "sign in");
  await expectSignedIn(page, email);
  await page.evaluate(() => localStorage.setItem("planner-language", "es"));
  await page.reload();
  await expectSignedIn(page, email);

  await page.getByRole("button", { name: /^(Import from Google Calendar|Importar desde Google Calendar)$/ }).click();
  const sheet = page.getByRole("complementary", { name: "Importar desde Google Calendar" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Todavía no se ha escrito nada", { exact: false }).or(sheet.getByText(/Solo lee de Google/))).toBeVisible();

  await sheet.getByRole("button", { name: "Conectar Google Calendar" }).click();
  await expect(sheet.getByText("2 bloques de trabajo y 1 tarea para importar")).toBeVisible();
  await expect(sheet.getByText("Omitidos: 1 cancelado.")).toBeVisible();
  await expect(sheet.getByText("Principal", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("radio", { name: "30 días" })).toBeVisible();
  if (shots) {
    await page.screenshot({ path: `${shots}-1440x900.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shots}-390x844.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  await sheet.getByRole("button", { name: "Importar 3 elementos" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Se importaron 2 bloques de trabajo y 1 tarea");
});

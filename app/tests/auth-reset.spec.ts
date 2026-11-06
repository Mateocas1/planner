import { expect, test, type Page } from "@playwright/test";

/** Ronda 7, R7-16: "Forgot password?" on the sign-in form sends a Firebase reset email. */

test.setTimeout(60_000);

const sentCopy = "If an account uses this email, a link to reset the password is on its way. Check your inbox.";
const newEmail = (tag: string) => `reset-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

/** The reset emails the auth emulator has "sent" to this address. */
async function resetCodesFor(email: string) {
  const response = await fetch("http://127.0.0.1:9199/emulator/v1/projects/demo-calendar-app/oobCodes");
  const { oobCodes } = (await response.json()) as { oobCodes: { email: string; requestType: string }[] };
  return oobCodes.filter(code => code.email === email && code.requestType === "PASSWORD_RESET");
}

async function requestReset(page: Page, email: string, label = "Forgot password?") {
  await page.getByLabel(/^(Email|Correo electrónico)$/).fill(email);
  await page.getByRole("button", { name: label, exact: true }).click();
}

test("an existing account gets a reset email and a plain confirmation", async ({ page }) => {
  const email = newEmail("known");
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-1");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Sign out" }).click();

  await requestReset(page, email);
  await expect(page.getByRole("status").filter({ hasText: sentCopy })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(async () => (await resetCodesFor(email)).length, { timeout: 10_000 }).toBe(1);
});

test("an unknown email reads exactly the same", async ({ page }) => {
  await page.goto("/");
  await requestReset(page, newEmail("unknown"));
  await expect(page.getByRole("status")).toHaveText(sentCopy, { timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a missing or malformed email is flagged on the email field only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Enter a valid email address.");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-describedby", "auth-error");
  await expect(page.getByLabel("Password")).not.toHaveAttribute("aria-invalid", "true");

  await requestReset(page, "not-an-email");
  await expect(alert).toHaveText("Enter a valid email address.", { timeout: 20_000 });
  await expect(alert).not.toContainText("Firebase:");
  await expect(page.getByText(sentCopy)).toHaveCount(0);
});

test("a network failure says so and can be retried from the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.route("**/accounts:sendOobCode*", route => route.abort("internetdisconnected"));
  await page.getByLabel("Email").fill(newEmail("offline"));
  await page.getByRole("button", { name: "Forgot password?", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("No connection. Check your network and try again.", { timeout: 20_000 });

  await page.unroute("**/accounts:sendOobCode*");
  await expect(page.getByRole("button", { name: "Forgot password?", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText(sentCopy, { timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the reset reads in Spanish", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("planner-language", "es"));
  await page.goto("/");
  await requestReset(page, newEmail("es"), "¿Olvidaste tu contraseña?");
  await expect(page.getByRole("status")).toHaveText(
    "Si hay una cuenta con este correo, te enviamos un enlace para restablecer la contraseña. Revisa tu bandeja de entrada.",
    { timeout: 20_000 },
  );
});

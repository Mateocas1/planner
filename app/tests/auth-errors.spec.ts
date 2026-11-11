import { expect, test } from "@playwright/test";

/** Sign-in failures read as plain sentences, never the SDK's raw message. */

test.setTimeout(60_000);

async function trySignIn(page: import("@playwright/test").Page, email: string, password: string, reload = true) {
  if (reload) await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("an unknown account gets a plain message wired to both fields", async ({ page }) => {
  await trySignIn(page, `nobody-${Date.now()}@example.invalid`, "correct-horse-1");
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("That email and password do not match an account.", { timeout: 20_000 });
  await expect(alert).not.toContainText("Firebase:");
  await expect(alert).not.toContainText("auth/");
  for (const name of ["Email", "Password"]) {
    const field = page.getByLabel(name);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", "auth-error");
  }
});

test("a wrong password for an existing account gets the same message", async ({ page }) => {
  const email = `wrong-${Date.now()}@example.invalid`;
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-1");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await trySignIn(page, email, "not-the-password", false);
  await expect(page.getByRole("alert")).toHaveText("That email and password do not match an account.", { timeout: 20_000 });
  await expect(page.getByRole("alert")).not.toContainText("Firebase:");
});

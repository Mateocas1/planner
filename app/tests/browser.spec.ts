import { expect, test } from "@playwright/test";
import { password, readRemoteState, seedTaskAndBlock } from "./browser-helpers.ts";

test.setTimeout(60_000);

test("walking skeleton: account creation, truthful Home counts, and navigation", async ({ page }) => {
  const email = `walk-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  const start = "2026-03-02T09:00:00-03:00";

  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();

  await expect(page.getByText("No tasks and no work blocks yet")).toBeVisible();

  await seedTaskAndBlock(email, "Skeleton task", start, "2026-03-02T10:00:00-03:00");
  await expect(page.getByText("Tasks: 1")).toBeVisible();
  await expect(page.getByText("Work blocks: 1")).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByText("arrives in increment I2")).toBeVisible();
  await nav.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("arrives in increment I3")).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByText("Tasks: 1")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Work blocks: 1")).toBeVisible();
  const remote = await readRemoteState(email);
  expect(remote).toEqual({ taskTitles: ["Skeleton task"], blockStarts: [start] });
});

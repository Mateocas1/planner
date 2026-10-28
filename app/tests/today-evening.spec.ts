import { expect, test, type Page } from "@playwright/test";
import { seedDaySettings, seedTaskAndBlock, submitAuthForm } from "./browser-helpers.ts";

/**
 * Today stays truthful about the time of day (Ronda 5, W8, audit R5-17/R5-18):
 * at 17:30 the morning's brief, the Full screen link and an enabled Plan my day
 * are three prompts with no valid action, so none of them is offered; and the
 * empty cards carry the action their copy names.
 *
 * The clock is installed before the app loads (and left running), so "17:30"
 * is a property of the fixture, not of the hour the suite runs at.
 */

test.setTimeout(150_000);

const ZONE = "UTC";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** 17:30 UTC two days out: clear of the account's creation and of real midnight. */
function eveningNow(): Date {
  const base = new Date();
  base.setUTCHours(17, 30, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

test("at 17:30 Today has no brief, no Full screen and a Plan my day that says why it is disabled", async ({ page }) => {
  const base = eveningNow();
  const day = base.toISOString().slice(0, 10);
  const email = newEmail("today-evening");
  // Window 09:00-17:00, so 17:30 is past it; the day's one block ended at 10:00.
  await seedDaySettings(email, { timeZone: ZONE, workStart: 540, workEnd: 1020 });
  await seedTaskAndBlock(email, "Morning draft", `${day}T09:00:00Z`, `${day}T10:00:00Z`);
  await page.clock.install({ time: base });
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });

  await expect(page.locator(".now-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Nothing scheduled")).toBeVisible();

  // The brief is the morning's: the block started at 09:00 and it is past noon.
  await expect(page.locator(".brief")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Morning brief" })).toHaveCount(0);

  // Full screen glances at the running block; nothing is running.
  await expect(page.getByRole("button", { name: "Full screen" })).toHaveCount(0);

  // No free time left in the work window: the action is off and the reason is on screen.
  const plan = page.getByRole("button", { name: "Plan my day" });
  await expect(plan).toBeDisabled();
  await expect(page.getByText("No free time left today")).toBeVisible();
  await expect(plan).toHaveAccessibleDescription("No free time left today");
});

test("an empty account's Today and Tasks cards carry a New task action that opens the create sheet", async ({ page }) => {
  const email = newEmail("today-empty");
  await submitAuthForm(page, email, "sign up");

  const create = page.getByRole("complementary", { name: "New task" });

  const homeCard = page.locator(".empty-state");
  await expect(homeCard).toBeVisible({ timeout: 30_000 });
  await homeCard.getByRole("button", { name: "Add your first task" }).click();
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);

  await nav(page).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  const tasksCard = page.locator(".empty-state");
  await expect(tasksCard).toHaveCount(1);
  await tasksCard.getByRole("button", { name: "Add your first task" }).click();
  await expect(create).toBeVisible();
});

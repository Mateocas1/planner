import { expect, test, type Page } from "@playwright/test";
import { seedShutdownFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Cross-feature invariants (M1).
 *
 * Each feature's own spec pins its own rules; these tests pin the places where
 * two of them meet and a merge can keep both behaviours while still leaving
 * them disagreeing. The sync line counts unacknowledged writes, and undo is a
 * compensating write: undoing a delete has to leave the count describing one
 * pending change, not two. The keyboard and the shutdown ritual are the same
 * kind of place: one global listener reads letters, and the ritual is a sheet
 * it has to stay out of.
 */

test.setTimeout(60_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

async function openTasks(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
}

/** Creates a task through the New task sheet and waits for its row and for the
 * sheet to leave, exactly as the flow suite does. */
async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "New task" })).toHaveCount(0);
}

/** The sync line, scoped past the other polite status regions. */
function syncLine(page: Page) {
  return page.getByRole("status").filter({ has: page.locator(".sync-text") });
}

test("undoing a delete that is still waiting to sync leaves one pending change, not two", async ({ page, context }) => {
  const email = newEmail("integ-undo-sync");
  await signUp(page, email);
  await openTasks(page);
  await addTask(page, "Held task");
  await expect(syncLine(page)).toHaveText("Synced");

  // Offline, so the delete stays queued: the line counts it from the delete's
  // own write, because a removal is never flagged in a snapshot.
  await context.setOffline(true);
  await expect(syncLine(page)).toHaveText("Offline · nothing waiting");
  await page.getByRole("button", { name: "Held task" }).click();
  await page.getByRole("button", { name: "Delete task" }).click();
  await expect(page.locator(".task-title", { hasText: "Held task" })).toHaveCount(0);
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  // Undo restores the document with a write of its own. That write supersedes
  // the delete it compensates for, so the offer still describes one change:
  // counting both would tell the user two things are unsaved when only one
  // document differs from the server.
  await page.locator(".undo-toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".task-title", { hasText: "Held task" })).toBeVisible();
  await expect(syncLine(page)).toHaveText("Offline · 1 change waiting");

  // Both queued writes flush on reconnect and the line returns to Synced.
  await context.setOffline(false);
  await expect(syncLine(page)).toHaveText("Synced", { timeout: 30_000 });
});

/* ---------- the keyboard and the shutdown ritual (F6a x F3c) ---------- */

const ZONE = "UTC";
const DAY_MS = 86_400_000;

/** A wall-clock hour two days out, so the fake day is clear of the account's
 *  creation and of the real midnight the suite could drift across. */
function at(hour: number, minute = 0): Date {
  const base = new Date();
  base.setUTCHours(hour, minute, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

/** The profile zone's day key `offset` days after the fake now. */
function dayKey(base: Date, offset = 0): string {
  return new Date(base.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

/** A block on the fake day, wall-clock `from`-`to` in UTC. */
function blockOn(base: Date, from: string, to: string) {
  const key = dayKey(base);
  return { start: `${key}T${from}:00Z`, end: `${key}T${to}:00Z` };
}

const ritual = (page: Page) => page.getByRole("complementary", { name: "Close the day" });
const banner = (page: Page) => page.locator(".shutdown-banner");
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Signs a seeded account in under the fake clock, and waits for Today. */
async function openAs(page: Page, base: Date, email: string, fixture: Parameters<typeof seedShutdownFixture>[2]) {
  await page.clock.install({ time: base });
  await seedShutdownFixture(email, ZONE, fixture);
  /* A local Auth round trip under a fake clock on a shared host is slow, never
     wrong: the retry is a budget for the emulator. */
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
}

test("the keyboard belongs to the ritual while it is open, and comes back when it closes", async ({ page }) => {
  const base = at(18, 30);
  await openAs(page, base, newEmail("integ-keys-ritual"), {
    tasks: [
      { title: "Write the brief", completed: true, completedAt: `${dayKey(base)}T09:00:00Z` },
      { title: "Review the draft", deadline: dayKey(base) },
    ],
    blocks: [blockOn(base, "09:00", "10:00")],
  });

  // The fine pointer's entry: the banner's own action (criterion 8).
  await expect(banner(page).getByRole("button", { name: "Close day" })).toBeVisible();
  await banner(page).getByRole("button", { name: "Close day" }).click();
  await expect(ritual(page)).toBeVisible();

  /* Every key the engine maps, pressed while the sheet is up: `n` would open
     Now mode, `?` the help sheet, `g t` the Tasks view and `j` the first row.
     The sheet owns the keyboard, so none of them arrives -- and the ritual,
     whose own commit is a page turn, still has every deadline it was opened for. */
  for (const key of ["n", "?", "j", "k", "x", "t", "g", "t"]) await page.keyboard.press(key);
  await expect(page.getByRole("dialog", { name: "Now mode" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(nav(page).getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(ritual(page)).toBeVisible();

  // Closing the sheet gives the keyboard back: the inertness above belongs to
  // the sheet, not to a listener the merge left broken.
  await ritual(page).getByRole("button", { name: "Cancel" }).click();
  await expect(ritual(page)).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("the palette still offers Close the day, and choosing it opens the sheet", async ({ page }) => {
  const email = newEmail("integ-keys-palette");
  await signUp(page, email);

  // The ritual's second entry (F3c): the palette's action opens the sheet.
  // One-shot commands match on their keywords (`close`, `shutdown`, `day`,
  // `ritual`), which is the rule every other action already follows.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search tasks or run a command" }).fill("shutdown");
  const entry = palette.getByRole("option", { name: /Close the day/ });
  await expect(entry).toBeVisible();
  await entry.click();

  await expect(palette).toHaveCount(0);
  await expect(ritual(page)).toBeVisible();
  // A brand-new account has nothing to roll, which is the copy, not an error.
  await expect(ritual(page).getByText("Nothing left over. Close the day.")).toBeVisible();
});

test("the morning brief is a card, not a dialog: the keyboard keeps working over it", async ({ page }) => {
  const base = at(7, 30);
  await openAs(page, base, newEmail("integ-keys-brief"), {
    tasks: [{ title: "Review the draft", deadline: dayKey(base) }],
    blocks: [blockOn(base, "08:00", "10:30"), blockOn(base, "12:00", "13:00")],
  });

  /* Criterion 7's sentence is on screen and it never takes focus, so the keys
     it sits under still work: a brief that silenced `?` would make Home's
     keyboard depend on a dismissal. */
  await expect(page.getByText("Today: 2 blocks, first at 08:00. First free slot 10:30.")).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dismiss morning brief" })).toBeVisible();
});

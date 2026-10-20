import { expect, test, type Page } from "@playwright/test";
import { password, readRemoteTasks, seedTaskAndBlock } from "./browser-helpers.ts";

/**
 * The command palette (F3 / spec S8). Every assertion goes through the UI: the
 * dialog's semantics, the keyboard contract (arrows, Enter, Escape, focus), the
 * two things it does (quick-add a title, open a task's details) and the motion
 * budget a keyboard surface gets.
 */

test.setTimeout(60_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

async function signUp(page: Page, email: string) {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const field = (page: Page) => dialog(page).getByRole("combobox", { name: "Search tasks or run a command" });
const options = (page: Page) => dialog(page).getByRole("listbox", { name: "Results" }).getByRole("option");

test("Cmd/Ctrl+K opens a centered modal dialog whose focus cannot leave, and Escape gives focus back", async ({ page }) => {
  const email = newEmail("palette-dialog");
  await signUp(page, email);

  // the palette is opened from the keyboard, wherever focus happens to be
  const navTasks = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" });
  await navTasks.focus();
  await page.keyboard.press("Control+k");

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");
  // the combobox owns the listbox it points at, and the first row is selected
  await expect(field(page)).toHaveAttribute("aria-controls", "palette-list");
  await expect(page.locator("#palette-list")).toHaveCount(1);
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", "palette-option-navigate-home");

  // centered: the dialog's box is the viewport's center on both axes
  const box = await dialog(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2);

  // glass: a translucent sheet, with its text on the page's primary ink
  const alpha = await dialog(page).evaluate(element => {
    const parts = getComputedStyle(element).backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(",") ?? [];
    return parts.length === 4 ? Number(parts[3]) : 1;
  });
  expect(alpha).toBeGreaterThan(0);
  expect(alpha).toBeLessThan(1);
  const pageInk = await page.evaluate(() => getComputedStyle(document.body).color);
  await expect(field(page)).toHaveCSS("color", pageInk);

  // modal: eight Tabs and one Shift+Tab never move focus out of the dialog
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true);
  // the cycle is the field and its close control: Shift+Tab wraps backwards to
  // it, and Tab from it wraps forward, so focus never lands on the browser chrome
  await expect(dialog(page).getByRole("button", { name: "Close palette" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field(page)).toBeFocused();

  // Escape closes it and returns focus to the element that had it before.
  // The count is read once, with no retry: a closing animation that kept the
  // node mounted would fail here, and that delay is what the rule forbids.
  await page.keyboard.press("Escape");
  expect(await dialog(page).count()).toBe(0);
  await expect(navTasks).toBeFocused();
});

test("quick add: a typed title becomes a task on Enter, and an empty palette never creates one", async ({ page }) => {
  const email = newEmail("palette-add");
  await signUp(page, email);

  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  // with no query there is nothing to create, so Enter can only run a destination
  await expect(page.getByRole("option", { name: /^Create/ })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect.poll(() => readRemoteTasks(email), { timeout: 15_000 }).toEqual([]);

  // the typed title is the quick-add row, selected before anything else
  await page.keyboard.press("Control+k");
  await field(page).fill("Buy milk");
  await expect(page.getByRole("option", { name: "Create “Buy milk”" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  // creating never navigates away from where the user was
  await expect(nav.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks 1 open" }).click();
  await expect(page.locator(".task-title", { hasText: "Buy milk" })).toBeVisible();
  await expect.poll(() => readRemoteTasks(email), { timeout: 15_000 }).toEqual([{ title: "Buy milk", completed: false }]);
});

test("a task found by title opens in its details panel from any view", async ({ page }) => {
  const email = newEmail("palette-open-task");
  await signUp(page, email);
  await seedTaskAndBlock(email, "Pay the rent", "2026-03-02T09:00:00-03:00", "2026-03-02T10:00:00-03:00");
  await seedTaskAndBlock(email, "Water the plants", "2026-03-03T09:00:00-03:00", "2026-03-03T10:00:00-03:00");

  // the palette works from a surface that does not list tasks
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();

  await page.keyboard.press("Control+k");
  await field(page).fill("rent");
  // the quick-add row plus the one matching task, and nothing else: the other
  // task's title has no "rent", so the search really filters by title
  await expect(options(page)).toHaveCount(2);
  await expect(page.getByRole("option", { name: "Water the plants" })).toHaveCount(0);
  const row = page.getByRole("option", { name: "Pay the rent" });
  await expect(row).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("ArrowDown");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", /^palette-option-task-/);
  await page.keyboard.press("Enter");

  // the palette closes, the Tasks surface opens with that task's details
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Task details" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toHaveValue("Pay the rent");

  // opened over an open details sheet, Escape belongs to the palette alone:
  // it closes the palette and leaves the sheet behind it in place
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await dialog(page).count()).toBe(0);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Rename task")).toHaveValue("Pay the rent");
});

test("the palette enters in one 120 ms fade and scale, animates nothing per keystroke, and respects reduced motion", async ({ page }) => {
  const email = newEmail("palette-motion");
  await signUp(page, email);

  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  // one transition, on transform and opacity only, inside the press budget,
  // and no keyframes anywhere: nothing restarts from zero when it reopens
  await expect(dialog(page)).toHaveCSS("transition-property", "opacity, transform");
  await expect(dialog(page)).toHaveCSS("transition-duration", "0.12s, 0.12s");
  await expect(dialog(page)).toHaveCSS("animation-name", "none");
  await expect(dialog(page)).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  // selecting or filtering rows while typing is never animated
  await field(page).fill("water the plants");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(options(page).first()).toHaveCSS("transition-duration", "0s");
  await expect(options(page).first()).toHaveCSS("animation-name", "none");
  await expect(field(page)).toHaveCSS("transition-duration", "0s");

  // the OS preference collapses the entrance to the app's reduce duration
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  // the app's single reduce rule collapses every transition to one 1 ms value
  await expect(dialog(page)).toHaveCSS("transition-duration", "0.001s");
  await expect(dialog(page)).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
});

test("the top bar trigger opens it, arrows wrap, Enter runs a destination, and a backdrop click closes it", async ({ page }) => {
  const email = newEmail("palette-keys");
  await signUp(page, email);

  const trigger = page.getByRole("button", { name: "Command palette" });
  await trigger.click();
  await expect(dialog(page)).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Go to Tasks" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option", { name: "Go to Today" })).toHaveAttribute("aria-selected", "true");
  // moving up from the first row wraps to the last one
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option", { name: "Go to Calendar" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();

  // a query that names a destination filters down to it, and Enter jumps there
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await field(page).fill("tasks");
  await expect(options(page)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Go to Tasks" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  expect(await dialog(page).count()).toBe(0);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

  // with nothing typed, Enter runs the first destination, which is Home
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  // reopening and clicking the backdrop closes it and returns focus to the trigger
  await trigger.click();
  await expect(dialog(page)).toBeVisible();
  await page.mouse.click(4, 4);
  expect(await dialog(page).count()).toBe(0);
  await expect(trigger).toBeFocused();
  // the click never reached the page behind the modal
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

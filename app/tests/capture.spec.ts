import { expect, test, type Page } from "@playwright/test";
import { readRemoteTasks, submitAuthForm } from "./browser-helpers.ts";

/**
 * The capture inbox's entry points (Ronda 8, plan `odd/plans/capture-inbox.md`
 * §1, §5, §7): the palette's "Capture" action, the header button and
 * paste-anywhere open the sheet; reading a paste needs no key (the web build
 * reads on this device, the same path the desktop uses without a key); nothing
 * is written until Add, and Discard writes nothing.
 *
 * The preview build has no dev mock (`?captureMock=` is a vite-dev switch), so
 * these cases exercise the on-device reading; the assistant's states are
 * covered by the unit specs on the mock transport.
 */

test.setTimeout(90_000);
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A UTC day key `offset` days from now; the zone these cases run in. */
function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function signUp(page: Page, email: string) {
  await submitAuthForm(page, email, "sign up");
}

const sheet = (page: Page) => page.getByRole("complementary", { name: "Capture" });
const area = (page: Page) => sheet(page).getByRole("textbox", { name: "Text to read" });
const headerButton = (page: Page) => page.getByRole("button", { name: "Capture", exact: true });
const cards = (page: Page) => sheet(page).locator("li.capture-card");

/** Puts the caret on the page itself, so nothing holds focus. */
async function focusPage(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

/** Pastes through the real clipboard, so the browser fires a genuine paste event. */
async function pasteText(page: Page, text: string) {
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+V");
}

async function openFromPalette(page: Page) {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search tasks or run a command" }).fill("capture");
  await expect(palette.getByRole("option").first()).toHaveText("Capture");
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
}

/** Reads a paste in the sheet and waits for the cards. */
async function readPaste(page: Page, text: string, expectedCards: number) {
  await area(page).fill(text);
  await sheet(page).getByRole("button", { name: "Find tasks" }).click();
  await expect(cards(page)).toHaveCount(expectedCards);
}

async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.sheet")).toHaveCount(0);
}

const remoteTitles = async (email: string) => (await readRemoteTasks(email)).map(task => task.title).sort();

test("the palette's Capture action opens the sheet, empty and ready to paste into", async ({ page }) => {
  await signUp(page, newEmail("capture-palette"));

  await openFromPalette(page);
  await expect(area(page)).toBeFocused();
  await expect(area(page)).toHaveValue("");
  await expect(sheet(page).getByRole("button", { name: "Find tasks" })).toBeDisabled();
});

test("the header button opens the sheet, and Escape closes it and gives focus back", async ({ page }) => {
  await signUp(page, newEmail("capture-focus"));

  await headerButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(area(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("aside.sheet")).toHaveCount(0);
  await expect(headerButton(page)).toBeFocused();
});

test("a paste with nothing focused opens the sheet with the text, and nothing is sent yet", async ({ page }) => {
  const email = newEmail("capture-paste");
  await signUp(page, email);
  await focusPage(page);
  await expect(page.locator("aside.sheet")).toHaveCount(0);

  await pasteText(page, "Send the Q3 budget to Lucía");
  await expect(sheet(page)).toBeVisible();
  await expect(area(page)).toHaveValue("Send the Q3 budget to Lucía");
  // Opening reads nothing: the user presses Find tasks.
  await expect(cards(page)).toHaveCount(0);
  expect(await remoteTitles(email)).toEqual([]);
});

test("a paste into a field stays in the field and opens nothing", async ({ page }) => {
  await signUp(page, newEmail("capture-paste-field"));

  await page.getByRole("button", { name: "New task" }).click();
  const title = page.getByRole("complementary", { name: "New task" }).getByLabel("Title");
  await title.focus();
  await pasteText(page, "Pasted into the title");
  await expect(title).toHaveValue("Pasted into the title");
  await expect(sheet(page)).toHaveCount(0);

  // Same for the palette's own search field.
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.sheet")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
  await pasteText(page, "from the clipboard");
  await expect(search).toHaveValue("from the clipboard");
  await expect(sheet(page)).toHaveCount(0);
});

test("a paste while a sheet is open is left to that sheet", async ({ page }) => {
  await signUp(page, newEmail("capture-paste-sheet"));

  await page.getByRole("button", { name: "New task" }).click();
  const create = page.getByRole("complementary", { name: "New task" });
  await expect(create).toBeVisible();
  // Focus on the sheet's chrome, not on a field: still not a page paste.
  await create.getByRole("button", { name: "Cancel" }).focus();
  await pasteText(page, "Should not capture");
  await expect(sheet(page)).toHaveCount(0);
  await expect(create).toBeVisible();
});

test("without a key the text is read on this device; Add writes the task, Discard writes nothing", async ({ page }) => {
  const email = newEmail("capture-add");
  await signUp(page, email);
  await openFromPalette(page);

  // The web build says who reads the text, once, before anything is sent.
  await expect(sheet(page).getByText("The assistant lives in the desktop app. Here the text is read on this device.")).toBeVisible();

  await readPaste(page, "- Send the Q3 budget to Lucía tomorrow 45 min\n- Renew the passport", 2);
  await expect(sheet(page).locator(".capture-provenance")).toHaveText(" · Read on this device");
  const budget = cards(page).filter({ hasText: "Send the Q3 budget to Lucía" });
  const passport = cards(page).filter({ hasText: "Renew the passport" });
  await expect(budget).toBeVisible();
  await expect(budget).toContainText("45 min");
  // Reading is not writing: two cards on screen, nothing stored.
  expect(await remoteTitles(email)).toEqual([]);

  await passport.getByRole("button", { name: "Discard" }).click();
  await expect(cards(page)).toHaveCount(1);
  await budget.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet(page).getByText("1 task added")).toBeVisible();

  await expect
    .poll(async () => (await readRemoteTasks(email)).map(task => ({ title: task.title, deadline: task.deadline, estimate: task.estimate })), poll)
    .toEqual([{ title: "Send the Q3 budget to Lucía", deadline: utcDay(1), estimate: 45 }]);

  await sheet(page).getByRole("button", { name: "Done" }).click();
  await expect(page.locator("aside.sheet")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator(".task-title", { hasText: "Send the Q3 budget to Lucía" })).toBeVisible();
  // The discarded card never reached the list or the server.
  await expect(page.getByText("Renew the passport")).toHaveCount(0);
  expect(await remoteTitles(email)).toEqual(["Send the Q3 budget to Lucía"]);
});

test("Add all writes every open card at once, and only then", async ({ page }) => {
  const email = newEmail("capture-addall");
  await signUp(page, email);
  await openFromPalette(page);

  await readPaste(page, "- Call the dentist\n- Water the plants\n- Renew the passport", 3);
  expect(await remoteTitles(email)).toEqual([]);

  await sheet(page).getByRole("button", { name: "Add all (3)" }).click();
  await expect(sheet(page).getByText("3 tasks added")).toBeVisible();
  await expect.poll(() => remoteTitles(email), poll).toEqual(["Call the dentist", "Renew the passport", "Water the plants"]);
});

test("closing the sheet with cards still open creates nothing", async ({ page }) => {
  const email = newEmail("capture-noauto");
  await signUp(page, email);
  await openFromPalette(page);

  await readPaste(page, "- Call the dentist\n- Water the plants", 2);
  await closeSheet(page);
  // Give a stray write time to land before asserting its absence.
  await page.waitForTimeout(1_500);
  expect(await remoteTitles(email)).toEqual([]);
});

test.describe("a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test("the sheet and its cards never scroll sideways at 390 px", async ({ page }) => {
    await signUp(page, newEmail("capture-phone"));
    await headerButton(page).click();
    await expect(sheet(page)).toBeVisible();

    await readPaste(
      page,
      "- Reply to the very long thread about the quarterly budget review with finance tomorrow 90 min\n- Call the dentist",
      2,
    );
    await expect(headerButton(page)).toBeVisible();
    const overflow = await page.evaluate(() => {
      const sheetBox = document.querySelector("aside.sheet")!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sheet: sheetBox.scrollWidth - sheetBox.clientWidth,
        box: sheetBox.getBoundingClientRect().width,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.sheet).toBeLessThanOrEqual(0);
    expect(overflow.box).toBeLessThanOrEqual(390);
  });
});

test.describe("in Spanish", () => {
  test("the palette action, the sheet and the cards read in neutral Spanish", async ({ page }) => {
    const email = newEmail("capture-es");
    await signUp(page, email);
    await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Paleta de comandos" });
    await palette.getByRole("combobox").fill("capturar");
    await expect(palette.getByRole("option").first()).toHaveText("Capturar");
    await page.keyboard.press("Enter");

    const es = page.getByRole("complementary", { name: "Capturar" });
    await expect(es).toBeVisible();
    await expect(es.getByText("El asistente está en la app de escritorio.")).toBeVisible();
    await es.getByRole("textbox").fill("- Llamar al dentista mañana 30 min");
    await es.getByRole("button", { name: "Buscar tareas" }).click();
    const card = es.locator("li.capture-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Llamar al dentista");
    await expect(es.getByText("1 tarea encontrada")).toBeVisible();
    await expect(card.getByRole("button", { name: "Descartar" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Añadir", exact: true })).toBeVisible();
  });
});

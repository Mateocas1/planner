import { expect, test, type Page } from "@playwright/test";
import { submitAuthForm } from "./browser-helpers.ts";

/**
 * Theme toggle (value roadmap §4): System, Light and Dark, persisted per device
 * in `localStorage["planner-theme"]`.
 *
 * Every assertion goes through the app the user sees: the resolved `data-theme`
 * on <html>, the colours actually painted (body background and the `--surface`
 * token a card sits on), `color-scheme` (which colours form controls and
 * scrollbars), the `theme-color` meta, the radiogroup's keyboard contract, and
 * the palette command. The no-flash test holds the app bundle in flight and
 * proves the inline script already resolved the theme before a single line of
 * application JavaScript ran.
 */

test.setTimeout(90_000);

const key = "planner-theme";

/** The two resolved schemes, as the browser reports them. */
const schemes = {
  light: {
    attribute: "light",
    /* --bg = ink-200 #EEF1F8 */
    body: "rgb(238, 241, 248)",
    /* --surface = ink-50 #FAFCFF */
    surface: "#fafcff",
    /* the light page colour, from ui/brand.css ink-200 */
    themeColor: "#EEF1F8",
  },
  dark: {
    attribute: "dark",
    /* --bg = ink-975 #0B0E15 */
    body: "rgb(11, 14, 21)",
    /* --surface = ink-925 #1B1E26 */
    surface: "#1b1e26",
    /* the dark page colour, from ui/brand.css ink-975 */
    themeColor: "#0B0E15",
  },
} as const;

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** Everything about the painted theme that a user could see. */
async function themeState(page: Page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const root = getComputedStyle(html);
    return {
      attribute: html.dataset.theme ?? null,
      body: getComputedStyle(document.body).backgroundColor,
      surface: root.getPropertyValue("--surface").trim(),
      label: root.getPropertyValue("--label").trim(),
      colorScheme: root.colorScheme,
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
      stored: window.localStorage.getItem("planner-theme"),
    };
  });
}

/** Waits for the resolved attribute, then checks the painted tokens agree. */
async function expectScheme(page: Page, want: (typeof schemes)[keyof typeof schemes], why: string) {
  await expect.poll(async () => (await themeState(page)).attribute, { message: why }).toBe(want.attribute);
  const state = await themeState(page);
  expect(state.body, why).toBe(want.body);
  expect(state.surface.toLowerCase(), why).toBe(want.surface);
  /* --label follows the same switch, so text is not left at the old scheme */
  expect(state.label.length, why).toBeGreaterThan(0);
  expect(state.colorScheme, why).toBe(want.attribute);
  expect(state.themeColor, why).toBe(want.themeColor);
}

const themeGroup = (page: Page) => page.getByRole("radiogroup", { name: "Theme" });
const themeRadio = (page: Page, name: "System" | "Light" | "Dark") =>
  page.getByRole("radio", { name, exact: true });

async function signUp(page: Page, email: string, { phone = false } = {}) {
  await submitAuthForm(page, email, "sign up");
  /* on a phone the control waits behind the account button */
  if (!phone) await expect(themeGroup(page).first()).toBeVisible();
}

test("Dark on a light OS: the page paints the dark tokens, not the OS scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, newEmail("theme-dark"));

  await themeRadio(page, "Dark").click();

  await expectScheme(page, schemes.dark, "Dark over an OS in light mode");
  await expect(themeRadio(page, "Dark")).toHaveAttribute("aria-checked", "true");
  await expect(themeRadio(page, "System")).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await themeState(page)).stored).toBe("dark");
});

test("Light on a dark OS: an explicit choice beats the OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signUp(page, newEmail("theme-light"));

  await themeRadio(page, "Light").click();

  await expectScheme(page, schemes.light, "Light over an OS in dark mode");
  await expect(themeRadio(page, "Light")).toHaveAttribute("aria-checked", "true");
});

test("System is the default and follows the OS live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, newEmail("theme-system"));

  /* nothing stored: the default is System, and it follows the OS */
  expect((await themeState(page)).stored).toBeNull();
  await expect(themeRadio(page, "System")).toHaveAttribute("aria-checked", "true");
  await expectScheme(page, schemes.light, "System on a light OS");

  await page.emulateMedia({ colorScheme: "dark" });
  await expectScheme(page, schemes.dark, "System following the OS into dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expectScheme(page, schemes.light, "System following the OS back into light");
});

test("the choice survives a reload and the first paint is already right", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, newEmail("theme-persist"));

  await themeRadio(page, "Dark").click();
  await expectScheme(page, schemes.dark, "before the reload");

  await page.reload();
  /* The inline script resolves the stored value before the bundle runs, so the
     attribute is already dark when the shell paints -- not after a React effect. */
  await expectScheme(page, schemes.dark, "right after the reload");
  await expect(themeRadio(page, "Dark")).toHaveAttribute("aria-checked", "true");
  expect((await themeState(page)).stored).toBe("dark");
});

test("no flash: the inline script sets the theme before the app bundle executes", async ({ page }) => {
  /* Hold every built module bundle in flight. The document parses, the inline
     <head> script runs, and nothing else has executed yet. */
  await page.route(/\/assets\/.*\.js$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 5000));
    await route.continue();
  });
  await page.addInitScript(theme => window.localStorage.setItem("planner-theme", theme), "dark");

  await page.goto("/", { waitUntil: "commit" });
  /* The theme is resolved while the app's own JavaScript is still waiting. */
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe("dark");
  const first = await themeState(page);
  expect(first.themeColor).toBe(schemes.dark.themeColor);
  /* The stylesheet loads on its own schedule; once it lands the page is painted
     dark, still without a line of application JavaScript. */
  await expect.poll(async () => (await themeState(page)).body).toBe(schemes.dark.body);
  /* ...and the app has not rendered a single element yet. */
  expect(await page.locator("#root > *").count()).toBe(0);

  /* The bundle arrives and paints the same scheme: no second switch. */
  await expect(page.getByLabel("Email")).toBeVisible({ timeout: 20_000 });
  await expectScheme(page, schemes.dark, "after the held bundle finally runs");
});

test("the control is a radiogroup with arrow-key selection", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, newEmail("theme-keys"));

  const group = themeGroup(page).first();
  await expect(group).toHaveAttribute("role", "radiogroup");
  /* one tab stop for the group: the checked radio is the one in the tab order */
  await expect(themeRadio(page, "System")).toHaveAttribute("tabindex", "0");
  await expect(themeRadio(page, "Dark")).toHaveAttribute("tabindex", "-1");

  await themeRadio(page, "System").focus();
  await page.keyboard.press("ArrowRight");
  await expect(themeRadio(page, "Light")).toBeFocused();
  await expect(themeRadio(page, "Light")).toHaveAttribute("aria-checked", "true");
  await expectScheme(page, schemes.light, "ArrowRight selected Light");

  await page.keyboard.press("ArrowRight");
  await expect(themeRadio(page, "Dark")).toBeFocused();
  await expectScheme(page, schemes.dark, "ArrowRight selected Dark");

  /* ArrowLeft walks back, and the group wraps like a native radiogroup */
  await page.keyboard.press("ArrowLeft");
  await expect(themeRadio(page, "Light")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(themeRadio(page, "System")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(themeRadio(page, "Dark")).toHaveAttribute("aria-checked", "true");
});

test("the palette runs the theme commands", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, newEmail("theme-palette"));

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("theme");

  const options = dialog.getByRole("listbox", { name: "Results" }).getByRole("option");
  await expect(options.filter({ hasText: "Theme: Dark" })).toBeVisible();
  await expect(options.filter({ hasText: "Theme: Light" })).toBeVisible();
  await expect(options.filter({ hasText: "Theme: System" })).toBeVisible();

  await options.filter({ hasText: "Theme: Dark" }).click();
  await expectScheme(page, schemes.dark, "the palette's Theme: Dark");
  await expect(dialog).toBeHidden();
  /* no task is created by a theme command */
  await expect(page.getByText("Create “")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("the theme control is reachable in the account menu", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await signUp(page, newEmail("theme-phone"), { phone: true });

    /* no sidebar at this width: the account menu carries the control */
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: "Account" }).click();

    const group = themeGroup(page);
    await expect(group).toBeVisible();
    await group.scrollIntoViewIfNeeded();
    await themeRadio(page, "Dark").click();

    await expectScheme(page, schemes.dark, "Dark chosen on a phone");
  });
});

import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { seedSidebarFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * The desktop window from its minimum width (800 px) up, with
 * the sidebar always open. A Hyprland half-screen tile is 960 px wide; there
 * the Settings > AI rows squeezed their label column to a few pixels and the
 * Base URL note wrapped one letter per line.
 *
 * `LAYOUT_SWEEP=1` runs the full sweep (every main screen x 800/960/1100/1280,
 * EN and ES, light and dark) and prints every collapsed, clipped or off-screen
 * text it finds; the default run keeps the regression assertions only.
 */

test.setTimeout(240_000);

const ZONE = "UTC";
const WIDTHS = [800, 960, 1100, 1280] as const;
const HEIGHT = 900;
const shotDir = process.env.LAYOUT_SHOTS ?? "";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** The Tauri bridge stub the desktop-only tabs need (the AI and Desktop tabs
 * render only inside the shell): each command answers with the shape its
 * caller reads, the key status reports no key, and event listeners are no-ops. */
async function stubDesktop(page: Page) {
  await page.addInitScript(() => {
    const replies: Record<string, unknown> = {
      chat_key_status: { hasKey: false, baseUrl: null },
      chat_memories_list: [],
      engram_settings_get: { enabled: false, address: "127.0.0.1:7437", project: "planner" },
      engram_status: null,
      quickadd_get_config: { shortcut: "Ctrl+Alt+Space", registered: true, error: null },
      desktop_launched_at_sign_in: false,
      idle_seconds: 0,
      "plugin:event|listen": 1,
      "plugin:autostart|is_enabled": false,
    };
    const scope = window as unknown as Record<string, unknown>;
    scope.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => (command in replies ? replies[command] : null),
      transformCallback: () => 0,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
    scope.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
}

async function enter(page: Page, prefix: string, options: { lang?: "en" | "es"; theme?: "light" | "dark" } = {}) {
  const { lang = "en", theme = "light" } = options;
  await page.addInitScript(mode => window.localStorage.setItem("planner-theme", mode), theme);
  await stubDesktop(page);
  page.on("pageerror", error => console.log(`pageerror: ${error.message}`));
  const email = newEmail(prefix);
  const now = Date.now();
  const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = new Date(now).toISOString().slice(0, 10);
  await seedSidebarFixture(email, ZONE, {
    tasks: [
      { title: "Prepare the quarterly planning review with the whole design team", deadline: today },
      { title: "Renovar el seguro del departamento antes de fin de mes", deadline: today },
      { title: "Short" },
    ],
    blocks: [
      { start: iso(-30), end: iso(60), task: "Prepare the quarterly planning review with the whole design team" },
      { start: iso(120), end: iso(180) },
    ],
  });
  await submitAuthForm(page, email, "sign in");
  if (lang === "es") {
    // The sign-in helper reads the English form, so the device language
    // switches once the shell is up.
    await page.evaluate(() => window.localStorage.setItem("planner-language", "es"));
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible({ timeout: 30_000 });
  }
  return email;
}

async function settle(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every(
      animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity,
    ),
  );
}

type Issue = { kind: string; text: string; width: number; lines?: number; where: string };

/** Every visible text that is letter-wrapped, clipped without an ellipsis or
 * pushed out of the window, plus a page that scrolls sideways. */
function findLayoutIssues(page: Page): Promise<Issue[]> {
  return page.evaluate(() => {
    const issues: Issue[] = [];
    const viewport = window.innerWidth;
    const where = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && parts.length < 3; node = node.parentElement) {
        const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
        parts.unshift(cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase());
      }
      return parts.join(" > ");
    };
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length < 4) continue;
      const element = node.parentElement;
      if (!element || seen.has(element)) continue;
      seen.add(element);
      if (element.closest('[aria-hidden="true"], .sr-only, [hidden], [inert]')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const textBox = range.getBoundingClientRect();
      const fontSize = parseFloat(style.fontSize);
      const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.3;
      const lines = Math.round(textBox.height / lineHeight);
      const words = text.split(" ").length;
      // A text cut into more lines than it has words is breaking inside them.
      if (lines > words + 1 || (lines > 2 && box.width < fontSize * 5)) {
        issues.push({ kind: "collapsed", text: text.slice(0, 60), width: Math.round(box.width), lines, where: where(element) });
      }
      // What the reader sees of the text: clipped by every scrolling or
      // clipping ancestor (an ellipsis or a scroll strip is not an overflow).
      let right = textBox.right;
      let left = textBox.left;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowX === "visible") continue;
        const clip = node.getBoundingClientRect();
        right = Math.min(right, clip.right);
        left = Math.max(left, clip.left);
      }
      if (right > viewport + 1 || left < -1) {
        issues.push({ kind: "offscreen", text: text.slice(0, 60), width: Math.round(box.width), where: where(element) });
      }
      if (element.scrollWidth > element.clientWidth + 1 && style.overflowX !== "visible" && style.textOverflow !== "ellipsis") {
        issues.push({ kind: "clipped", text: text.slice(0, 60), width: Math.round(box.width), where: where(element) });
      }
    }
    if (document.documentElement.scrollWidth > viewport + 1) {
      issues.push({ kind: "page-hscroll", text: "", width: document.documentElement.scrollWidth, where: "html" });
    }
    return issues;
  });
}

/** The width of the AI tab's Base URL note and whether it sits above the field. */
function baseUrlRow(page: Page) {
  return page.evaluate(() => {
    const input = document.getElementById("ai-base-url")!;
    const row = input.closest(".settings-row")!;
    const desc = row.querySelector(".settings-row-desc")!.getBoundingClientRect();
    const field = input.getBoundingClientRect();
    return { descWidth: desc.width, stacked: desc.bottom <= field.top + 1, fieldWidth: field.width };
  });
}

const nav = (page: Page, name: string) =>
  page.getByRole("complementary").getByRole("button", { name, exact: true });

test("Settings > AI keeps the Base URL note readable at 960 px with the sidebar open", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 1054 });
  await enter(page, "layout-ai");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI" }).click();
  await expect(page.locator("#ai-base-url")).toBeVisible();
  await settle(page);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    const row = await baseUrlRow(page);
    expect(row.descWidth >= 200 || row.stacked, `Base URL note at ${width}px: ${JSON.stringify(row)}`).toBe(true);
    expect(row.fieldWidth, `Base URL field at ${width}px`).toBeGreaterThanOrEqual(200);
    const collapsed = (await findLayoutIssues(page)).filter(issue => issue.kind !== "clipped");
    expect(collapsed, `Settings > AI at ${width}px`).toEqual([]);
  }
});

test("every Settings tab and the block sheet keep their labels readable at 800 and 960 px, in Spanish", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: HEIGHT });
  await enter(page, "layout-es", { lang: "es" });
  await page.keyboard.press("Control+,");
  const tabs = page.locator(".settings-nav-item");
  await expect(tabs).toHaveCount(5);
  for (let index = 0; index < 5; index++) {
    await tabs.nth(index).click();
    await settle(page);
    for (const width of [800, 960]) {
      await page.setViewportSize({ width, height: HEIGHT });
      expect(await findLayoutIssues(page), `Settings tab ${index} at ${width}px`).toEqual([]);
    }
  }
  // Below 760 px of content the rail is a row above the pane, which gets the
  // column's full width.
  await page.setViewportSize({ width: 960, height: HEIGHT });
  const pane = await page.locator(".settings-pane").boundingBox();
  const rail = await page.locator(".settings-rail").boundingBox();
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(pane!.y);
  expect(pane!.width).toBeGreaterThanOrEqual(560);

  // The block sheet's "Para la tarea" beside a long task title stays one line.
  await page.keyboard.press("Escape");
  await page.locator(".sidebar .nav-item").nth(2).click();
  await page.locator(".calendar-block").first().click();
  const term = page.locator(".block-sheet dt").filter({ hasText: "Para la tarea" });
  await expect(term).toBeVisible();
  await settle(page);
  // Layout size, not the painted box: the sheet may still be scaling in.
  const lines = await term.evaluate(element => {
    const style = getComputedStyle(element);
    return Math.round((element as HTMLElement).offsetHeight / parseFloat(style.lineHeight));
  });
  expect(lines).toBe(1);
});

test("the weekly review keeps its four steps on one line at 800 px", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: HEIGHT });
  await enter(page, "layout-weekly", { lang: "es" });
  await page.locator(".sidebar .nav-item").nth(3).click();
  const steps = page.locator(".weekly-rail-item");
  await expect(steps).toHaveCount(4);
  const tops = await steps.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(await findLayoutIssues(page)).toEqual([]);
});

/* ---------- the full sweep (LAYOUT_SWEEP=1) ---------- */

type Screen = { name: string; open: (page: Page) => Promise<void>; close?: (page: Page) => Promise<void> };

const sideNav = (page: Page, index: number) => page.locator(".sidebar .nav-item").nth(index);

async function openSettingsTab(page: Page, index: number) {
  if (!(await page.locator(".settings").isVisible())) await page.keyboard.press("Control+,");
  await page.locator(".settings-nav-item").nth(index).click();
}

async function escape(page: Page) {
  await page.keyboard.press("Escape");
  await settle(page);
}

const screens: Screen[] = [
  { name: "today", open: page => sideNav(page, 0).click() },
  { name: "tasks", open: page => sideNav(page, 1).click() },
  {
    name: "task-sheet",
    open: async page => {
      await sideNav(page, 1).click();
      await page.locator(".task-open").first().click();
    },
    close: escape,
  },
  { name: "calendar", open: page => sideNav(page, 2).click() },
  {
    name: "block-sheet",
    open: async page => {
      await sideNav(page, 2).click();
      await page.locator(".calendar-block").first().click();
    },
    close: escape,
  },
  {
    name: "new-task-sheet",
    open: async page => {
      await sideNav(page, 0).click();
      await page.getByRole("button", { name: /^(New task|Nueva tarea)$/ }).first().click();
    },
    close: escape,
  },
  { name: "weekly", open: page => sideNav(page, 3).click(), close: escape },
  ...[0, 1, 2, 3, 4].map((index): Screen => ({ name: `settings-${index}`, open: page => openSettingsTab(page, index) })),
  {
    name: "palette",
    open: async page => {
      await sideNav(page, 0).click();
      await page.keyboard.press("Control+k");
    },
    close: escape,
  },
  {
    name: "chat",
    open: async page => {
      await sideNav(page, 0).click();
      await page.keyboard.press("Control+j");
    },
    close: escape,
  },
];

for (const [lang, theme] of [["en", "light"], ["es", "light"], ["es", "dark"]] as const) {
  test(`sweep ${lang} ${theme}`, async ({ page }) => {
    test.skip(!process.env.LAYOUT_SWEEP, "set LAYOUT_SWEEP=1 for the full sweep");
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1280, height: HEIGHT });
    await enter(page, `layout-sweep-${lang}`, { lang, theme });
    const report: string[] = [];
    for (const screen of screens) {
      await screen.open(page);
      await page.waitForTimeout(400);
      await settle(page);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: HEIGHT });
        await page.waitForTimeout(150);
        if (shotDir) {
          mkdirSync(shotDir, { recursive: true });
          await page.screenshot({ path: `${shotDir}/${lang}-${theme}-${screen.name}-${width}.png` });
        }
        for (const issue of await findLayoutIssues(page)) {
          report.push(`${lang}/${theme} ${screen.name} @${width}: ${issue.kind} w=${issue.width}${issue.lines ? ` lines=${issue.lines}` : ""} "${issue.text}" (${issue.where})`);
        }
      }
      await page.setViewportSize({ width: 1280, height: HEIGHT });
      if (screen.close) await screen.close(page);
    }
    console.log(`\n=== sweep ${lang} ${theme}: ${report.length} issues\n${report.join("\n")}`);
  });
}

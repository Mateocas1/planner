import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * The chat panel's mock-mode browser spec (task C2). Runs against a Vite dev
 * server spawned here, because the mock panel only mounts with
 * `import.meta.env.DEV` + `?chatMock` — a production preview build (the
 * config's own webServer) must never render it. No emulators are touched: the
 * panel mounts outside the auth gate, so no account is needed.
 */

const PORT = 4199;
const base = `http://127.0.0.1:${PORT}`;
const shots = new URL("../../odd/runs/chat-c2-shots/", import.meta.url).pathname;

let server: ChildProcess | null = null;

test.beforeAll(async () => {
  await mkdir(shots, { recursive: true });
  server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("chat-panel spec: the dev server did not become ready in 60 s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
});

const launcher = (page: Page) => page.getByRole("button", { name: "Chat" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Chat" });
const field = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
const liveAnswer = (page: Page) => panel(page).locator(".chat-answer[data-live]");
const sendButton = (page: Page) => panel(page).getByRole("button", { name: "Send" });
const stopButton = (page: Page) => panel(page).getByRole("button", { name: "Stop" });

/**
 * Wait for running animations to finish before a screenshot (review item 2:
 * the waiting shot used to catch the user bubble at animation start).
 * Infinite animations — the spinner's rotation and its reduced-motion pulse —
 * are excluded, or the wait would never resolve while a spinner is on screen.
 * (Deviation from the task's literal snippet, which hangs on the spinner.)
 */
async function settleAnimations(page: Page) {
  await page.waitForFunction(
    () => document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
  );
}

async function openPanel(page: Page, query = "?chatMock=1") {
  await page.goto(`${base}/${query}`);
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
}

const answerLength = async (page: Page) => (await liveAnswer(page).textContent())?.length ?? 0;

test("Ctrl+J opens the panel with the composer focused; Escape closes it; Ctrl+J reopens", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Signed-out web (no chatMock): neither the launcher nor the panel exists
  // (review #2; the desktop signed-out case is pinned by config.test.ts, which
  // this dev harness cannot emulate).
  await page.goto(`${base}/`);
  await expect(launcher(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await page.goto(`${base}/?chatMock=1`);
  // The panel never renders without the toggle.
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
  // The shortcut is registered in the help sheet too; the second goto reloads
  // the page, so wait for the app to be interactive before pressing.
  await page.goto(`${base}/?chatMock=1`);
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  // Focus returns to the launcher on close.
  await expect(launcher(page)).toBeFocused();
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  // Reopening during the 120 ms exit cancels it cleanly (review #3): back-to-
  // back keys may land inside the exit or after it — either way the panel
  // must end open, focused and usable.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toBeEditable();
});

test("send: user pill, waiting spinner, streamed text grows to a markdown answer", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  // Empty state copy (S2).
  await expect(panel(page).getByText("What do you need?")).toBeVisible();
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}empty-light.png` });
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  // The field clears and the user pill enters.
  await expect(field(page)).toHaveValue("");
  await expect(panel(page).getByText("What is left of my day?")).toBeVisible();
  // Waiting: the spinner bubble while the mock reasons (~1.2 s).
  await expect(panel(page).locator(".chat-waiting:not(.is-done)")).toBeVisible();
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}waiting-light.png` });
  // Streaming: the answer text grows in at least two observed steps.
  await expect(liveAnswer(page)).toBeVisible();
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(0);
  // Midstream (review #1): bold appears formatted, never as raw markers.
  // settleAnimations cannot be used here — the pacer starts a new reveal span
  // every frame, so finite animations run for the whole stream.
  await expect(liveAnswer(page).locator("strong")).toBeVisible({ timeout: 15_000 });
  const midstreamText = await liveAnswer(page).textContent();
  expect(midstreamText).not.toContain("**");
  const mid = await answerLength(page);
  await page.screenshot({ path: `${shots}midstream-light.png` });
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(mid);
  // Done: the stop button hands back to send, the completed answer renders.
  await expect(stopButton(page)).toBeHidden({ timeout: 20_000 });
  await expect(sendButton(page)).toBeVisible();
  await expect(panel(page).locator(".chat-answer-body code")).toHaveCount(1, { timeout: 15_000 });
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}done-light.png` });
});

test("stop cancels the stream and the send button returns", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  await field(page).fill("Long story please");
  await field(page).press("Enter");
  await expect(stopButton(page)).toBeVisible();
  await stopButton(page).click();
  await expect(stopButton(page)).toBeHidden();
  await expect(sendButton(page)).toBeVisible();
});

test("?chatMock=error shows the inline error and Retry starts a new request", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page, "?chatMock=error");
  await field(page).fill("hello");
  await field(page).press("Enter");
  const alert = panel(page).getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("could not reach the model service");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toBeHidden();
  await expect(panel(page).locator(".chat-waiting:not(.is-done)")).toBeVisible();
});

test("dark theme: the same flow renders on the dark glass", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem("planner-theme", "dark"));
  await openPanel(page);
  await expect(panel(page).getByText("What do you need?")).toBeVisible();
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}empty-dark.png` });
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  await expect(panel(page).locator(".chat-waiting:not(.is-done)")).toBeVisible();
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}waiting-dark.png` });
  await expect(liveAnswer(page).locator("strong")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${shots}midstream-dark.png` });
  await expect(stopButton(page)).toBeHidden({ timeout: 25_000 });
  await settleAnimations(page);
  await page.screenshot({ path: `${shots}done-dark.png` });
});

test("reduced motion: the panel and the stream still work without movement", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPanel(page);
  // The panel's entrance is opacity-only: transform stays at none.
  const panelTransform = await panel(page).evaluate(element => getComputedStyle(element).transform);
  expect(panelTransform === "none" || panelTransform === "").toBe(true);
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  await expect(liveAnswer(page)).toBeVisible();
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(stopButton(page)).toBeHidden({ timeout: 25_000 });
});

test("the chat chord is rebindable: the stored binding opens the panel and the default no longer does (C3b, S2)", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Seed the registry's storage with a chat binding — exactly the shape
  // Settings → Shortcuts writes (task W1's recorder) — before the app boots.
  await page.addInitScript(() => {
    window.localStorage.setItem("planner.shortcuts.bindings", JSON.stringify({ chat: "ctrl+Shift+KeyJ" }));
  });
  await page.goto(`${base}/?chatMock=1`);
  await expect(launcher(page)).toBeVisible();
  // The launcher announces the current chord, not a hardcoded default.
  await expect(launcher(page)).toHaveAttribute("aria-keyshortcuts", "Control+Shift+J");
  // The default chord no longer opens the panel.
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toBeHidden();
  // The rebinded chord does, with the composer focused.
  await page.keyboard.press("Control+Shift+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  // A rebind takes effect live, without a reload: update the storage and fire
  // the registry's change event the way a Settings save does, then check that
  // the previous chord is dead and the new one works.
  await page.evaluate(() => {
    window.localStorage.setItem("planner.shortcuts.bindings", JSON.stringify({ chat: "ctrl+Alt+KeyK" }));
    window.dispatchEvent(new Event("planner:shortcut-binding-changed"));
  });
  await page.keyboard.press("Control+Shift+j");
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Control+Alt+k");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
});

test("memory extraction: canned ops from the mock ride into the next conversation's prompt (S5)", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  // First conversation: one full exchange.
  await field(page).fill("Remember I plan my week on Sundays");
  await field(page).press("Enter");
  await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
  // "New chat" ends the conversation: extraction calls the mock's `complete`,
  // which replies with canned upsert ops the in-memory backend applies.
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(panel(page).getByText("What do you need?")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const mock = (window as { __chatMockTransport?: { __lastCompleteRequest?: unknown } }).__chatMockTransport;
        return mock?.__lastCompleteRequest != null;
      }),
    )
    .toBe(true); // extraction recorded its complete request
  // Second conversation: the system prompt carries the extracted note.
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const mock = (window as { __chatMockTransport?: { __lastStreamRequest?: { messages?: Array<{ role?: string; content?: string }> } } }).__chatMockTransport;
        const system = mock?.__lastStreamRequest?.messages?.find(message => message.role === "system")?.content ?? "";
        return system.includes("Prefers short answers") && system.includes("planning-style");
      }),
    )
    .toBe(true); // the second conversation's system prompt includes the memory
});

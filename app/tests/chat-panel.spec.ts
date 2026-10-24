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

async function openPanel(page: Page, query = "?chatMock=1") {
  await page.goto(`${base}/${query}`);
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
}

const answerLength = async (page: Page) => (await liveAnswer(page).textContent())?.length ?? 0;

test("Ctrl+J opens the panel with the composer focused; Escape closes it; Ctrl+J reopens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
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
});

test("send: user pill, waiting spinner, streamed text grows to a markdown answer", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  // Empty state copy (S2).
  await expect(panel(page).getByText("What do you need?")).toBeVisible();
  await page.screenshot({ path: `${shots}empty-light.png` });
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  // The field clears and the user pill enters.
  await expect(field(page)).toHaveValue("");
  await expect(panel(page).getByText("What is left of my day?")).toBeVisible();
  // Waiting: the spinner bubble while the mock reasons (~1.2 s).
  await expect(panel(page).locator(".chat-waiting:not(.is-done)")).toBeVisible();
  await page.screenshot({ path: `${shots}waiting-light.png` });
  // Streaming: the answer text grows in at least two observed steps.
  await expect(liveAnswer(page)).toBeVisible();
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(0);
  const mid = await answerLength(page);
  await page.screenshot({ path: `${shots}midstream-light.png` });
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(mid);
  // Done: the stop button hands back to send, the completed answer renders.
  await expect(stopButton(page)).toBeHidden({ timeout: 20_000 });
  await expect(sendButton(page)).toBeVisible();
  await expect(panel(page).locator(".chat-answer-body code")).toHaveCount(1, { timeout: 15_000 });
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
  await page.screenshot({ path: `${shots}empty-dark.png` });
  await field(page).fill("What is left of my day?");
  await field(page).press("Enter");
  await expect(panel(page).locator(".chat-waiting:not(.is-done)")).toBeVisible();
  await page.screenshot({ path: `${shots}waiting-dark.png` });
  await expect(stopButton(page)).toBeHidden({ timeout: 25_000 });
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

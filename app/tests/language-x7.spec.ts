import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * S8 (unit x7): the chat panel in Spanish. Like chat-panel.spec.ts it
 * runs against its own Vite dev server (the mock panel only mounts in dev with
 * `?chatMock`) and needs no account: the device override is seeded into
 * localStorage before the app starts.
 */

const PORT = Number(process.env.CHAT_X7_PORT ?? 4398);
const base = `http://127.0.0.1:${PORT}`;
const shots = new URL("../test-results/shots/r5-x7-shots/", import.meta.url).pathname;

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
      if ((await fetch(base)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("language-x7 spec: the dev server did not become ready in 60 s");
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

async function openSpanishPanel(page: Page, query: string) {
  await page.addInitScript(() => window.localStorage.setItem("planner-language", "es"));
  await page.goto(`${base}/${query}`);
  // The launcher mounts with the panel's key handler: a chord pressed before it
  // reaches no listener (as in chat-panel.spec.ts).
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("dialog", { name: "Chat" });
  await expect(panel).toHaveAttribute("data-open", "true");
  return panel;
}

for (const [name, size] of [
  ["1440x900", { width: 1440, height: 900 }],
  ["390x844", { width: 390, height: 844 }],
] as const) {
  test(`the chat panel reads in Spanish, cards included (${name})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(size);
    const panel = await openSpanishPanel(page, "?chatMock=tools");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(panel.getByRole("heading", { name: "¿Qué necesitas?" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Nuevo chat" })).toBeVisible();
    const field = panel.getByRole("textbox", { name: "Mensaje" });
    await expect(field).toHaveAttribute("placeholder", "Escribir un mensaje…");
    await field.fill("hola");
    await panel.getByRole("button", { name: "Enviar" }).click();
    const card = panel.locator(".chat-card").filter({ hasText: "Water the plants" });
    await expect(card).toContainText('Crear tarea «Water the plants»');
    await expect(card).toContainText("30 min");
    await expect(card.getByRole("button", { name: "Confirmar" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Descartar" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity))).toBe(true);
    await page.screenshot({ path: `${shots}chat-es-${name}.png` });
    // Signed out, a confirm cannot write: the card says so, in Spanish.
    await card.getByRole("button", { name: "Confirmar" }).click();
    await expect(card.getByRole("status")).toHaveText("Inicia sesión para que el asistente pueda cambiar tu planificador.");
    const other = panel.locator(".chat-card").filter({ hasText: "Return library books" });
    await other.getByRole("button", { name: "Descartar" }).click();
    await expect(other.getByRole("status")).toHaveText("Descartado: no se ha cambiado nada.");
  });
}

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { seedShutdownFixture, submitAuthForm } from "./browser-helpers.ts";

/**
 * Ronda 5, S8 (unit i9): Spanish is ~24% longer than English, so the shell must
 * wrap instead of overflowing. The test switches a phone to Español and asserts
 * the page, the body and the content column have no horizontal overflow on
 * Today, Tasks, Calendar and Settings.
 *
 * `I9_SHOTS=<dir>` also runs the screenshot sweep behind the layout QA
 * (`odd/runs/r5-i9-shots`): every surface in Spanish, light and dark, at
 * 1440x900 and 390x844, plus an audit of clipped and ellipsised text.
 */

test.setTimeout(240_000);

const newEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;

const isoAt = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayKey = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const todayAt = (hour: number, minute = 0) => {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** Signs in in English (the shared helper's labels), then switches this device to Spanish. */
async function signInSpanish(page: Page, email: string, theme: "light" | "dark" = "light") {
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(t => {
    window.localStorage.setItem("planner-language", "es");
    window.localStorage.setItem("planner-theme", t);
  }, theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
}

async function horizontalOverflow(page: Page): Promise<{ page: number; body: number; content: number }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const content = document.getElementById("content");
    return {
      page: root.scrollWidth - root.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      content: content === null ? 0 : content.scrollWidth - content.clientWidth,
    };
  });
}

test.describe("Spanish fits a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("no horizontal overflow on Today, Tasks, Calendar and Settings", async ({ page }) => {
    const email = newEmail("i9-overflow");
    await seedShutdownFixture(email, "UTC", {
      tasks: [
        { title: "Llamar al fisioterapeuta para reprogramar la cita de la semana que viene", deadline: dayKey(1) },
        { title: "Revisar el presupuesto", deadline: dayKey(-1) },
        { title: "Preparar la presentación para la reunión trimestral de planificación", deadline: dayKey(0) },
      ],
      blocks: [{ start: isoAt(-20), end: isoAt(70), task: "Preparar la presentación para la reunión trimestral de planificación" }],
    });
    await signInSpanish(page, email);

    const tabs = page.getByRole("navigation", { name: "Principal" });
    const surfaces: Array<[string, () => Promise<void>]> = [
      ["Today", async () => {}],
      ["Tasks", async () => {
        await tabs.getByRole("button", { name: /^Tareas/ }).click();
        await expect(page.getByText("Revisar el presupuesto").first()).toBeVisible();
      }],
      ["Calendar", async () => {
        await tabs.getByRole("button", { name: /^Calendario/ }).click();
        await expect(page.getByRole("button", { name: "Nuevo bloque", exact: true })).toBeVisible();
      }],
      ["Settings", async () => {
        await page.getByRole("button", { name: "Cuenta", exact: true }).click();
        await page.getByRole("button", { name: "Ajustes", exact: true }).click();
        await expect(page.getByRole("region", { name: "Ajustes" })).toBeVisible();
      }],
    ];
    for (const [name, open] of surfaces) {
      await open();
      // Let the page-turn fade and any sheet entrance finish before measuring.
      await page.waitForFunction(() =>
        (document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] })
          .getAnimations({ subtree: true }).every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
      );
      const overflow = await horizontalOverflow(page);
      expect(overflow.page, `${name}: page scrollWidth <= clientWidth`).toBeLessThanOrEqual(0);
      expect(overflow.body, `${name}: body scrollWidth <= clientWidth`).toBeLessThanOrEqual(0);
      expect(overflow.content, `${name}: main#content scrollWidth <= clientWidth`).toBeLessThanOrEqual(0);
    }
  });
});

/* ------------------------------------------------------------------------
 * Screenshot sweep (opt-in): `I9_SHOTS=<dir> I9_TAG=<tag>`.
 * ---------------------------------------------------------------------- */

const shotDir = process.env.I9_SHOTS;
const failures: string[] = [];

async function settle(page: Page) {
  await page.waitForFunction(() =>
    (document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] })
      .getAnimations({ subtree: true }).every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
  );
  await page.waitForTimeout(250);
}

type Clip = { selector: string; text: string; kind: "overflow" | "ellipsis"; by: number };

/** Elements whose content is wider than their box: either clipped (overflow) or cut with an ellipsis. */
async function audit(page: Page): Promise<Clip[]> {
  return page.evaluate(() => {
    const found: Array<{ selector: string; text: string; kind: "overflow" | "ellipsis"; by: number }> = [];
    const label = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const by = element.scrollWidth - element.clientWidth;
      if (by <= 1) continue;
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (style.textOverflow === "ellipsis") found.push({ selector: label(element), text, kind: "ellipsis", by });
      else if (style.overflowX !== "visible" && style.overflowX !== "auto" && style.overflowX !== "scroll") found.push({ selector: label(element), text, kind: "overflow", by });
    }
    return found;
  });
}

async function shot(page: Page, tag: string, name: string) {
  if (shotDir === undefined) return;
  await settle(page);
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${tag}-${name}.png` });
  const clips = await audit(page);
  if (clips.length > 0) writeFileSync(`${shotDir}/audit-${tag}-${name}.json`, JSON.stringify(clips, null, 1));
}

async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${String(error).split("\n")[0]}`);
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    test.describe(`sweep ${device} ${theme}`, () => {
      test.skip(shotDir === undefined, "set I9_SHOTS to run the screenshot sweep");
      test.use(device === "phone" ? { viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport });

      test(`${device}-${theme}`, async ({ page }) => {
        test.setTimeout(420_000);
        const tag = `${device}-${theme}`;
        const phone = device === "phone";
        const email = newEmail(`i9-${tag}`);
        const long = "Preparar la presentación para la reunión trimestral de planificación";
        await seedShutdownFixture(email, "UTC", {
          tasks: [
            { title: long, deadline: dayKey(0) },
            { title: "Llamar al fisioterapeuta para reprogramar la cita", deadline: dayKey(1) },
            { title: "Revisar el presupuesto", deadline: dayKey(-1) },
            { title: "Comprar regalo de cumpleaños" },
            { title: "Pagar el alquiler", completed: true, completedAt: todayAt(8) },
          ],
          blocks: [
            { start: isoAt(-20), end: isoAt(70), task: long },
            { start: todayAt(15), end: todayAt(16, 30), task: "Revisar el presupuesto" },
            { start: todayAt(18), end: todayAt(19), task: "Comprar regalo de cumpleaños" },
          ],
        });

        // Sign-in screen, Spanish.
        await page.addInitScript(t => {
          window.localStorage.setItem("planner-language", "es");
          window.localStorage.setItem("planner-theme", t);
        }, theme);
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", "es");
        await shot(page, tag, "01-signin");

        await signInSpanish(page, email, theme);
        const nav = (name: string) => page.getByRole("navigation", { name: "Principal" }).getByText(name, { exact: true }).first();
        const openSettings = async () => {
          if (phone) {
            await page.getByRole("button", { name: "Cuenta", exact: true }).click();
            await page.getByRole("button", { name: "Ajustes", exact: true }).click();
          } else await page.getByRole("button", { name: "Ajustes", exact: true }).click();
        };

        await step("today", async () => { await shot(page, tag, "02-today"); });
        await step("palette", async () => {
          await page.keyboard.press("Control+k");
          await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeVisible();
          await page.keyboard.type("aju");
          await shot(page, tag, "03-palette");
          await page.keyboard.press("Escape");
        });
        await step("help", async () => {
          await page.keyboard.press("?");
          await expect(page.getByText("Atajos de teclado").first()).toBeVisible();
          await shot(page, tag, "04-shortcuts");
          await page.keyboard.press("Escape");
        });
        await step("now", async () => {
          await page.keyboard.press("n");
          await expect(page.getByRole("dialog", { name: "Modo ahora" }).or(page.getByText("Modo ahora").first())).toBeVisible();
          await shot(page, tag, "05-now");
          await page.keyboard.press("Escape");
        });
        await step("tasks", async () => {
          await nav("Tareas").click();
          await expect(page.getByText("Pagar el alquiler")).toBeVisible();
          await shot(page, tag, "06-tasks");
        });
        await step("details", async () => {
          await page.getByText("Revisar el presupuesto").first().click();
          await expect(page.getByText("Detalles de la tarea").first()).toBeVisible();
          await shot(page, tag, "07-details");
          await page.keyboard.press("Escape");
        });
        await step("create", async () => {
          await page.getByRole("button", { name: "Nueva tarea", exact: true }).first().click();
          const sheet = page.getByRole("dialog", { name: "Nueva tarea" }).or(page.locator(".new-task-sheet")).first();
          await expect(sheet).toBeVisible();
          await sheet.getByLabel("Título de la tarea").fill("Tarea con una fecha límite");
          await shot(page, tag, "08-create");
          await sheet.getByLabel("Fecha límite").click();
          await expect(page.getByRole("dialog", { name: "Elegir fecha" })).toBeVisible();
          await shot(page, tag, "09-create-date");
          await page.keyboard.press("Escape");
          await settle(page);
          await sheet.getByLabel("Repetir").click();
          await shot(page, tag, "10-create-repeat");
          await page.keyboard.press("Escape");
          await settle(page);
          await page.keyboard.press("Escape");
          await settle(page);
        });
        await step("calendar", async () => {
          await nav("Calendario").click();
          await expect(page.getByRole("button", { name: "Nuevo bloque", exact: true })).toBeVisible();
          await shot(page, tag, "11-calendar-first");
          const week = page.getByRole("button", { name: "Semana", exact: true });
          const day = page.getByRole("button", { name: "Día", exact: true });
          await week.click();
          await shot(page, tag, "12-calendar-week");
          await day.click();
          await shot(page, tag, "13-calendar-day");
          await page.getByRole("button", { name: "Nuevo bloque", exact: true }).click();
          await expect(page.getByText("Añadir bloque").first()).toBeVisible();
          await shot(page, tag, "14-block-form");
          await page.keyboard.press("Escape");
          await settle(page);
        });
        await step("settings", async () => {
          await openSettings();
          const view = page.getByRole("region", { name: "Ajustes" });
          await expect(view).toBeVisible();
          await shot(page, tag, "15-settings-general");
          const rail = view.getByRole("navigation", { name: "Secciones de Ajustes" });
          await rail.getByRole("button", { name: "Rituales" }).click();
          await shot(page, tag, "16-settings-rituals");
          await rail.getByRole("button", { name: "Atajos" }).click();
          await shot(page, tag, "17-settings-shortcuts");
        });
        await step("weekly", async () => {
          await page.keyboard.press("Escape");
          await page.keyboard.press("w");
          await expect(page.getByRole("heading", { name: "Revisión semanal" }).first()).toBeVisible();
          await shot(page, tag, "18-weekly-review");
          const next = page.getByRole("button", { name: "Siguiente", exact: true });
          await next.click();
          await shot(page, tag, "19-weekly-cleanup");
        });
        if (failures.length > 0) writeFileSync(`${shotDir}/failures-${tag}.txt`, failures.join("\n"));
      });
    });
  }
}

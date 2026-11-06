import { expect, test, type Locator, type Page } from "@playwright/test";
import { createRemoteAccount, readRemoteShutdown, submitAuthForm } from "./browser-helpers.ts";

/**
 * The day replay inside the shutdown ritual (Ronda 8, plan
 * `odd/plans/day-replay.md` §1, §6, §7): after the close lands, a stage plays
 * the plan bending into what happened and ends on one sentence about the
 * estimates. The stage is skippable from frame 0, replayable on request, and
 * its modes (Auto, On request, Off) live on the device.
 *
 * The clock is installed before the app loads and left running, as in the
 * shutdown ritual's own specs, so "18:30 on this day" is part of the fixture.
 * Playback is sped up with `playbackRate = 40` on the stage's animations: the
 * specs assert states and the exact sentence, not the feel (that is U6's).
 */

test.setTimeout(240_000);

const ZONE = "UTC";
const DAY_MS = 86_400_000;
const FIRESTORE_REST = "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";
const AUTH_REST = "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-calendar-app";

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

/** A wall-clock hour two days out, clear of the account's creation. */
function at(hour: number, minute = 0): Date {
  const base = new Date();
  base.setUTCHours(hour, minute, 0, 0);
  base.setUTCDate(base.getUTCDate() + 2);
  return base;
}

function dayKey(base: Date, offset = 0): string {
  return new Date(base.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

type FixtureTask = {
  title: string;
  completed?: boolean;
  completedAt?: string;
  deadline?: string;
  estimate?: number;
  actualMinutes?: number;
  /** Minutes the focus timer recorded on the fixture day (`actualByDay`). */
  trackedToday?: number;
};
type FixtureBlock = { task?: string; from: string; to: string };

type Fixture = {
  tasks?: FixtureTask[];
  blocks?: FixtureBlock[];
};

async function remoteUid(email: string): Promise<string> {
  const response = await fetch(`${AUTH_REST}/accounts:batchGet?key=local-only&maxResults=1000`, {
    headers: { Authorization: "Bearer owner" },
  });
  if (!response.ok) throw new Error(`accounts:batchGet failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { users?: Array<{ localId?: string; email?: string }> };
  const uid = (body.users ?? []).find(user => user.email === email)?.localId;
  if (uid === undefined) throw new Error(`no Auth emulator account found for ${email}`);
  return uid;
}

type Field = Record<string, unknown>;
const text = (value: string): Field => ({ stringValue: value });
const int = (value: number): Field => ({ integerValue: String(value) });

async function post(uid: string, collection: string, fields: Record<string, Field>): Promise<string> {
  const response = await fetch(`${FIRESTORE_REST}/users/${uid}/${collection}`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`emulator add failed: ${response.status} ${await response.text()}`);
  const name = ((await response.json()) as { name: string }).name;
  return name.slice(name.lastIndexOf("/") + 1);
}

/** Seeds an account (profile zone, tasks with minutes, blocks) and returns the ids by title. */
async function seed(email: string, base: Date, fixture: Fixture, language?: "es"): Promise<{ uid: string; taskIds: Record<string, string> }> {
  await createRemoteAccount(email);
  const uid = await remoteUid(email);
  const profile = await fetch(`${FIRESTORE_REST}/users/${uid}/profile/main`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { timeZone: text(ZONE), ...(language === undefined ? {} : { language: text(language) }) } }),
  });
  if (!profile.ok) throw new Error(`profile write failed: ${profile.status} ${await profile.text()}`);
  const today = dayKey(base);
  const taskIds: Record<string, string> = {};
  for (const task of fixture.tasks ?? []) {
    const fields: Record<string, Field> = {
      title: text(task.title),
      completed: { booleanValue: task.completed ?? false },
    };
    if (task.completedAt !== undefined) fields.completedAt = text(task.completedAt);
    if (task.deadline !== undefined) fields.deadline = text(task.deadline);
    if (task.estimate !== undefined) fields.estimate = int(task.estimate);
    if (task.actualMinutes !== undefined) fields.actualMinutes = int(task.actualMinutes);
    if (task.trackedToday !== undefined) fields.actualByDay = { mapValue: { fields: { [today]: int(task.trackedToday) } } };
    taskIds[task.title] = await post(uid, "tasks", fields);
  }
  for (const block of fixture.blocks ?? []) {
    const fields: Record<string, Field> = {
      start: text(`${today}T${block.from}:00Z`),
      end: text(`${today}T${block.to}:00Z`),
    };
    if (block.task !== undefined) {
      const taskId = taskIds[block.task];
      if (taskId === undefined) throw new Error(`block names unknown task ${block.task}`);
      fields.taskId = text(taskId);
    }
    await post(uid, "blocks", fields);
  }
  return { uid, taskIds };
}

/** Four finished "Reunión" tasks, estimated 30 and tracked 39: the sentence's fixture. */
function meetingsDay(base: Date): Fixture {
  const done = `${dayKey(base)}T17:00:00Z`;
  const titles = ["Reunión con Ana", "Reunión de equipo", "Reunión de cierre", "Reunión semanal"];
  return {
    tasks: titles.map(title => ({ title, completed: true, completedAt: done, estimate: 30, actualMinutes: 39, trackedToday: 39 })),
    blocks: titles.map((title, index) => ({ task: title, from: `${String(9 + index).padStart(2, "0")}:00`, to: `${String(9 + index).padStart(2, "0")}:30` })),
  };
}

const ritual = (page: Page) => page.getByRole("complementary", { name: /Close the day|How the day went|Cerrar el día|Cómo fue el día/ });
const banner = (page: Page) => page.locator(".shutdown-banner");
const stageOf = (page: Page) => ritual(page).locator(".day-replay");
const skipButton = (page: Page) => stageOf(page).getByRole("button", { name: /^(Skip|Omitir)$/ });

interface OpenOptions {
  mode?: "auto" | "request" | "off";
  /** The account's synced language: the sign-in form is English, the app follows the profile. */
  language?: "es";
  snapshot?: (uid: string, day: string, taskIds: Record<string, string>) => { key: string; value: string };
}

/** Signs a seeded account in under the fake clock, and waits for Today. */
async function open(page: Page, base: Date, prefix: string, fixture: Fixture, options: OpenOptions = {}) {
  const email = newEmail(prefix);
  const { uid, taskIds } = await seed(email, base, fixture, options.language);
  const storage: Array<[string, string]> = [];
  if (options.mode !== undefined) storage.push(["planner-replay-mode", options.mode]);
  if (options.snapshot !== undefined) {
    const entry = options.snapshot(uid, dayKey(base), taskIds);
    storage.push([entry.key, entry.value]);
  }
  await page.addInitScript(entries => {
    for (const [key, value] of entries) window.localStorage.setItem(key, value);
  }, storage);
  await page.clock.install({ time: base });
  await expect(async () => {
    await submitAuthForm(page, email, "sign in");
  }).toPass({ timeout: 60_000 });
  await expect(page.locator(".now-card, .empty-state").first()).toBeVisible({ timeout: 30_000 });
  return { email, uid, taskIds };
}

async function panelSettled(page: Page): Promise<void> {
  await expect(ritual(page)).toBeVisible();
  await ritual(page).evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
}

/** Opens the ritual from Home's banner and closes the day with the visible button. */
async function closeTheDay(page: Page): Promise<void> {
  await banner(page).getByRole("button", { name: /Close day|Cerrar el día/ }).click();
  await panelSettled(page);
  await ritual(page).getByRole("button", { name: /^(Close day|Cerrar el día)$/ }).click();
}

/** Runs the stage's animations at 40x, so the whole replay lasts a fraction of a second. */
async function speedUp(stage: Locator): Promise<void> {
  await stage.evaluate(element => {
    for (const animation of element.getAnimations({ subtree: true })) animation.playbackRate = 40;
  });
}

const paletteOption = (page: Page, name: RegExp) =>
  page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name });

async function openPalette(page: Page, query: string): Promise<Locator> {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search tasks or run a command" }).fill(query);
  return palette;
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("closing the day shows the stage with Skip focused, and the deadlines still roll", async ({ page }) => {
    const base = at(18, 30);
    const today = dayKey(base);
    const tomorrow = dayKey(base, 1);
    const fixture = meetingsDay(base);
    fixture.tasks!.push({ title: "Review the draft", deadline: today });
    const { email } = await open(page, base, "replay-stage", fixture);

    await closeTheDay(page);

    const stage = stageOf(page);
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute("data-state", "playing");
    await expect(skipButton(page)).toBeFocused();
    await expect(stage.getByRole("heading", { name: "How the day went" })).toBeVisible();
    // The close behind the stage is the same close: the deadline rolled and the day is stamped.
    await expect
      .poll(() => readRemoteShutdown(email).then(state => state.deadlines["Review the draft"]), { timeout: 15_000 })
      .toBe(tomorrow);
    expect((await readRemoteShutdown(email)).lastShutdown).toBe(today);
    // Tomorrow is not on screen while the stage plays.
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toHaveCount(0);
  });

  test("one live region speaks while the stage plays: the sheet's, with the replay inside it", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-live", meetingsDay(base));

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toHaveAttribute("data-state", "playing");
    // The stage adds no second status: the close and the replay arrive as one utterance.
    await expect(stage.getByRole("status")).toHaveCount(0);
    const live = ritual(page).getByRole("status");
    await expect(live).toHaveCount(1);
    await expect(live).toContainText("Day closed.");
    await expect(live).toContainText("longer than planned.");
    await expect(live).toContainText("You underestimate “reunión” tasks by 30%.");
    const spoken = (await live.textContent()) ?? "";
    expect(spoken.match(/You underestimate/g)).toHaveLength(1);

    // Replaying from the Done page speaks through the same region, still one at a time.
    await skipButton(page).click();
    await stage.getByRole("button", { name: "Continue" }).click();
    await expect(stage).toHaveCount(0);
    await ritual(page).getByRole("button", { name: "Replay the day" }).click();
    await expect(stageOf(page)).toBeVisible();
    await expect(stageOf(page).getByRole("status")).toHaveCount(0);
    await expect(ritual(page).getByRole("status")).toHaveCount(1);
    await expect(ritual(page).getByRole("status")).toContainText("You underestimate “reunión” tasks by 30%.");
  });

  test("Skip lands the final frame, Continue reveals Tomorrow and Done", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-skip", meetingsDay(base));

    await closeTheDay(page);
    await expect(stageOf(page)).toHaveAttribute("data-state", "playing");

    await skipButton(page).click();
    const stage = stageOf(page);
    await expect(stage).toHaveAttribute("data-state", "done");
    await expect(stage.locator(".replay-sentence-text")).toHaveText("You underestimate “reunión” tasks by 30%.");

    await stage.getByRole("button", { name: "Continue" }).click();
    await expect(stage).toHaveCount(0);
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeFocused();
    await expect(ritual(page).getByRole("button", { name: "Done" })).toBeVisible();
    await expect(ritual(page).getByRole("button", { name: "Replay the day" })).toBeVisible();
  });

  test("Escape skips first; the second Escape closes the sheet", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-escape", meetingsDay(base));

    await closeTheDay(page);
    await expect(stageOf(page)).toHaveAttribute("data-state", "playing");

    await page.keyboard.press("Escape");
    await expect(stageOf(page)).toHaveAttribute("data-state", "done");
    await expect(ritual(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(ritual(page)).toHaveCount(0);
  });

  test("a sped-up playback reaches done with the exact English sentence", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-en", meetingsDay(base));

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toHaveAttribute("data-state", "playing");
    await speedUp(stage);

    await expect(stage).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    await expect(stage.locator(".replay-sentence-text")).toHaveText("You underestimate “reunión” tasks by 30%.");
    await expect(stage.locator(".replay-basis")).toHaveText("Based on 4 finished tasks.");
    await expect(stage.locator("[data-part=row]")).toHaveCount(4);
    await expect(stage.locator("[data-part=row][data-outcome=stretched]")).toHaveCount(4);
    await expect(stage.getByRole("button", { name: "Continue" })).toBeFocused();
  });

  test("the Spanish sentence is the exact neutral copy", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-es", meetingsDay(base), { language: "es" });

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toHaveAttribute("data-state", "playing");
    await speedUp(stage);

    await expect(stage).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    const sentence = (await stage.locator(".replay-sentence-text").innerText()).replace(/\u00a0/g, " ");
    expect(sentence).toBe("Subestimas las tareas de «reunión» un 30 %.");
    await expect(stage.getByRole("heading", { name: "Cómo fue el día" })).toBeVisible();
    await expect(stage.getByRole("button", { name: "Continuar" })).toBeVisible();
  });

  test("with reduced motion nothing animates and the final frame is already there", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const base = at(18, 30);
    await open(page, base, "replay-reduced", meetingsDay(base));

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute("data-state", "done");
    await expect(stage.locator(".replay-sentence-text")).toHaveText("You underestimate “reunión” tasks by 30%.");
    const running = await stage.evaluate(element => element.getAnimations({ subtree: true }).filter(a => a.playState === "running").length);
    expect(running).toBe(0);
    await expect(stage.getByRole("button", { name: "Continue" })).toBeFocused();
  });

  test("a block moved since the morning snapshot is a moved row", async ({ page }) => {
    const base = at(18, 30);
    const day = dayKey(base);
    // The plan at 09:00; by the evening the block sits at 14:00.
    await open(
      page,
      base,
      "replay-moved",
      {
        tasks: [{ title: "Write the report", completed: true, completedAt: `${day}T15:00:00Z`, estimate: 60, actualMinutes: 60, trackedToday: 60 }],
        blocks: [{ task: "Write the report", from: "14:00", to: "15:00" }],
      },
      {
        snapshot: (uid, snapshotDay, taskIds) => ({
          key: `planner-day-plan:${uid}:${snapshotDay}`,
          value: JSON.stringify({
            v: 1,
            day: snapshotDay,
            zone: ZONE,
            takenAt: `${snapshotDay}T09:00:00.000Z`,
            blocks: [
              { id: "morning", start: `${snapshotDay}T09:00:00Z`, end: `${snapshotDay}T10:00:00Z`, taskId: taskIds["Write the report"], title: "Write the report" },
            ],
          }),
        }),
      },
    );

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toBeVisible();
    await speedUp(stage);
    await expect(stage).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    await expect(stage.locator("[data-part=row]")).toHaveCount(1);
    await expect(stage.locator("[data-part=row]")).toHaveAttribute("data-outcome", "moved");
  });

  test("a day with nothing planned or tracked has no stage and no palette entry", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-empty", { tasks: [{ title: "Plan the quarter", deadline: dayKey(base, 3) }] });

    await closeTheDay(page);
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    await expect(stageOf(page)).toHaveCount(0);
    await expect(ritual(page).getByRole("button", { name: "Replay the day" })).toHaveCount(0);

    await ritual(page).getByRole("button", { name: "Done" }).click();
    await expect(ritual(page)).toHaveCount(0);
    const palette = await openPalette(page, "replay");
    await expect(palette.getByRole("option").first()).toBeVisible();
    await expect(paletteOption(page, /Replay the day/)).toHaveCount(0);
  });

  test("On request: no auto play, a button and the palette replay the day", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-request", meetingsDay(base), { mode: "request" });

    await closeTheDay(page);
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    await expect(stageOf(page)).toHaveCount(0);

    await ritual(page).getByRole("button", { name: "Replay the day" }).click();
    await expect(stageOf(page)).toBeVisible();
    await expect(skipButton(page)).toBeFocused();
    await skipButton(page).click();
    await stageOf(page).getByRole("button", { name: "Continue" }).click();
    await expect(stageOf(page)).toHaveCount(0);
    await ritual(page).getByRole("button", { name: "Done" }).click();
    await expect(ritual(page)).toHaveCount(0);

    // The palette's action opens the sheet on the stage alone.
    const palette = await openPalette(page, "replay");
    await expect(paletteOption(page, /Replay the day/)).toBeVisible();
    await paletteOption(page, /Replay the day/).click();
    await expect(palette).toHaveCount(0);
    await expect(stageOf(page)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "How the day went" })).toBeVisible();
    // The replay-only sheet has no close line to share a region with: the stage speaks for itself.
    await expect(stageOf(page).getByRole("status")).toContainText("You underestimate “reunión” tasks by 30%.");
    await page.keyboard.press("Escape");
    await expect(stageOf(page)).toHaveAttribute("data-state", "done");
    await page.keyboard.press("Escape");
    await expect(stageOf(page)).toHaveCount(0);
  });

  test("Off: no stage, no button, no palette entry", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-off", meetingsDay(base), { mode: "off" });

    await closeTheDay(page);
    await expect(ritual(page).getByRole("heading", { name: "Tomorrow" })).toBeVisible();
    await expect(stageOf(page)).toHaveCount(0);
    await expect(ritual(page).getByRole("button", { name: "Replay the day" })).toHaveCount(0);

    await ritual(page).getByRole("button", { name: "Done" }).click();
    const palette = await openPalette(page, "replay");
    await expect(palette.getByRole("option").first()).toBeVisible();
    await expect(paletteOption(page, /Replay the day/)).toHaveCount(0);
  });

  test("the setting lives in Rituals and persists on the device", async ({ page }) => {
    const base = at(18, 30);
    await open(page, base, "replay-setting", meetingsDay(base));

    const palette = await openPalette(page, "rituals");
    await palette.getByRole("option", { name: /Rituals/ }).first().click();
    await page.getByRole("combobox", { name: "Play the replay" }).click();
    await page.getByRole("option", { name: "On request" }).click();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("planner-replay-mode"))).toBe("request");
  });

  test("offline, the close lands and the replay still plays from local data", async ({ page, context }) => {
    const base = at(18, 30);
    await open(page, base, "replay-offline", meetingsDay(base));
    await context.setOffline(true);

    await closeTheDay(page);
    const stage = stageOf(page);
    await expect(stage).toBeVisible({ timeout: 20_000 });
    await speedUp(stage);
    await expect(stage).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    await expect(stage.locator(".replay-sentence-text")).toHaveText("You underestimate “reunión” tasks by 30%.");
    await context.setOffline(false);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("seven rows and a long sentence fit without a horizontal scroll", async ({ page }) => {
    const base = at(18, 30);
    const done = `${dayKey(base)}T17:00:00Z`;
    const titles = ["Reunión con Ana", "Reunión de equipo", "Reunión de cierre", "Reunión semanal", "Escribir el informe trimestral", "Revisar la propuesta", "Llamar al banco"];
    const { email } = await open(page, base, "replay-phone", {
      tasks: titles.map(title => ({ title, completed: true, completedAt: done, estimate: 30, actualMinutes: 39, trackedToday: 39 })),
      blocks: titles.map((title, index) => ({ task: title, from: `${String(8 + index).padStart(2, "0")}:00`, to: `${String(8 + index).padStart(2, "0")}:30` })),
    });
    void email;

    // The banner has no button on a phone; the visible button is inside the sheet.
    const bar = (await banner(page).boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const from = { x: bar.x + bar.width - 30, y: bar.y + bar.height / 2 };
    const to = { x: bar.x + 20, y: from.y };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * step) / 10, y: from.y, id: 1 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await panelSettled(page);
    await ritual(page).getByRole("button", { name: "Close day" }).click();

    const stage = stageOf(page);
    await expect(stage).toBeVisible();
    await speedUp(stage);
    await expect(stage).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    // Six rows and the fold: the cap holds on a narrow screen.
    await expect(stage.locator("[data-part=row]")).toHaveCount(6);
    await expect(stage.locator("[data-part=more]")).toHaveText("+1 more");
    await expect(stage.locator(".replay-sentence-text")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    const box = (await stage.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const inner = await stage.evaluate(element => element.scrollWidth - element.clientWidth);
    expect(inner).toBeLessThanOrEqual(0);
  });
});

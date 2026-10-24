import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createRemoteAccount, password, readRemoteBlocks, readRemoteTasks, seedTasks, submitAuthForm, updateRemoteProfile } from "./browser-helpers.ts";

/**
 * The agentic chat's browser spec (ronda4 T4, S4+S5): the new tools end to
 * end through the panel, the app's own data functions and the emulator —
 * create at a wall-clock time, delete, holiday hide, memory, reads, and the
 * S4 diagnosis itself: a follow-up that must see the task the assistant just
 * created, at its real time, by id.
 *
 * Same harness as chat-panel.spec.ts: a Vite dev server spawned here (the
 * mock panel only mounts with `import.meta.env.DEV` + `?chatMock`), with the
 * emulators running around the suite for the real writes.
 */

const PORT = 4198;
const base = `http://127.0.0.1:${PORT}`;
const shots = new URL("../../odd/runs/r4-agent-shots/", import.meta.url).pathname;

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
  throw new Error("chat-tools spec: the dev server did not become ready in 60 s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
});

const launcher = (page: Page) => page.getByRole("button", { name: "Chat" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Chat" });
const field = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
const actionCard = (page: Page, title: string) => panel(page).locator(".chat-card").filter({ hasText: title });

const AUTH_EMULATOR = "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-calendar-app";
const FIRESTORE_REST = "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";

async function remoteUid(email: string): Promise<string> {
  const response = await fetch(`${AUTH_EMULATOR}/accounts:lookup?key=local-only`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] }),
  });
  if (!response.ok) throw new Error(`emulator accounts:lookup failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { users?: Array<{ localId?: string }> };
  const uid = body.users?.[0]?.localId;
  if (!uid) throw new Error(`no Auth emulator account found for ${email}`);
  return uid;
}

/** The user's emulator ID token: the security rules require the write to come
 * from the owner, exactly like the app's own writes do. */
async function idToken(email: string): Promise<string> {
  const response = await fetch("http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-only", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`emulator sign-in failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { idToken?: string };
  if (!body.idToken) throw new Error("no idToken from the Auth emulator");
  return body.idToken;
}

/** Seeds one holiday label the way an import stores it (deterministic id). */
async function seedHoliday(email: string, id: string, date: string, title: string): Promise<void> {
  const uid = await remoteUid(email);
  const response = await fetch(`${FIRESTORE_REST}/users/${uid}/holidays/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await idToken(email)}` },
    body: JSON.stringify({
      fields: {
        date: { stringValue: date },
        title: { stringValue: title },
        kind: { stringValue: "public" },
        source: {
          mapValue: {
            fields: {
              provider: { stringValue: "gcal" },
              calendarId: { stringValue: "es.ar#holiday@group.v.calendar.google.com" },
              eventId: { stringValue: `evt-${id}` },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`holiday seed failed: ${response.status} ${await response.text()}`);
}

async function readHolidayHidden(email: string, id: string): Promise<boolean | undefined> {
  const uid = await remoteUid(email);
  const response = await fetch(`${FIRESTORE_REST}/users/${uid}/holidays/${id}`, { headers: { Authorization: `Bearer ${await idToken(email)}` } });
  if (!response.ok) throw new Error(`holiday read failed: ${response.status}`);
  const body = (await response.json()) as { fields?: { hidden?: { booleanValue?: boolean } } };
  return body.fields?.hidden?.booleanValue;
}

/** The zone the browser will actually use, so the profile zone, the mock's
 * "today" and the test's date keys all agree. */
async function browserZone(page: Page): Promise<string> {
  await page.goto(base);
  return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function dayKeyNow(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Signs in on the dev server and lands on the named mock scenario. The
 * account and its UTC-pinned profile must already exist. */
async function signInMock(page: Page, email: string, scenario: string): Promise<void> {
  await submitAuthForm(page, email, "sign in", { url: base });
  await page.goto(`${base}/?chatMock=${scenario}`);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible({ timeout: 30_000 });
}

async function openPanel(page: Page): Promise<void> {
  await expect(launcher(page)).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await expect(field(page)).toBeFocused();
}

/** The system prompt of the last request the mock transport recorded. */
function lastSystemPrompt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const mock = (window as { __chatMockTransport?: { __lastStreamRequest?: { messages?: Array<{ role?: string; content?: string }> } } })
      .__chatMockTransport;
    return mock?.__lastStreamRequest?.messages?.find(message => message.role === "system")?.content ?? "";
  });
}

type PollMessage = { role?: string; content?: string; toolCallId?: string };

test("create at a time lands on the schedule, and the follow-up moves it by id (S4)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `chat-create-${Date.now()}@example.test`;
  const zone = await browserZone(page);
  await createRemoteAccount(email);
  await updateRemoteProfile(email, zone);
  await signInMock(page, email, "agent-edit");
  await openPanel(page);

  // The mock proposes a create with a start time — the thing that used to be
  // impossible (S4 diagnosis D1).
  await field(page).fill("Set up a watering reminder");
  await field(page).press("Enter");
  const createCard = actionCard(page, 'Create task "Water the plants"');
  await expect(createCard).toBeVisible({ timeout: 30_000 });
  await expect(createCard.locator(".chat-card-action")).toContainText("14:00");
  await createCard.getByRole("button", { name: "Confirm" }).click();
  await expect(createCard.locator(".chat-card-outcome")).toContainText("Created task id=", { timeout: 15_000 });

  // The task sits on today's schedule at 14:00 — exactly one block.
  const today = dayKeyNow(zone);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  const block = page.locator(`[data-date="${today}"] .calendar-block`).filter({ hasText: "Water the plants" });
  await expect(block).toHaveCount(1, { timeout: 15_000 });
  const blocks = await readRemoteBlocks(email);
  const created = blocks.filter(entry => entry.taskId !== undefined);
  expect(created).toHaveLength(1);
  expect(created[0]?.start).toContain("T14:00");

  // The follow-up: the mock reads the created id from the tool result and
  // proposes moving THAT task to 16:00 — the flow the S4 report described as
  // broken ("no podía ver la información actualizada"). The fresh system
  // prompt must have carried the created task with its id and its time.
  // The floating panel stayed open through the Calendar visit; just type.
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await field(page).fill("Actually, later please");
  await field(page).press("Enter");
  await expect
    .poll(async () => {
      const prompt = await lastSystemPrompt(page);
      const createdId = /Created task id=([\w-]+)/.exec(await createCard.locator(".chat-card-outcome").textContent().then(text => text ?? ""))?.[1];
      return createdId !== undefined && prompt.includes(`[${createdId}]`) && prompt.includes("14:00");
    }, { timeout: 15_000 })
    .toBe(true);
  const moveCard = actionCard(page, 'Move "Water the plants"');
  await expect(moveCard).toBeVisible({ timeout: 30_000 });
  await expect(moveCard.locator(".chat-card-action")).toContainText("16:00");
  // The card states the replacement (review finding 1): the 14:00 placement
  // this move replaces is named before the user confirms.
  await expect(moveCard.locator(".chat-card-action")).toContainText(/replaces 1 block.*14:00–14:45/);
  await moveCard.getByRole("button", { name: "Confirm" }).click();
  await expect(moveCard.locator(".chat-card-outcome")).toContainText(/Moved task id=/, { timeout: 15_000 });

  // The placement was REPLACED, not duplicated: still exactly one block, now
  // at 16:00, and the deadline write landed with it (one batch).
  await expect
    .poll(async () => {
      const placed = (await readRemoteBlocks(email)).filter(entry => entry.taskId !== undefined);
      return placed;
    }, { timeout: 15_000 })
    .toHaveLength(1);
  const moved = (await readRemoteBlocks(email)).filter(entry => entry.taskId !== undefined);
  expect(moved[0]?.start).toContain("T16:00");
});

test("delete: discard leaves the task alone, confirm removes it (S4)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `chat-delete-${Date.now()}@example.test`;
  const zone = await browserZone(page);
  await createRemoteAccount(email);
  await updateRemoteProfile(email, zone);
  await seedTasks(email, [{ title: "Delete me" }]);
  await signInMock(page, email, "agent-delete");

  // The seeded task is already in the store, so the planner context carries
  // it with its id and the mock (like the real model) can reference it. The
  // Tasks list is the view that shows undated tasks.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByText("Delete me")).toBeVisible({ timeout: 30_000 });
  await openPanel(page);
  await field(page).fill("Clean up the test task");
  await field(page).press("Enter");

  const cards = panel(page).locator(".chat-card");
  const deleteCard = cards.last();
  await expect(deleteCard).toBeVisible({ timeout: 30_000 });
  // The card names exactly what will be removed (S4): the task and what stays.
  await expect(deleteCard.locator(".chat-card-action")).toContainText('Delete task "Delete me"');

  // Discard first: nothing is removed.
  await deleteCard.getByRole("button", { name: "Discard" }).click();
  await expect(deleteCard.locator(".chat-card-outcome")).toHaveText("Discarded — nothing changed.");
  await expect.poll(async () => (await readRemoteTasks(email)).some(task => task.title === "Delete me"), { timeout: 15_000 }).toBe(true);

  // Confirm on a fresh proposal: the task is gone from the store and the UI.
  await field(page).fill("Please delete it for real");
  await field(page).press("Enter");
  const secondCard = cards.last();
  await expect(secondCard.getByRole("button", { name: "Confirm" })).toBeVisible({ timeout: 30_000 });
  await secondCard.getByRole("button", { name: "Confirm" }).click();
  await expect(secondCard.locator(".chat-card-outcome")).toContainText("Deleted task id=", { timeout: 15_000 });
  await expect.poll(async () => (await readRemoteTasks(email)).some(task => task.title === "Delete me"), { timeout: 15_000 }).toBe(false);
  await page.keyboard.press("Escape");
  // The hidden panel keeps its own card text; the view itself is clean.
  await expect(page.locator(".view").getByText("Delete me")).toHaveCount(0);
});

test("hiding a holiday through the chat matches the Holidays sheet (S4)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `chat-holiday-${Date.now()}@example.test`;
  const zone = await browserZone(page);
  await createRemoteAccount(email);
  await updateRemoteProfile(email, zone);
  const today = dayKeyNow(zone);
  await seedHoliday(email, "h-chat-test", today, "Independence Day");
  await signInMock(page, email, "agent-holiday");

  // The chip is on the calendar first, exactly as the Holidays sheet shows it.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  const chip = page.getByRole("button", { name: "Independence Day, Public holiday" });
  await expect(chip).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(panel(page)).toHaveAttribute("data-open", "true");
  await field(page).fill("I do not celebrate this one");
  await field(page).press("Enter");
  const hideCard = panel(page).locator(".chat-card").last();
  await expect(hideCard.locator(".chat-card-action")).toContainText('Hide holiday "Independence Day"', { timeout: 30_000 });
  await hideCard.getByRole("button", { name: "Confirm" }).click();
  await expect(hideCard.locator(".chat-card-outcome")).toContainText("hidden", { timeout: 15_000 });

  // The chip leaves the calendar — the same observable the Holidays sheet's
  // own Hide button drives — and the document keeps the flag.
  await expect(chip).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => await readHolidayHidden(email, "h-chat-test"), { timeout: 15_000 }).toBe(true);
});

test("reads run without confirmation and their data rides the next request (S4)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `chat-read-${Date.now()}@example.test`;
  const zone = await browserZone(page);
  await createRemoteAccount(email);
  await updateRemoteProfile(email, zone);
  await signInMock(page, email, "agent-read");
  // Seed after sign-in, then reload: the read must see them live (fresh
  // context, S4) — and the store must carry them before the request goes.
  await seedTasks(email, [{ title: "Buy milk" }, { title: "Pay rent" }]);
  await page.reload();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible({ timeout: 30_000 });

  await openPanel(page);
  await field(page).fill("What do I have?");
  await field(page).press("Enter");
  const readCard = actionCard(page, "Look up tasks");
  await expect(readCard).toBeVisible({ timeout: 30_000 });
  // No Confirm/Discard ever: a read is not a proposal (S4).
  await expect(readCard.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await expect(readCard.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(readCard.locator(".chat-card-outcome")).toHaveText("2 tasks found.", { timeout: 15_000 });

  // The read's result rode the conversation: the next request carries the
  // tool message with the ids and titles.
  await field(page).fill("Thanks");
  await field(page).press("Enter");
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const mock = (window as { __chatMockTransport?: { __lastStreamRequest?: { messages?: PollMessage[] } } }).__chatMockTransport;
          return (mock?.__lastStreamRequest?.messages ?? []).some(
            message => message.role === "tool" && (message.content ?? "").includes("Buy milk") && (message.content ?? "").includes("["),
          );
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
});

test("remember lands in the notes; forgetting it takes it back out (S5)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `chat-memory-${Date.now()}@example.test`;
  const zone = await browserZone(page);
  await createRemoteAccount(email);
  await updateRemoteProfile(email, zone);
  await signInMock(page, email, "agent-memory");
  await openPanel(page);

  await field(page).fill("Remember something about me");
  await field(page).press("Enter");
  const rememberCard = actionCard(page, 'Remember "Prefers morning planning"');
  await expect(rememberCard).toBeVisible({ timeout: 30_000 });
  await rememberCard.getByRole("button", { name: "Confirm" }).click();
  await expect(rememberCard.locator(".chat-card-outcome")).toContainText("Remembered", { timeout: 15_000 });

  // The note rides along: the next request's system prompt carries it, and
  // the mock (reading that tool result) proposes forgetting it by key.
  await field(page).fill("Actually, forget that");
  await field(page).press("Enter");
  await expect
    .poll(async () => (await lastSystemPrompt(page)).includes("Prefers morning planning"), { timeout: 15_000 })
    .toBe(true);
  const forgetCard = panel(page).locator(".chat-card").last();
  await expect(forgetCard.locator(".chat-card-action")).toContainText('Forget the note "Prefers morning planning"', { timeout: 30_000 });
  await forgetCard.getByRole("button", { name: "Confirm" }).click();
  await expect(forgetCard.locator(".chat-card-outcome")).toContainText("Removed the note", { timeout: 15_000 });

  await field(page).fill("What do you remember now?");
  await field(page).press("Enter");
  await expect
    .poll(async () => (await lastSystemPrompt(page)).includes("Prefers morning planning"), { timeout: 15_000 })
    .toBe(false);
});

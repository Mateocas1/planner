import { expect, test, type Page } from "@playwright/test";
import { calendarKey } from "../src/domain/gcalImport.ts";
import {
  createRemoteAccount,
  readRemoteImport,
  submitAuthForm,
  updateRemoteProfile,
} from "./browser-helpers.ts";

/**
 * A block that came from Google Calendar shows the event's title where a plain
 * block shows "Work block" (value roadmap §1, import 4a).
 *
 * This is the only end-to-end proof that the new optional fields survive the
 * whole read path -- seeded document, store, grid -- because the title cannot
 * be produced from the UI: nothing in the app creates a titled block yet (the
 * import surface is 4b). Seeding uses the emulators' REST endpoints directly,
 * the way browser-helpers does, so the document is a real server read and not
 * a client cache.
 */

const AUTH_EMULATOR = "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/projects/demo-calendar-app";
const FIRESTORE_REST = "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";

test.setTimeout(90_000);

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

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

/** Seeds the profile zone and one titled block, and returns that block's id. */
async function seedTitledBlock(email: string, timeZone: string, start: string, end: string, title: string): Promise<string> {
  await createRemoteAccount(email);
  const uid = await remoteUid(email);
  const profile = await fetch(`${FIRESTORE_REST}/users/${uid}/profile/main`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { timeZone: { stringValue: timeZone } } }),
  });
  if (!profile.ok) throw new Error(`emulator profile set failed: ${profile.status} ${await profile.text()}`);
  const block = await fetch(`${FIRESTORE_REST}/users/${uid}/blocks`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        start: { stringValue: start },
        end: { stringValue: end },
        title: { stringValue: title },
        source: {
          mapValue: {
            fields: {
              provider: { stringValue: "gcal" },
              calendarId: { stringValue: "primary" },
              eventId: { stringValue: "evt-title-test" },
              updated: { stringValue: "2026-10-18T10:00:00.000Z" },
            },
          },
        },
      },
    }),
  });
  if (!block.ok) throw new Error(`emulator block add failed: ${block.status} ${await block.text()}`);
  const created = (await block.json()) as { name: string };
  return created.name.split("/").pop()!;
}

test("an imported block shows its event title instead of Work block", async ({ page }) => {
  const email = newEmail("gcal-title");
  const today = new Date().toISOString().slice(0, 10);
  const blockId = await seedTitledBlock(email, "UTC", `${today}T09:00:00+00:00`, `${today}T10:00:00+00:00`, "Design review");

  await submitAuthForm(page, email, "sign in");
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();

  const block = page.locator(`[data-block="${blockId}"]`);
  await expect(block).toBeVisible();
  await expect(block).toContainText("Design review");
  // The accessible name is what a screen reader announces for the block.
  await expect(block).toHaveAccessibleName(/Design review/);
  await expect(block).not.toContainText("Work block");
});

/* ---------- 4b: the import sheet ---------- */

/**
 * The import flow, with Google stubbed at both of its edges.
 *
 * Nothing here reaches Google. `page.addInitScript` installs the GIS token
 * client the sheet would load from `accounts.google.com`, the gsi script itself
 * is answered by a route that never hits the network, and the two Calendar
 * reads are answered by a route that models paging. The point of stubbing at
 * the network edge rather than at the module is that everything between them is
 * the app's real code: the lazy loader, the token request, the REST client, the
 * mapper and the Firestore write.
 */

/** The OAuth web client id the sheet must hand to Google. Public by design. */
const CLIENT_ID = "698694280142-2dhb6jrkcbua54fl04vnrp1s53vlldas.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const GIS_SCRIPT = "https://accounts.google.com/gsi/client";

type AuthOutcome = "granted" | "closed" | "blocked";

/** One request the sheet made to Google, kept for the assertions. */
type Recorded = { url: URL; authorization: string | undefined };

const dayMs = 86_400_000;

/** A UTC day key `offset` days from today. */
function dayKey(offset = 0): string {
  return new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);
}

/** A timed Google event, with every field the mapper needs. */
function timedEvent(id: string, summary: string, start: string, end: string) {
  return {
    id,
    status: "confirmed",
    summary,
    updated: "2026-10-18T09:00:00.000Z",
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

/**
 * The Google side of one import: the primary calendar answers in two pages
 * (a paged read is a normal read) and holds one timed event with an offset, one
 * all-day event, one cancelled event and one declined invitation; the second
 * calendar holds one timed event and is not selected by default.
 */
function googleFixture() {
  const today = dayKey(0);
  const tomorrow = dayKey(1);
  return {
    today,
    pages: {
      primary: [
        {
          items: [
            timedEvent("evt-design", "Design review", `${today}T10:00:00+00:00`, `${today}T11:00:00+00:00`),
            { id: "evt-cancelled", status: "cancelled", summary: "Cancelled planning", start: { dateTime: `${today}T12:00:00+00:00` }, end: { dateTime: `${today}T13:00:00+00:00` } },
            {
              ...timedEvent("evt-declined", "Declined standup", `${today}T08:00:00+00:00`, `${today}T08:15:00+00:00`),
              attendees: [{ self: true, responseStatus: "declined" }],
            },
          ],
          nextPageToken: "p1",
        },
        {
          items: [
            // All-day: the owner's decision makes it a task with that deadline.
            { id: "evt-tax", summary: "Tax deadline", updated: "2026-10-18T09:00:00.000Z", start: { date: dayKey(3) }, end: { date: dayKey(4) } },
            // A wall time with an offset: the instant the block stores is this one.
            timedEvent("evt-vendor", "Vendor call", `${tomorrow}T15:00:00-03:00`, `${tomorrow}T15:30:00-03:00`),
          ],
        },
      ],
      team: [{ items: [timedEvent("evt-sprint", "Sprint planning", `${tomorrow}T09:00:00+00:00`, `${tomorrow}T10:00:00+00:00`)] }],
    } as Record<string, unknown[]>,
  };
}

/**
 * Installs the GIS stub and the two Calendar routes, and returns the requests
 * the sheet made so a test can assert the window, the paging and the bearer
 * token instead of trusting the counts alone.
 */
async function stubGoogle(
  page: Page,
  options: { pages: Record<string, unknown[]>; auth?: AuthOutcome; calendars?: Array<{ id: string; summary: string; primary?: boolean }> },
): Promise<Recorded[]> {
  const auth = options.auth ?? "granted";
  await page.addInitScript((outcome: string) => {
    type Config = {
      client_id: string;
      scope: string;
      callback: (response: { access_token?: string }) => void;
      error_callback: (error: { type?: string }) => void;
    };
    const scope = window as unknown as {
      google?: unknown;
      __gis?: Record<string, string>;
      __revoked?: string[];
    };
    scope.google = {
      accounts: {
        oauth2: {
          initTokenClient(config: Config) {
            scope.__gis = { client_id: config.client_id, scope: config.scope };
            return {
              requestAccessToken() {
                if (outcome === "closed") config.error_callback({ type: "popup_closed" });
                else if (outcome === "blocked") config.error_callback({ type: "popup_failed_to_open" });
                else config.callback({ access_token: "stub-access-token" });
              },
            };
          },
          /* The sheet hands the token back when it closes; the stub records it
             so a test can prove the revoke instead of trusting the call site. */
          revoke(token: string) {
            (scope.__revoked ??= []).push(token);
          },
        },
      },
    };
  }, auth);
  // The stub above makes the lazy loader short-circuit; this route is the guard
  // that a regression cannot reach Google from a test run.
  await page.route(GIS_SCRIPT, route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "/* stubbed by tests/gcal-import.spec.ts */" }),
  );

  const requests: Recorded[] = [];
  await page.route("https://www.googleapis.com/**", route => {
    const url = new URL(route.request().url());
    requests.push({ url, authorization: route.request().headers()["authorization"] });
    if (url.pathname.endsWith("/calendarList")) {
      return route.fulfill({
        json: {
          items: options.calendars ?? [
            { id: "primary", summary: "Main calendar", primary: true },
            { id: "team", summary: "Team calendar" },
          ],
        },
      });
    }
    const calendar = /\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (!calendar) return route.fulfill({ status: 404, json: { error: { message: "unexpected path" } } });
    const pages = options.pages[decodeURIComponent(calendar[1])] ?? [];
    const token = url.searchParams.get("pageToken");
    // The fixture names its pages p1, p2, ...; no token means the first page.
    const index = token === null ? 0 : Number(token.replace("p", ""));
    return route.fulfill({ json: pages[index] ?? { items: [] } });
  });
  return requests;
}

/** Opens the import sheet from the sidebar entry. */
async function openImportSheet(page: Page) {
  await page.getByRole("button", { name: "Import from Google Calendar" }).click();
  const sheet = page.getByRole("complementary", { name: "Import from Google Calendar" });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The shell's undo toast, if it is up: Imported ... is offered for five seconds. */
async function dismissToast(page: Page) {
  const close = page.locator(".undo-toast").getByRole("button", { name: "Dismiss" });
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".undo-toast")).toHaveCount(0);
}

test("the preview counts what the mapper will write, and a second import writes nothing", async ({ page }) => {
  const email = newEmail("gcal-preview");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const fixture = googleFixture();
  const requests = await stubGoogle(page, { pages: fixture.pages });
  await submitAuthForm(page, email, "sign in");

  let sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();

  /* The primary calendar is preselected, the other one is a checkbox away. */
  await expect(sheet.getByRole("checkbox", { name: "Main calendar" })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: "Team calendar" })).not.toBeChecked();
  await expect(sheet.getByText("2 work blocks and 1 task to import")).toBeVisible();
  await expect(sheet.getByText("Skipped: 1 cancelled, 1 declined.")).toBeVisible();

  /* The request is the one the roadmap asks for: today -> +90 days, expanded,
     ordered, capped at 250, and paged to the last page with the bearer token. */
  const events = requests.filter(request => request.url.pathname.endsWith("/events"));
  expect(events.length, "one page for each half of the paged calendar").toBe(2);
  const first = events[0].url;
  expect(first.searchParams.get("singleEvents")).toBe("true");
  expect(first.searchParams.get("orderBy")).toBe("startTime");
  expect(first.searchParams.get("maxResults")).toBe("250");
  expect(first.searchParams.get("timeMin")).toBe(`${fixture.today}T00:00:00+00:00`);
  expect(first.searchParams.get("timeMax")).toBe(`${dayKey(90)}T00:00:00+00:00`);
  expect(events.some(request => request.url.searchParams.get("pageToken") === "p1")).toBe(true);
  expect(events.every(request => request.authorization === "Bearer stub-access-token")).toBe(true);

  /* The two read-only scopes and the committed client id, as GIS received them. */
  expect(await page.evaluate(() => (window as unknown as { __gis?: Record<string, string> }).__gis)).toEqual({
    client_id: CLIENT_ID,
    scope: SCOPES,
  });

  /* One more calendar is one more checkbox, and the counts follow it. */
  await sheet.getByRole("checkbox", { name: "Team calendar" }).click();
  await expect(sheet.getByText("3 work blocks and 1 task to import")).toBeVisible();

  /* The range is a window, not a label: 30 days is its own request. */
  await sheet.getByRole("radio", { name: "30 days" }).click();
  await expect
    .poll(() => requests.filter(request => request.url.searchParams.get("timeMax") === `${dayKey(30)}T00:00:00+00:00`).length)
    .toBe(3);

  await sheet.getByRole("button", { name: "Import 4 items" }).click();
  const toast = page.locator(".undo-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Imported 3 work blocks and 1 task");
  await expect(page.getByRole("complementary", { name: "Import from Google Calendar" })).toHaveCount(0);

  /* The write itself: titles are the events' summaries, the offset is kept as
     Google sent it, every block records its source, the all-day event is a task
     dated from its first day. */
  const written = await readRemoteImport(email);
  expect(written.blocks.map(block => block.title).sort()).toEqual(["Design review", "Sprint planning", "Vendor call"]);
  expect(written.blocks.every(block => block.source?.provider === "gcal")).toBe(true);
  expect(written.blocks.map(block => block.id).every(id => id.startsWith("gcal_"))).toBe(true);
  expect(written.blocks.find(block => block.title === "Vendor call")?.start).toBe(`${dayKey(1)}T15:00:00-03:00`);
  expect(written.tasks.map(task => [task.title, task.deadline])).toEqual([["Tax deadline", dayKey(3)]]);

  await dismissToast(page);

  /* Re-importing the same window is a no-op: the deterministic ids are already
     stored, so the mapper skips them and the button has nothing to write. */
  sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(sheet.getByText("Nothing new to import.")).toBeVisible();
  await expect(sheet.getByText("Skipped: 1 cancelled, 1 declined, 3 already imported.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Import \d/ })).toBeDisabled();
  const again = await readRemoteImport(email);
  expect(again.blocks.length).toBe(written.blocks.length);
  expect(again.tasks.length).toBe(written.tasks.length);
});

test("a malformed event is counted as unusable, and the valid ones still import", async ({ page }) => {
  const email = newEmail("gcal-unusable");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const today = dayKey(0);
  await stubGoogle(page, {
    pages: {
      primary: [
        {
          items: [
            timedEvent("evt-ok", "Design review", `${today}T10:00:00+00:00`, `${today}T11:00:00+00:00`),
            /* The review's crash cases in one item: a summary that is not text
               and edges that are not objects. The mapper counts it instead of
               throwing, and the sheet says so like any other skip. */
            { id: "evt-malformed", status: "confirmed", summary: 5, updated: "2026-10-18T09:00:00.000Z", start: null, end: null },
          ],
        },
      ],
    },
  });
  await submitAuthForm(page, email, "sign in");

  const sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();

  /* The preview still renders, the app is still up, and the bad item is named as
     a reason rather than silently dropped. The GIS stub still answers with the
     script preloaded on mount. */
  await expect(sheet.getByText("1 work block to import")).toBeVisible();
  await expect(sheet.getByText("Skipped: 1 unusable.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await sheet.getByRole("button", { name: "Import 1 item" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Imported 1 work block");
  const written = await readRemoteImport(email);
  expect(written.blocks.map(block => block.title)).toEqual(["Design review"]);
  expect(written.tasks).toEqual([]);

  /* Closing the sheet hands the token back to Google, and it was never stored. */
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __revoked?: string[] }).__revoked ?? []))
    .toEqual(["stub-access-token"]);
});

test("a closed or blocked Google sign-in says so, imports nothing, and an offline tab says why", async ({ page }) => {
  const email = newEmail("gcal-cancel");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const requests = await stubGoogle(page, { pages: {}, auth: "closed" });
  await submitAuthForm(page, email, "sign in");

  const sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Google sign-in was closed before it finished. Nothing was changed.");
  // A cancelled consent never reaches the Calendar API.
  expect(requests).toEqual([]);
  await expect(sheet).toBeVisible();

  /* Offline the flow is disabled with a reason, not a failing button. */
  await page.context().setOffline(true);
  await expect(sheet.getByText("You are offline. Importing needs a connection.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Connect Google Calendar" })).toBeDisabled();
  await page.context().setOffline(false);
  await expect(sheet.getByRole("button", { name: "Connect Google Calendar" })).toBeEnabled();
});

test("the whole import runs from the keyboard", async ({ page }) => {
  const email = newEmail("gcal-keyboard");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const fixture = googleFixture();
  await stubGoogle(page, { pages: fixture.pages });
  await submitAuthForm(page, email, "sign in");

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("import");
  const command = palette.getByRole("option", { name: "Import from Google Calendar" });
  await expect(command).toBeVisible();
  // The create row comes first by design; the arrows are the way to the command.
  await palette.getByRole("combobox").press("ArrowDown");
  await expect(palette.getByRole("combobox")).toHaveAttribute("aria-activedescendant", "palette-option-action-gcal-import");
  await page.keyboard.press("Enter");

  const sheet = page.getByRole("complementary", { name: "Import from Google Calendar" });
  await expect(sheet).toBeVisible();
  // The panel opens with its primary action focused, so Enter is the flow.
  await expect(sheet.getByRole("button", { name: "Connect Google Calendar" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet.getByRole("button", { name: "Import 3 items" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".undo-toast")).toContainText("Imported 2 work blocks and 1 task");
});

test("on a phone the import lives in the account menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = newEmail("gcal-phone");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const fixture = googleFixture();
  await stubGoogle(page, { pages: fixture.pages });
  await submitAuthForm(page, email, "sign in");

  /* No sidebar at this width, so the same footer action sits in the popover. */
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Account" }).click();
  const entry = page.locator(".popover").getByRole("button", { name: "Import from Google Calendar" });
  await expect(entry).toBeVisible();
  await entry.click();

  const sheet = page.getByRole("complementary", { name: "Import from Google Calendar" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(sheet.getByText("2 work blocks and 1 task to import")).toBeVisible();
  /* The panel fits the phone: nothing sticks out to the side. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await sheet.getByRole("button", { name: "Import 3 items" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Imported 2 work blocks and 1 task");
});

test("remove imported events asks first and deletes only what Google wrote", async ({ page }) => {
  const email = newEmail("gcal-remove");
  const today = dayKey(0);
  await seedTitledBlock(email, "UTC", `${today}T09:00:00+00:00`, `${today}T10:00:00+00:00`, "Design review");
  const uid = await remoteUid(email);
  const task = await fetch(`${FIRESTORE_REST}/users/${uid}/tasks/gcal_seed_tax`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        title: { stringValue: "Tax deadline" },
        completed: { booleanValue: false },
        deadline: { stringValue: today },
      },
    }),
  });
  if (!task.ok) throw new Error(`emulator task set failed: ${task.status} ${await task.text()}`);

  await submitAuthForm(page, email, "sign in");
  const sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Remove imported events (2)" }).click();
  const confirm = sheet.getByRole("group", { name: "Remove imported events" });
  await expect(confirm.getByText("Remove 2 imported items?")).toBeVisible();

  /* Keeping is the default answer: the action is a confirmation, not a switch. */
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(confirm).toHaveCount(0);
  expect((await readRemoteImport(email)).blocks.length).toBe(1);

  await sheet.getByRole("button", { name: "Remove imported events (2)" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(sheet.getByRole("status")).toContainText("Removed 1 work block and 1 task.");
  const after = await readRemoteImport(email);
  expect(after.blocks).toEqual([]);
  expect(after.tasks).toEqual([]);
});

/* ---------- S11: holidays are labels, not tasks ---------- */

const HOLIDAY_CALENDAR = "es.ar#holiday@group.v.calendar.google.com";

/** What the emulator holds under users/{uid}/holidays, read by REST. */
async function readHolidays(email: string): Promise<Array<{ id: string; kind?: string; kindOverride?: string; hidden?: boolean; title?: string; date?: string }>> {
  const uid = await remoteUid(email);
  const response = await fetch(`${FIRESTORE_REST}/users/${uid}/holidays`, { headers: { Authorization: "Bearer owner" } });
  if (!response.ok) throw new Error(`emulator list failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { documents?: Array<{ name: string; fields?: Record<string, { stringValue?: string; booleanValue?: boolean }> }> };
  return (body.documents ?? []).map(document => {
    const fields = document.fields ?? {};
    return {
      id: document.name.split("/").pop()!,
      title: fields.title?.stringValue,
      date: fields.date?.stringValue,
      kind: fields.kind?.stringValue,
      ...(fields.kindOverride === undefined ? {} : { kindOverride: fields.kindOverride.stringValue }),
      ...(fields.hidden === undefined ? {} : { hidden: fields.hidden.booleanValue }),
    };
  });
}

function holidayEvent(id: string, summary: string, description: string, date: string) {
  return { id, status: "confirmed", summary, description, updated: "2026-10-18T09:00:00.000Z", start: { date }, end: { date } };
}

test("holidays import as classified day labels that the user can reclassify and hide", async ({ page }) => {
  const email = newEmail("gcal-holidays");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const today = dayKey(0);
  await stubGoogle(page, {
    calendars: [
      { id: "primary", summary: "Main calendar", primary: true },
      { id: HOLIDAY_CALENDAR, summary: "Holidays in Argentina" },
    ],
    pages: {
      primary: [{ items: [] }],
      [HOLIDAY_CALENDAR]: [
        {
          items: [
            holidayEvent("h-public", "Independence Day", "Public holiday", today),
            holidayEvent("h-obs", "Halloween", "Observance\nTo hide observances, go to Google Calendar Settings > Holidays in Argentina", today),
            holidayEvent("h-bridge", "Puente turístico", "Día no laborable", today),
          ],
        },
      ],
    },
  });
  await submitAuthForm(page, email, "sign in");

  let sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await sheet.getByRole("checkbox", { name: "Holidays in Argentina" }).click();
  await expect(sheet.getByText("3 holiday labels to import")).toBeVisible();
  await sheet.getByRole("button", { name: "Import 3 items" }).click();
  await expect(page.locator(".undo-toast")).toContainText("Imported 3 holiday labels");
  await dismissToast(page);

  // Never tasks or blocks; each holiday stored with the kind the wording gave it.
  const written = await readRemoteImport(email);
  expect(written.tasks).toEqual([]);
  expect(written.blocks).toEqual([]);
  const stored = await readHolidays(email);
  expect(stored.map(item => [item.title, item.kind, item.date]).sort()).toEqual([
    ["Halloween", "observance", today],
    ["Independence Day", "public", today],
    ["Puente turístico", "nonWorking", today],
  ]);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Calendar" }).click();
  const halloween = page.getByRole("button", { name: "Halloween, Observance" });
  await expect(page.getByRole("button", { name: "Independence Day, Public holiday" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Puente turístico, Non-working day" })).toBeVisible();

  // Reclassify: the override is stored and wins on screen.
  await halloween.click();
  const holidaySheet = page.getByRole("complementary", { name: "Holiday" });
  await holidaySheet.getByRole("button", { name: "Non-working day" }).click();
  await expect(page.getByRole("button", { name: "Halloween, Non-working day" })).toBeVisible();
  await expect.poll(async () => (await readHolidays(email)).find(item => item.title === "Halloween")?.kindOverride).toBe("nonWorking");

  // A re-import writes nothing new and leaves the override alone.
  await holidaySheet.getByRole("button", { name: "Close" }).click();
  await expect(holidaySheet).toHaveCount(0);
  sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await sheet.getByRole("checkbox", { name: "Holidays in Argentina" }).click();
  await expect(sheet.getByText("Nothing new to import.")).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  expect((await readHolidays(email)).find(item => item.title === "Halloween")?.kindOverride).toBe("nonWorking");

  // Hide: the label leaves the calendar and the document keeps the flag.
  await page.getByRole("button", { name: "Independence Day, Public holiday" }).click();
  await page.getByRole("complementary", { name: "Holiday" }).getByRole("button", { name: "Hide this holiday" }).click();
  await expect(page.getByRole("button", { name: "Independence Day, Public holiday" })).toHaveCount(0);
  await expect.poll(async () => (await readHolidays(email)).find(item => item.title === "Independence Day")?.hidden).toBe(true);
});

test("holiday tasks from an earlier import are offered for cleanup, and only they are deleted", async ({ page }) => {
  const email = newEmail("gcal-cleanup");
  await createRemoteAccount(email);
  await updateRemoteProfile(email, "UTC");
  const uid = await remoteUid(email);
  const date = dayKey(2);
  const holidayTask = `gcal_${calendarKey(HOLIDAY_CALENDAR)}_h-bridge`;
  const normalTask = `gcal_${calendarKey("team")}_evt-same-title`;
  const seed = async (id: string, title: string) => {
    const response = await fetch(`${FIRESTORE_REST}/users/${uid}/tasks/${id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { title: { stringValue: title }, completed: { booleanValue: false }, deadline: { stringValue: date } } }),
    });
    if (!response.ok) throw new Error(`seed failed: ${response.status} ${await response.text()}`);
  };
  await seed(holidayTask, "Puente turístico");
  await seed(normalTask, "Puente turístico");
  await seed("userTaskSameTitle0001", "Puente turístico");
  await stubGoogle(page, {
    calendars: [
      { id: "primary", summary: "Main calendar", primary: true },
      { id: "team", summary: "Team calendar" },
      { id: HOLIDAY_CALENDAR, summary: "Holidays in Argentina" },
    ],
    pages: { primary: [{ items: [] }], [HOLIDAY_CALENDAR]: [{ items: [holidayEvent("h-bridge", "Puente turístico", "Día no laborable", date)] }] },
  });
  await submitAuthForm(page, email, "sign in");

  const sheet = await openImportSheet(page);
  await sheet.getByRole("button", { name: "Connect Google Calendar" }).click();
  await sheet.getByRole("checkbox", { name: "Holidays in Argentina" }).click();
  // The count is shown before anything is deleted: one task, not the three with the same title.
  await sheet.getByRole("button", { name: "Clean up holiday tasks (1)" }).click();
  const confirm = sheet.getByRole("group", { name: "Clean up holiday tasks" });
  await expect(confirm).toContainText("Delete 1 task");
  await confirm.getByRole("button", { name: "Keep" }).click();
  expect((await readRemoteImport(email)).tasks.length).toBe(3);
  expect(await readHolidays(email)).toEqual([]);

  await sheet.getByRole("button", { name: "Clean up holiday tasks (1)" }).click();
  await confirm.getByRole("button", { name: "Clean up" }).click();
  await expect(sheet.getByText("Replaced 1 holiday task with holiday labels.")).toBeVisible();

  await expect.poll(async () => (await readRemoteImport(email)).tasks.map(task => task.id).sort()).toEqual([normalTask, "userTaskSameTitle0001"].sort());
  const labels = await readHolidays(email);
  expect(labels.map(label => [label.id, label.date, label.title, label.kind])).toEqual([[holidayTask, date, "Puente turístico", "nonWorking"]]);
  await expect(sheet.getByRole("button", { name: /Clean up holiday tasks/ })).toHaveCount(0);
});

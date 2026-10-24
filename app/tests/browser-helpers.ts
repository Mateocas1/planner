import { expect, type Page } from "@playwright/test";

/**
 * Browser-test helpers that touch the Auth and Firestore emulators.
 *
 * Everything here uses direct REST calls against the emulators: no Firebase
 * SDK is loaded in Node and no sign-in is ever performed from this side of the
 * harness. Firestore REST reads are true server reads (no client cache), so
 * the forced-server semantics the assertions rely on are preserved.
 */

const AUTH_EMULATOR = "http://127.0.0.1:9199";
const PROJECT_ID = "demo-calendar-app";
const FIRESTORE_REST =
  "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";

export const password = "local-emulator-password";

/** The emulator's Identity Toolkit base: the SDK's requests, and this harness's. */
const AUTH_EMULATOR_API = `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1`;

/**
 * A budget for a wait on the emulator, not on the app.
 *
 * A sign-in, or restoring a session after a reload, is a request to the Auth
 * emulator plus the SDK's account lookup. A loaded host measured both past the
 * 10 s a default expectation gets -- this suite has failed exactly there -- so
 * every server wait uses this budget and the assertion itself stays unchanged.
 */
const SERVER_WAIT = 15_000;

/* ---------- Auth emulator REST (no sign-in) ---------- */

/** email -> localId, cached per run; createRemoteAccount fills it directly. */
let accountCache: Map<string, string> | null = null;

async function fetchAccounts(): Promise<Map<string, string>> {
  const accounts = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:batchGet`,
    );
    url.searchParams.set("key", "local-only");
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("nextPageToken", pageToken);
    const response = await fetch(url, { headers: { Authorization: "Bearer owner" } });
    if (!response.ok) {
      throw new Error(`emulator accounts:batchGet failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      users?: Array<{ localId?: string; email?: string }>;
      nextPageToken?: string;
    };
    for (const user of body.users ?? []) {
      if (user.localId && user.email) accounts.set(user.email, user.localId);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return accounts;
}

/** Resolves a uid from the email without ever signing in. */
async function resolveRemoteUid(email: string): Promise<string> {
  if (!accountCache) accountCache = await fetchAccounts();
  let uid = accountCache.get(email);
  if (uid) return uid;
  // The cache may predate an account created moments ago: refresh once
  // before failing, so the suite never flakes on a stale snapshot.
  accountCache = await fetchAccounts();
  uid = accountCache.get(email);
  if (!uid) throw new Error(`no Auth emulator account found for ${email}`);
  return uid;
}

/**
 * Creates the Auth account directly on the emulator (REST signUp) without
 * signing any browser session in, so tests can pre-seed server state before
 * the app under test ever runs for that user.
 */
export async function createRemoteAccount(email: string): Promise<void> {
  const response = await fetch(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-only`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`emulator signUp failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { localId?: string };
  if (!accountCache) accountCache = new Map();
  if (body.localId) accountCache.set(email, body.localId);
}

/* ---------- Firestore emulator REST ---------- */

/** The subset of Firestore REST typed values this harness writes and reads. */
type RestValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { mapValue: { fields?: Record<string, { integerValue?: string; doubleValue?: number }> } };
type RestFields = Record<string, RestValue>;
type RestDocument = { name: string; fields?: RestFields };

function encodeFields(data: Record<string, string | boolean>): RestFields {
  const fields: RestFields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
  }
  return fields;
}

function decodeMinuteMap(map: { fields?: Record<string, { integerValue?: string; doubleValue?: number }> }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [day, entry] of Object.entries(map.fields ?? {})) {
    out[day] = entry.integerValue !== undefined ? Number(entry.integerValue) : Number(entry.doubleValue);
  }
  return out;
}

function decodeDocument(document: RestDocument): { id: string; data: RemoteData } {
  const data: RemoteData = {};
  for (const [key, value] of Object.entries(document.fields ?? {})) {
    if ("stringValue" in value) data[key] = value.stringValue;
    else if ("booleanValue" in value) data[key] = value.booleanValue;
    // `estimate` is stored as an integer minute count; the harness reads it
    // back as the number the domain wrote, not as a string.
    else if ("integerValue" in value) data[key] = Number(value.integerValue);
    else if ("doubleValue" in value) data[key] = value.doubleValue;
    // `actualByDay` (W2c) is a map of day key → whole minutes.
    else if ("mapValue" in value) data[key] = decodeMinuteMap(value.mapValue);
    else throw new Error(`unsupported Firestore REST value for ${key}: ${JSON.stringify(value)}`);
  }
  // The document id is the last segment of the full resource name.
  return { id: document.name.split("/").pop()!, data };
}

async function firestoreFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${FIRESTORE_REST}/${path}`, {
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    ...init,
  });
}

async function listRemoteDocs(uid: string, kind: "tasks" | "blocks" | "series" | "completions") {
  const response = await firestoreFetch(`users/${uid}/${kind}`);
  if (!response.ok) {
    throw new Error(`emulator list failed: ${response.status} ${await response.text()}`);
  }
  // An empty collection returns {} with no "documents" key.
  const body = (await response.json()) as { documents?: RestDocument[] };
  return (body.documents ?? []).map(decodeDocument);
}

/** Creates a document with a server-generated id and returns that id. */
async function addRemoteDoc(uid: string, kind: "tasks" | "blocks" | "series", data: Record<string, string | boolean>) {
  const response = await firestoreFetch(`users/${uid}/${kind}`, {
    method: "POST",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!response.ok) {
    throw new Error(`emulator add failed: ${response.status} ${await response.text()}`);
  }
  return decodeDocument(await response.json()).id;
}

/** A field the typed encoder above cannot write: integer minute counts. */
type WriteValue = string | boolean | number;

function encodeWriteFields(data: Record<string, WriteValue>): RestFields {
  const fields: RestFields = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number") fields[key] = { integerValue: String(value) };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
    else fields[key] = { stringValue: value };
  }
  return fields;
}

/** Creates a task document that carries minute counts as well as text. */
async function addRemoteTaskWithMinutes(uid: string, data: Record<string, WriteValue>): Promise<string> {
  const response = await firestoreFetch(`users/${uid}/tasks`, {
    method: "POST",
    body: JSON.stringify({ fields: encodeWriteFields(data) }),
  });
  if (!response.ok) {
    throw new Error(`emulator add failed: ${response.status} ${await response.text()}`);
  }
  return decodeDocument(await response.json()).id;
}

/** Creates or replaces an explicitly-addressed document (setDoc semantics). */
async function setRemoteDoc(uid: string, path: string, data: Record<string, string | boolean>) {
  const response = await firestoreFetch(`users/${uid}/${path}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!response.ok) {
    throw new Error(`emulator set failed: ${response.status} ${await response.text()}`);
  }
}

/** Reads one document; a 404 maps to undefined (absent), not an error. */
async function getRemoteDoc(uid: string, path: string) {
  const response = await firestoreFetch(`users/${uid}/${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`emulator get failed: ${response.status} ${await response.text()}`);
  }
  return decodeDocument(await response.json()).data;
}

/* ---------- Helpers (exported API unchanged) ---------- */

/**
 * Adds tasks to an account that already exists (the sign-up is what creates
 * it), so a test that walks rows with the keyboard seeds them in one call
 * instead of opening the creation sheet once per row.
 */
export async function seedTasks(email: string, tasks: Array<{ title: string; deadline?: string }>): Promise<void> {
  const uid = await resolveRemoteUid(email);
  for (const task of tasks) {
    await addRemoteDoc(uid, "tasks", { title: task.title, ...(task.deadline === undefined ? {} : { deadline: task.deadline }) });
  }
}

export async function seedTaskAndBlock(email: string, title: string, start: string, end: string) {
  const uid = await resolveRemoteUid(email);
  const taskId = await addRemoteDoc(uid, "tasks", { title });
  const blockId = await addRemoteDoc(uid, "blocks", { start, end });
  return { taskId, blockId };
}

export async function readRemoteState(email: string) {
  const uid = await resolveRemoteUid(email);
  const [tasks, blocks] = await Promise.all([listRemoteDocs(uid, "tasks"), listRemoteDocs(uid, "blocks")]);
  return {
    taskTitles: tasks.map(doc => doc.data.title as string).sort(),
    blockStarts: blocks.map(doc => doc.data.start as string).sort(),
  };
}

export async function readRemoteBlocks(email: string): Promise<Array<{ start: string; end: string; taskId?: string }>> {
  const uid = await resolveRemoteUid(email);
  const blocks = await listRemoteDocs(uid, "blocks");
  return blocks.map(doc => doc.data as { start: string; end: string; taskId?: string });
}

export async function readRemoteTasks(email: string) {
  const uid = await resolveRemoteUid(email);
  const tasks = await listRemoteDocs(uid, "tasks");
  return tasks.map(doc => doc.data);
}

/** A Firestore REST field, as far as an imported document uses one. */
type RawField = { stringValue?: string; booleanValue?: boolean; mapValue?: { fields?: Record<string, RawField> } };

/**
 * The documents a Google Calendar import wrote, read raw.
 *
 * Unlike the typed readers above this one does not decode: an imported block
 * carries a nested `source` map, which is exactly the shape the typed encoder
 * refuses on purpose. The import tests need the write itself -- the block's
 * title and its gcal source, the task's deadline and its deterministic id -- so
 * they read what the server holds, not a rendering of it.
 */
export async function readRemoteImport(email: string): Promise<{
  blocks: Array<{ id: string; title?: string; start?: string; end?: string; source?: { provider?: string; eventId?: string; calendarId?: string } }>;
  tasks: Array<{ id: string; title?: string; deadline?: string; completed?: boolean }>;
}> {
  const uid = await resolveRemoteUid(email);
  const read = async (kind: "blocks" | "tasks") => {
    const response = await firestoreFetch(`users/${uid}/${kind}`);
    if (!response.ok) {
      throw new Error(`emulator list failed: ${response.status} ${await response.text()}`);
    }
    // An empty collection returns {} with no "documents" key.
    const body = (await response.json()) as { documents?: Array<{ name: string; fields?: Record<string, RawField> }> };
    return (body.documents ?? []).map(document => {
      const fields = document.fields ?? {};
      const text = (key: string) => fields[key]?.stringValue;
      const source = fields.source?.mapValue?.fields;
      return {
        id: document.name.split("/").pop()!,
        ...(text("title") === undefined ? {} : { title: text("title") }),
        ...(text("start") === undefined ? {} : { start: text("start") }),
        ...(text("end") === undefined ? {} : { end: text("end") }),
        ...(text("deadline") === undefined ? {} : { deadline: text("deadline") }),
        ...(fields.completed === undefined ? {} : { completed: fields.completed.booleanValue }),
        ...(source === undefined
          ? {}
          : {
              source: {
                provider: source.provider?.stringValue,
                eventId: source.eventId?.stringValue,
                calendarId: source.calendarId?.stringValue,
              },
            }),
      };
    });
  };
  const [blocks, tasks] = await Promise.all([read("blocks"), read("tasks")]);
  return { blocks, tasks };
}

/**
 * Seeds the profile time zone and the tasks the estimate learner reads (F2b).
 *
 * Unlike `seedSidebarFixture`, these tasks carry numbers: the estimate and the
 * minutes the focus timer recorded. Both are written as Firestore integers,
 * which is the shape `addActualMinutes` increments, so the browser suite reads
 * back what the app itself would have written.
 */
export async function seedTrackedTasks(
  email: string,
  timeZone: string,
  tasks: Array<{ title: string; estimate?: number; actualMinutes?: number; completed?: boolean; deadline?: string }>,
): Promise<{ taskIds: Record<string, string> }> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
  const taskIds: Record<string, string> = {};
  for (const task of tasks) {
    taskIds[task.title] = await addRemoteTaskWithMinutes(uid, {
      title: task.title,
      completed: task.completed ?? false,
      ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
      ...(task.estimate === undefined ? {} : { estimate: task.estimate }),
      ...(task.actualMinutes === undefined ? {} : { actualMinutes: task.actualMinutes }),
    });
  }
  return { taskIds };
}

/**
 * The focus session a desktop restores on load (see useFocusTimer's
 * `planner-focus`), so a test can state "this session began n minutes ago"
 * instead of waiting for the clock or freezing it: the timer recomputes
 * everything from these instants.
 */
export function storedFocusSession(input: { blockId: string; taskId?: string; startedMinutesAgo: number; endsInMinutes: number }): string {
  const now = Date.now();
  return JSON.stringify({
    blockId: input.blockId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    endAt: now + input.endsInMinutes * 60_000,
    startedAt: now - input.startedMinutesAgo * 60_000,
    pausedMs: 0,
  });
}

/** Seeds the profile timezone and one work block before the user is ever signed in. */
export async function seedProfileAndBlock(email: string, timeZone: string, start: string, end: string): Promise<void> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
  await addRemoteDoc(uid, "blocks", { start, end });
}

/**
 * Seeds the account and its profile timezone, and nothing else, so a test that
 * only reads `/` text (the quick-add grammar) still runs in a pinned zone.
 */
export async function seedProfile(email: string, timeZone: string): Promise<void> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
}

export async function updateRemoteProfile(email: string, timeZone: string): Promise<void> {
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
}

export async function readRemoteProfile(email: string): Promise<{ timeZone?: string }> {
  const uid = await resolveRemoteUid(email);
  const data = await getRemoteDoc(uid, "profile/main");
  return (data as { timeZone?: string } | undefined) ?? {};
}

/* ---------- day settings (tests/day-settings.spec.ts) ---------- */

/** The day-settings fields of one profile document, as the server holds them. */
export type RemoteDaySettings = {
  timeZone: string | null;
  workStart: number | null;
  workEnd: number | null;
  shutdownTime: number | null;
  shortcutsEnabled: boolean | null;
};

const emptyDaySettings: RemoteDaySettings = { timeZone: null, workStart: null, workEnd: null, shutdownTime: null, shortcutsEnabled: null };

/**
 * Seeds the profile document with a day-settings fixture before the browser
 * signs anything in. Times are written as strings because that is the encoding
 * this harness can write and the app's readers accept both encodings; the app
 * itself writes numbers, which is why the reader below decodes them too.
 */
export async function seedDaySettings(
  email: string,
  settings: { timeZone?: string; workStart?: number; workEnd?: number; shutdownTime?: number; shortcutsEnabled?: boolean } = {},
): Promise<void> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  const fields: Record<string, string | boolean> = {};
  if (settings.timeZone !== undefined) fields.timeZone = settings.timeZone;
  if (settings.workStart !== undefined) fields.workStart = String(settings.workStart);
  if (settings.workEnd !== undefined) fields.workEnd = String(settings.workEnd);
  if (settings.shutdownTime !== undefined) fields.shutdownTime = String(settings.shutdownTime);
  if (settings.shortcutsEnabled !== undefined) fields.shortcutsEnabled = settings.shortcutsEnabled;
  await setRemoteDoc(uid, "profile/main", fields);
}

/**
 * Reads the day settings back from the server, decoding both encodings: this
 * harness seeds minutes as strings and the app writes them as integers.
 */
export async function readRemoteDaySettings(email: string): Promise<RemoteDaySettings> {
  const uid = await resolveRemoteUid(email);
  const response = await firestoreFetch(`users/${uid}/profile/main`);
  if (response.status === 404) return { ...emptyDaySettings };
  if (!response.ok) {
    throw new Error(`emulator get failed: ${response.status} ${await response.text()}`);
  }
  type NumberField = { integerValue?: string; doubleValue?: number; stringValue?: string; booleanValue?: boolean };
  const body = (await response.json()) as { fields?: Record<string, NumberField> };
  const fields = body.fields ?? {};
  const minutes = (key: string): number | null => {
    const raw = fields[key];
    if (!raw) return null;
    if (raw.integerValue !== undefined) return Number(raw.integerValue);
    if (raw.doubleValue !== undefined) return raw.doubleValue;
    if (raw.stringValue !== undefined) {
      const parsed = Number(raw.stringValue);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  return {
    timeZone: fields.timeZone?.stringValue ?? null,
    workStart: minutes("workStart"),
    workEnd: minutes("workEnd"),
    shutdownTime: minutes("shutdownTime"),
    shortcutsEnabled: fields.shortcutsEnabled?.booleanValue ?? null,
  };
}

/** Reads every series definition, keeping the generated id next to its fields. */
/**
 * Series definitions as the app stores them. Every field a series carried
 * before estimates existed is a string; `estimate`, when present, is a number
 * (see decodeDocument), so consumers that need it read it as the number the
 * domain wrote rather than through this legacy string map.
 */
/** A stored document's fields as the emulator reports them. */
export type RemoteData = Record<string, string | boolean | number | Record<string, number>>;

export async function readRemoteSeries(email: string): Promise<Array<{ id: string; data: RemoteData }>> {
  const uid = await resolveRemoteUid(email);
  const series = await listRemoteDocs(uid, "series");
  return series.map(doc => ({ id: doc.id, data: doc.data }));
}

/** Reads every completion record exactly as the domain builds it. */
export async function readRemoteCompletions(email: string): Promise<Array<{ occurrenceId: string; completedAt: string }>> {
  const uid = await resolveRemoteUid(email);
  const completions = await listRemoteDocs(uid, "completions");
  return completions.map(doc => doc.data as { occurrenceId: string; completedAt: string });
}

/* ---------- Signing in through the real form ---------- */

/** The signed-in shell: the app's own signal that a session is established. */
const signedInShell = (page: Page, email: string) => page.getByText(`Signed in as ${email}`);

/**
 * Waits for the signed-in shell with the emulator's budget, for the paths that
 * establish a session without this harness' form: restoring it after a reload.
 * See SERVER_WAIT.
 */
export async function expectSignedIn(page: Page, email: string) {
  await expect(signedInShell(page, email)).toBeVisible({ timeout: SERVER_WAIT });
}

/**
 * Whether the Auth emulator accepts an ID token it would mint right now.
 *
 * `accounts:signInWithPassword` mints a token stamped with the emulator's clock,
 * and the `accounts:lookup` after it re-parses that token exactly as the failed
 * sign-in did: `firebase-tools/lib/emulator/auth/operations.js` asserts
 * `iat >= user.validSince` and reports `TOKEN_EXPIRED`. Both stamps are whole
 * seconds (`utils.toUnixTimestamp`), which is what makes the artifact below
 * possible and what makes this probe the exact check to wait on.
 */
async function emulatorAcceptsFreshToken(email: string): Promise<boolean> {
  const minted = await fetch(`${AUTH_EMULATOR_API}/accounts:signInWithPassword?key=local-only`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!minted.ok) {
    throw new Error(`emulator signInWithPassword failed: ${minted.status} ${await minted.text()}`);
  }
  const { idToken } = (await minted.json()) as { idToken?: string };
  if (!idToken) throw new Error(`emulator signInWithPassword returned no idToken for ${email}`);
  const looked = await fetch(`${AUTH_EMULATOR_API}/accounts:lookup?key=local-only`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  const body = (await looked.json()) as { error?: { message?: string } };
  return looked.ok && body.error === undefined;
}

/**
 * Signs a fresh account up, or an existing one in, through the app's own form,
 * and waits for the signed-in shell.
 *
 * The recovery below covers one artifact of the local Auth emulator, never app
 * behaviour. `firebase-tools/lib/emulator/auth/operations.js` asserts
 * `decoded.payload.iat >= user.validSince` and reports `TOKEN_EXPIRED`; the
 * emulator stamps `validSince` while it creates the account and `iat` when it
 * signs the token a moment later, so if the host clock steps *backwards*
 * between the two stamps it rejects the token it just issued and the SDK's
 * post-sign-in account lookup fails with `auth/user-token-expired`. WSL2 on this
 * host steps its clock back 0.25-1.3 s roughly every 15-30 s (measured with a
 * 2 ms `Date.now()` sampler), and a sign-up under load takes long enough for
 * both stamps to straddle a step.
 *
 * Re-submitting at once is *not* a recovery, and that was this suite's residual
 * flake: after the step the host clock is still behind the instant `validSince`
 * was stamped, so the token the second attempt mints is rejected the same way,
 * the page keeps the artifact and the shell never arrives -- measured on this
 * host as `quick-add`, `responsive`, `day-settings` and `sync-status` failures,
 * all at this function, with `auth/user-token-expired` on screen. So the wait
 * below asks the emulator whether a token minted *now* is accepted, and only
 * then re-submits once: once the clock is past the step, any later token passes
 * too. Every other error still fails the test.
 */
export async function submitAuthForm(
  page: Page,
  email: string,
  kind: "sign up" | "sign in",
  /* A test that serves the built app itself (the update prompt) signs in on its
     own origin; everything else signs in on the suite's preview server. */
  options: { url?: string } = {},
) {
  await page.goto(options.url ?? "/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  const submit = page.getByRole("button", {
    name: kind === "sign up" ? "Create account" : "Sign in",
    exact: kind === "sign in",
  });
  await submit.click();
  const shell = signedInShell(page, email);
  const clockArtifact = page.getByRole("alert").filter({ hasText: "auth/user-token-expired" });
  await expect(shell.or(clockArtifact)).toBeVisible({ timeout: SERVER_WAIT });
  if (await clockArtifact.isVisible()) {
    // The backwards step that caused the artifact is still in effect for as long
    // as the host clock is behind the stamped second; wait it out observably.
    await expect
      .poll(() => emulatorAcceptsFreshToken(email), {
        message: "the Auth emulator accepts a token minted now, so the retry cannot be rejected",
        timeout: SERVER_WAIT,
        intervals: [100, 200, 400, 800],
      })
      .toBe(true);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(shell).toBeVisible({ timeout: SERVER_WAIT });
}

/* ---------- Sidebar fixture (tests/sidebar.spec.ts) ---------- */

/**
 * Seeds one account for the sidebar assertions: the profile time zone, the open
 * tasks with their deadlines, and the work blocks, all before the browser signs
 * in. A block names its task by title, so a test never has to seed twice.
 */
export async function seedSidebarFixture(
  email: string,
  timeZone: string,
  fixture: {
    tasks?: Array<{ title: string; deadline?: string; completed?: boolean }>;
    blocks?: Array<{ start: string; end: string; task?: string }>;
  } = {},
): Promise<{ taskIds: Record<string, string> }> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
  const taskIds: Record<string, string> = {};
  for (const task of fixture.tasks ?? []) {
    taskIds[task.title] = await addRemoteDoc(uid, "tasks", {
      title: task.title,
      completed: task.completed ?? false,
      ...(task.deadline ? { deadline: task.deadline } : {}),
    });
  }
  for (const block of fixture.blocks ?? []) {
    const taskId = block.task === undefined ? undefined : taskIds[block.task];
    if (block.task !== undefined && taskId === undefined) {
      throw new Error(`seedSidebarFixture: block names unknown task ${block.task}`);
    }
    await addRemoteDoc(uid, "blocks", { start: block.start, end: block.end, ...(taskId ? { taskId } : {}) });
  }
  return { taskIds };
}

/**
 * The effective hit area of a control: its own box, widened by the `::before`
 * it may carry, probed with `elementFromPoint` so a target that exists only in
 * CSS is not taken on faith. `misses` counts the eight points on a circle of
 * radius `min / 2` around the control that do not land on it.
 */
export async function hitArea(page: Page, selector: string, min = 44) {
  return page.evaluate(
    ({ selector: sel, min: size }) => {
      const element = document.querySelector<HTMLElement>(sel);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = size / 2 - 0.5;
      const misses = Array.from({ length: 8 }, (_, index) => {
        const angle = (index * Math.PI) / 4;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const hit = document.elementFromPoint(x, y);
        return !hit || !(hit === element || element.contains(hit));
      }).filter(Boolean).length;
      return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10, misses };
    },
    { selector, min },
  );
}

/* ---------- Responsive fixture (tests/responsive.spec.ts) ---------- */

/** A wall-clock day key in `timeZone`, independent of the browser's own zone. */
function dayKeyIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => Number(parts.find(entry => entry.type === type)!.value);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${part("year")}-${pad(part("month"))}-${pad(part("day"))}`;
}

/** `key` moved by `days` weekday-agnostic days, as a day key. */
function addDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Seeds the content the responsive assertions measure: titles long enough to
 * truncate at 320 px (one of them a single unbreakable token), a deadline today
 * and one overdue -- the widest and the narrowest `.row-meta` -- two repeating
 * tasks, and blocks on today at 09:00, 11:00 and 20:00, the last one only 30
 * minutes long so a zoomed label has to clip.
 *
 * The profile time zone is seeded with it, so the calendar renders this week in
 * `timeZone` whatever zone the emulator host believes it is in.
 */
export async function seedResponsiveFixture(email: string, timeZone: string): Promise<void> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
  const today = dayKeyIn(timeZone, new Date());
  const tasks: Array<{ title: string; deadline?: string; completed?: boolean }> = [
    { title: "Prepare the quarterly roadmap review with design and engineering leads", deadline: today },
    { title: "Follow up with the accountant about the Q3 invoices and the withholding form", deadline: addDays(today, -1) },
    { title: "Book the dentist appointment for the molar that has been hurting since Tuesday" },
    { title: "Supercalifragilisticexpialidociousness_and_an_unbreakable_token_that_never_wraps" },
    { title: "Rewrite the onboarding copy so a first-time user understands the product", deadline: addDays(today, 3) },
  ];
  const ids = new Map<string, string>();
  for (const task of tasks) {
    const id = await addRemoteDoc(uid, "tasks", {
      title: task.title,
      completed: task.completed ?? false,
      ...(task.deadline ? { deadline: task.deadline } : {}),
    });
    ids.set(task.title, id);
  }
  await addRemoteDoc(uid, "series", { title: "Weekly planning with the whole team", frequency: "weekly", anchorDate: today });
  await addRemoteDoc(uid, "series", { title: "Morning stretch", frequency: "daily", anchorDate: today });
  const offset = "-03:00";
  const blocks: Array<{ start: string; end: string; taskId?: string }> = [
    { start: `${today}T09:00:00${offset}`, end: `${today}T10:30:00${offset}`, taskId: ids.get(tasks[0].title) },
    { start: `${today}T11:00:00${offset}`, end: `${today}T12:00:00${offset}` },
    { start: `${today}T20:00:00${offset}`, end: `${today}T20:30:00${offset}`, taskId: ids.get(tasks[3].title) },
  ];
  for (const block of blocks) {
    await addRemoteDoc(uid, "blocks", { start: block.start, end: block.end, ...(block.taskId ? { taskId: block.taskId } : {}) });
  }
}

/* ---------- Radar fixture (tests/radar.spec.ts) ---------- */

/**
 * Writes one document whose fields are already typed REST values.
 *
 * `addRemoteDoc` above encodes strings and booleans only, which is all the
 * older fixtures needed. The radar reads `estimate`, which the domain stores as
 * an integer minute count: writing it here as a string would make the app's own
 * reader reject it (`parseEstimate` accepts numbers only) and the fixture would
 * quietly test the absence of an estimate instead of its value.
 */
async function addRemoteTypedDoc(uid: string, kind: "tasks" | "blocks" | "series", fields: RestFields): Promise<string> {
  const response = await firestoreFetch(`users/${uid}/${kind}`, {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`emulator add failed: ${response.status} ${await response.text()}`);
  }
  return decodeDocument(await response.json()).id;
}

/**
 * Seeds one planner week for the overcommit radar: the profile zone, open tasks
 * with their deadlines and estimates, work blocks, and repeating series, all
 * before the browser signs in.
 *
 * Unlike the sidebar fixture this one writes real integer estimates, because the
 * radar's whole arithmetic is about them: an assumed 60 minutes and a stored
 * value have to be distinguishable from the rendered surface. A block names its
 * task by title so a test never has to seed twice.
 */
export async function seedRadarFixture(
  email: string,
  timeZone: string,
  fixture: {
    tasks?: Array<{ title: string; deadline?: string; completed?: boolean; estimate?: number }>;
    blocks?: Array<{ start: string; end: string; task?: string }>;
    series?: Array<{ title: string; frequency: "daily" | "weekly" | "monthly"; anchorDate: string; estimate?: number }>;
  } = {},
): Promise<{ taskIds: Record<string, string> }> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  await setRemoteDoc(uid, "profile/main", { timeZone });
  const taskIds: Record<string, string> = {};
  for (const task of fixture.tasks ?? []) {
    taskIds[task.title] = await addRemoteTypedDoc(uid, "tasks", {
      title: { stringValue: task.title },
      completed: { booleanValue: task.completed ?? false },
      ...(task.deadline === undefined ? {} : { deadline: { stringValue: task.deadline } }),
      ...(task.estimate === undefined ? {} : { estimate: { integerValue: String(task.estimate) } }),
    });
  }
  for (const block of fixture.blocks ?? []) {
    const taskId = block.task === undefined ? undefined : taskIds[block.task];
    if (block.task !== undefined && taskId === undefined) {
      throw new Error(`seedRadarFixture: block names unknown task ${block.task}`);
    }
    await addRemoteTypedDoc(uid, "blocks", {
      start: { stringValue: block.start },
      end: { stringValue: block.end },
      ...(taskId ? { taskId: { stringValue: taskId } } : {}),
    });
  }
  for (const series of fixture.series ?? []) {
    await addRemoteTypedDoc(uid, "series", {
      title: { stringValue: series.title },
      frequency: { stringValue: series.frequency },
      anchorDate: { stringValue: series.anchorDate },
      ...(series.estimate === undefined ? {} : { estimate: { integerValue: String(series.estimate) } }),
    });
  }
  return { taskIds };
}

/* ---------- Shutdown ritual fixture (tests/shutdown-ritual.spec.ts) ---------- */

/**
 * Seeds one account for the shutdown ritual (F3c): the profile's zone, its
 * shutdown time and the day it was last closed, plus the tasks and work blocks
 * that make a day, all before the browser signs in.
 *
 * `shutdownTime` is written as a string because that is the encoding this
 * harness can write; the app's own reader (`parseShutdownTime`) accepts both,
 * and the app writes integers. A block names its task by title, so a test never
 * has to seed twice.
 */
export async function seedShutdownFixture(
  email: string,
  timeZone: string,
  fixture: {
    shutdownTime?: number;
    lastShutdown?: string;
    tasks?: Array<{ title: string; deadline?: string; completed?: boolean; completedAt?: string }>;
    blocks?: Array<{ start: string; end: string; task?: string }>;
  } = {},
): Promise<{ taskIds: Record<string, string> }> {
  await createRemoteAccount(email);
  const uid = await resolveRemoteUid(email);
  const profile: Record<string, string> = { timeZone };
  if (fixture.shutdownTime !== undefined) profile.shutdownTime = String(fixture.shutdownTime);
  if (fixture.lastShutdown !== undefined) profile.lastShutdown = fixture.lastShutdown;
  await setRemoteDoc(uid, "profile/main", profile);
  const taskIds: Record<string, string> = {};
  for (const task of fixture.tasks ?? []) {
    taskIds[task.title] = await addRemoteDoc(uid, "tasks", {
      title: task.title,
      completed: task.completed ?? false,
      ...(task.deadline ? { deadline: task.deadline } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    });
  }
  for (const block of fixture.blocks ?? []) {
    const taskId = block.task === undefined ? undefined : taskIds[block.task];
    if (block.task !== undefined && taskId === undefined) {
      throw new Error(`seedShutdownFixture: block names unknown task ${block.task}`);
    }
    await addRemoteDoc(uid, "blocks", { start: block.start, end: block.end, ...(taskId ? { taskId } : {}) });
  }
  return { taskIds };
}

/**
 * What the ritual's batch wrote, read from the server: each task's deadline by
 * title, and the profile's `lastShutdown` stamp. This is the assertion the roll
 * is about -- which deadlines moved, which did not, and whether the day is
 * marked closed -- and it reads the server, never the app's own state.
 */
export async function readRemoteShutdown(
  email: string,
): Promise<{ deadlines: Record<string, string | undefined>; completedAt: Record<string, string | undefined>; lastShutdown?: string }> {
  const uid = await resolveRemoteUid(email);
  const [tasks, profile] = await Promise.all([listRemoteDocs(uid, "tasks"), getRemoteDoc(uid, "profile/main")]);
  const deadlines: Record<string, string | undefined> = {};
  const completedAt: Record<string, string | undefined> = {};
  for (const doc of tasks) {
    if (doc.data.title === undefined) continue;
    const title = doc.data.title as string;
    deadlines[title] = doc.data.deadline as string | undefined;
    completedAt[title] = doc.data.completedAt as string | undefined;
  }
  return { deadlines, completedAt, lastShutdown: profile?.lastShutdown as string | undefined };
}

/** One task document by id, read directly: the list endpoint paginates, so a
 *  fixture with hundreds of tasks cannot be read whole through it. */
export async function readRemoteTask(email: string, taskId: string): Promise<RemoteData | undefined> {
  const uid = await resolveRemoteUid(email);
  return getRemoteDoc(uid, `tasks/${taskId}`);
}

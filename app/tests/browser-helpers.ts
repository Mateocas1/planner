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
type RestValue = { stringValue: string } | { booleanValue: boolean };
type RestFields = Record<string, RestValue>;
type RestDocument = { name: string; fields?: RestFields };

function encodeFields(data: Record<string, string | boolean>): RestFields {
  const fields: RestFields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
  }
  return fields;
}

function decodeDocument(document: RestDocument): { id: string; data: Record<string, string | boolean> } {
  const data: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(document.fields ?? {})) {
    if ("stringValue" in value) data[key] = value.stringValue;
    else if ("booleanValue" in value) data[key] = value.booleanValue;
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

/** Reads every series definition, keeping the generated id next to its fields. */
export async function readRemoteSeries(email: string): Promise<Array<{ id: string; data: Record<string, string> }>> {
  const uid = await resolveRemoteUid(email);
  const series = await listRemoteDocs(uid, "series");
  return series.map(doc => ({ id: doc.id, data: doc.data as Record<string, string> }));
}

/** Reads every completion record exactly as the domain builds it. */
export async function readRemoteCompletions(email: string): Promise<Array<{ occurrenceId: string; completedAt: string }>> {
  const uid = await resolveRemoteUid(email);
  const completions = await listRemoteDocs(uid, "completions");
  return completions.map(doc => doc.data as { occurrenceId: string; completedAt: string });
}

/* ---------- Signing in through the real form ---------- */

/**
 * Signs a fresh account up, or an existing one in, through the app's own form,
 * and waits for the signed-in shell.
 *
 * The retry covers one artifact of the local Auth emulator, never app
 * behaviour. `firebase-tools/lib/emulator/auth/operations.js` asserts
 * `decoded.payload.iat >= user.validSince` and reports `TOKEN_EXPIRED`; the
 * emulator stamps `validSince` while it creates the account and `iat` when it
 * signs the token a moment later, so if the host clock steps *backwards*
 * between the two stamps it rejects the token it just issued and the SDK's
 * post-sign-in account lookup fails with `auth/user-token-expired`. WSL2 on this
 * host steps its clock back 0.7-1.3 s roughly every 15 s (measured with a 50 ms
 * `Date.now()` sampler), and a sign-up under load takes long enough for both
 * stamps to straddle a step. The account was created (signUp answered 200), so
 * re-submitting the same credentials signs it in; every other error still fails
 * the test, and so does a second artifact.
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
  const shell = page.getByText(`Signed in as ${email}`);
  const clockArtifact = page.getByRole("alert").filter({ hasText: "auth/user-token-expired" });
  // The emulator round trip plus the SDK's account lookup: a server wait, so it
  // gets the same 15 s budget the remote-state assertions use, not a local one.
  await expect(shell.or(clockArtifact)).toBeVisible({ timeout: 15_000 });
  if (await clockArtifact.isVisible()) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(shell).toBeVisible();
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

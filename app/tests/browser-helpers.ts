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
async function addRemoteDoc(uid: string, kind: "tasks" | "blocks", data: Record<string, string | boolean>) {
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
export async function submitAuthForm(page: Page, email: string, kind: "sign up" | "sign in") {
  await page.goto("/");
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
  await expect(shell.or(clockArtifact)).toBeVisible();
  if (await clockArtifact.isVisible()) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(shell).toBeVisible();
}

#!/usr/bin/env node
/**
 * ui-capture — the capture instrument for the visual improvement loop.
 *
 * One command produces a full screenshot set of the running app so the loop
 * (capture, compare against a reference frame, fix the three biggest visual
 * differences, capture again) has a stable baseline to work from.
 *
 * There are no styling or component changes here: this tool only drives the app.
 *
 * Usage:
 *   cd app && node scripts/ui-capture.mjs [round]
 *
 * `round` defaults to the next unused `/tmp/ui-loop/round-N`. Everything runs
 * against the local emulators the browser suite already uses, via
 * `firebase emulators:exec --config firebase.emulator.json`. The emulators,
 * the Vite dev server and the browser are all started and stopped inside this
 * one command: there is nothing to remember to stop and nothing is committed.
 *
 * Same-process handshake: the outer run starts `emulators:exec`, which runs
 * this same file with `--inner`. The inner run seeds Firestore through the
 * emulator REST API, drives Chromium with Playwright, writes the PNGs and
 * validates their headers.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const APP_URL = "http://127.0.0.1:4174";
const OUT_ROOT = "/tmp/ui-loop";

/* ---------- emulator REST contract (mirrors tests/browser-helpers.ts) ---------- */

const PROJECT_ID = "demo-calendar-app";
const PASSWORD = "local-emulator-password";
const PROFILE_TZ = "America/Sao_Paulo"; // UTC-3 all year (Brazil dropped DST in 2019)
const ZONE_OFFSET = "-03:00";
const AUTH_EMULATOR = "http://127.0.0.1:9199";
const FIRESTORE_REST = `http://127.0.0.1:8187/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/* ---------- viewports ---------- */

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/* ---------- small pure helpers ---------- */

const pad = value => String(value).padStart(2, "0");

/** Date key (YYYY-MM-DD) of an instant in a named IANA zone. */
function dateKeyIn(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = type => Number(parts.find(part => part.type === type).value);
  return `${get("year")}-${pad(get("month"))}-${pad(get("day"))}`;
}

/** Date key of a wall-UTC day counter (read as UTC, never through a zone). */
function keyFromUtc(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Adds days to a date-only key, staying on wall-UTC midnights. */
function addDays(key, days) {
  return keyFromUtc(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000);
}

/** Monday of the week containing a date-only key. */
function mondayOf(key) {
  const utc = Date.parse(`${key}T00:00:00Z`);
  return keyFromUtc(utc - ((new Date(utc).getUTCDay() + 6) % 7) * 86_400_000);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/* ---------- Firestore / Auth emulator REST seeding ---------- */

function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
  }
  return fields;
}

function decodeDocument(body) {
  return body.name.split("/").pop();
}

async function createRemoteAccount(email) {
  const response = await fetch(`${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-only`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`emulator signUp failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!body.localId) throw new Error("emulator signUp returned no localId");
  return body.localId;
}

async function restFetch(pathname, init) {
  return fetch(`${FIRESTORE_REST}/${pathname}`, {
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    ...init,
  });
}

/** Creates a document with a server-generated id and returns that id. */
async function addRemoteDoc(uid, collection, data) {
  const response = await restFetch(`users/${uid}/${collection}`, {
    method: "POST",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!response.ok) throw new Error(`emulator add ${collection} failed: ${response.status} ${await response.text()}`);
  return decodeDocument(await response.json());
}

/** Creates or replaces an explicitly-addressed document (setDoc semantics). */
async function setRemoteDoc(uid, docPath, data) {
  const response = await restFetch(`users/${uid}/${docPath}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!response.ok) throw new Error(`emulator set ${docPath} failed: ${response.status} ${await response.text()}`);
}

/**
 * A realistic planner: enough tasks, deadlines, a done item, two recurring
 * series and two weeks of work blocks (one crossing into the evening) that the
 * surfaces read as a planner someone actually uses.
 */
function seedSpec() {
  const today = dateKeyIn(PROFILE_TZ);
  const monday = mondayOf(today);
  const nextMonday = addDays(monday, 7);

  const tasks = [
    { title: "Draft Q3 roadmap", deadline: addDays(today, 2) },
    { title: "Review pull request #418", deadline: today },
    { title: "Book dentist appointment" },
    { title: "Pay electricity bill", deadline: addDays(today, 5) },
    { title: "Ship onboarding copy", deadline: addDays(today, -1) },
    { title: "Refactor capture tool" },
    { title: "Write launch notes", deadline: addDays(today, -3), completed: true },
  ];

  const series = [
    { title: "Weekly planning", frequency: "weekly", anchorDate: monday },
    { title: "Morning stretch", frequency: "daily", anchorDate: today },
  ];

  const week = [
    { day: 0, start: "09:00", end: "10:30", task: "Draft Q3 roadmap" },
    { day: 0, start: "14:00", end: "15:00" },
    { day: 1, start: "09:30", end: "11:00", task: "Review pull request #418" },
    { day: 2, start: "13:00", end: "14:00" },
    { day: 2, start: "18:30", end: "21:00", task: "Ship onboarding copy" }, // evening
    { day: 3, start: "10:00", end: "11:30" },
    { day: 4, start: "09:00", end: "10:00" },
  ];
  const nextWeek = [
    { day: 0, start: "09:00", end: "11:00", task: "Pay electricity bill" },
    { day: 2, start: "15:00", end: "17:00" },
    { day: 3, start: "08:30", end: "10:00", task: "Book dentist appointment" },
  ];

  // The blocks above sit on fixed weekdays, so a capture run on a Sunday would
  // show an empty "today" and the Home section would be judged from its empty
  // state. Add content on today's actual weekday so the populated capture is
  // genuinely populated, whatever day the loop runs.
  const todayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  week.push({ day: todayIndex, start: "11:00", end: "12:00" });
  week.push({ day: todayIndex, start: "16:00", end: "17:30", task: "Refactor capture tool" });

  const toBlock = (mondayKey, entry) => ({
    start: `${addDays(mondayKey, entry.day)}T${entry.start}:00${ZONE_OFFSET}`,
    end: `${addDays(mondayKey, entry.day)}T${entry.end}:00${ZONE_OFFSET}`,
    ...(entry.task ? { task: entry.task } : {}),
  });

  return {
    tasks,
    series,
    blocks: [...week.map(entry => toBlock(monday, entry)), ...nextWeek.map(entry => toBlock(nextMonday, entry))],
  };
}

/** Seeds the profile, tasks, series and blocks for one account. */
async function seedPlanner(email) {
  const uid = await createRemoteAccount(email);
  await setRemoteDoc(uid, "profile/main", { timeZone: PROFILE_TZ });

  const spec = seedSpec();
  const taskIds = new Map();
  for (const task of spec.tasks) {
    const id = await addRemoteDoc(uid, "tasks", {
      title: task.title,
      completed: task.completed ?? false,
      ...(task.deadline ? { deadline: task.deadline } : {}),
    });
    taskIds.set(task.title, id);
  }
  for (const entry of spec.series) {
    await addRemoteDoc(uid, "series", {
      title: entry.title,
      frequency: entry.frequency,
      anchorDate: entry.anchorDate,
    });
  }
  for (const block of spec.blocks) {
    await addRemoteDoc(uid, "blocks", {
      start: block.start,
      end: block.end,
      ...(block.task ? { taskId: taskIds.get(block.task) } : {}),
    });
  }
  return uid;
}

/** Seeds only the profile, so every surface renders its empty state. */
async function seedEmpty(email) {
  const uid = await createRemoteAccount(email);
  await setRemoteDoc(uid, "profile/main", { timeZone: PROFILE_TZ });
  return uid;
}

/* ---------- Vite dev server ---------- */

function startVite() {
  const vite = path.join(APP_DIR, "node_modules", ".bin", "vite");
  return spawn(vite, ["--host", "127.0.0.1", "--port", "4174", "--strictPort", "--clearScreen", "false"], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(APP_URL, { redirect: "manual" });
      if (response.ok || response.status === 304) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`vite dev server did not become ready at ${APP_URL}: ${lastError}`);
}

/* ---------- Playwright driving ---------- */

async function signIn(page, email) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const emailInput = page.getByLabel("Email");
  await emailInput.waitFor({ state: "visible", timeout: 30_000 });
  await emailInput.fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText(`Signed in as ${email}`).waitFor({ state: "visible", timeout: 30_000 });
}

async function gotoView(page, label) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: label }).click();
  await page.getByRole("heading", { name: label }).waitFor({ state: "visible", timeout: 15_000 });
}

async function capture(page, outDir, name, viewport) {
  const file = path.join(outDir, name);
  // let spring-driven (JS) motion settle; CSS animations are disabled below
  await page.waitForTimeout(700);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
  captures.push({ name, file, width: viewport.width, height: viewport.height });
}

/* ---------- PNG header validation ---------- */

const captures = [];

function readPngHeader(file) {
  const buffer = readFileSync(file);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasSignature = signature.every((byte, index) => buffer[index] === byte);
  const isPng = hasSignature && buffer.length >= 24 && buffer.toString("ascii", 12, 16) === "IHDR";
  return { bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), isPng };
}

function printPngTable() {
  const rows = captures.map(entry => {
    const header = readPngHeader(entry.file);
    const ok = header.isPng && header.width === entry.width && header.height === entry.height;
    return { ...entry, ...header, ok };
  });

  console.log("\nProduced captures (PNG headers read from disk):");
  console.log("  status  bytes      dimensions   file");
  for (const row of rows) {
    console.log(
      `  ${row.ok ? "OK  " : "FAIL"}    ${String(row.bytes).padStart(8)}   ${`${row.width}x${row.height}`.padEnd(10)}   ${row.name}`,
    );
  }
  const failures = rows.filter(row => !row.ok);
  if (failures.length > 0) {
    throw new Error(`capture validation failed for: ${failures.map(row => row.name).join(", ")}`);
  }
  return rows;
}

/* ---------- scenarios ---------- */

async function captureSeeded(browser, outDir, viewport, suffix) {
  const email = `ui-loop-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await seedPlanner(email);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: PROFILE_TZ, colorScheme: process.env.UI_CAPTURE_SCHEME === "dark" ? "dark" : "light" });
  try {
    const page = await context.newPage();
    await signIn(page, email);

    // Today with its Now card and schedule.
    await page.locator(".now-card").waitFor({ state: "visible", timeout: 30_000 });
    await capture(page, outDir, `home-${suffix}.png`, viewport);

    // Tasks: list, then the details panel open on a real task.
    await gotoView(page, "Tasks");
    await page.locator(".task-title", { hasText: "Write launch notes" }).waitFor({ state: "visible", timeout: 30_000 });
    await capture(page, outDir, `tasks-${suffix}.png`, viewport);
    await page.getByRole("button", { name: "Draft Q3 roadmap" }).click();
    await page.getByRole("complementary", { name: "Task details" }).waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, outDir, `tasks-details-${suffix}.png`, viewport);
    // The panel overlays the shell; dismiss it before navigating again.
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Task details" }).waitFor({ state: "hidden", timeout: 15_000 });

    // The series panel is the task panel's sibling and shares its shell, so a
    // cross-surface round captures it too: the two rename gestures can then be
    // compared side by side instead of one panel standing in for both.
    await page.getByRole("button", { name: "Weekly planning" }).click();
    await page.getByRole("complementary", { name: "Series details" }).waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, outDir, `series-details-${suffix}.png`, viewport);
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Series details" }).waitFor({ state: "hidden", timeout: 15_000 });

    // Calendar: the current week, then the following week's blocks.
    await gotoView(page, "Calendar");
    await page.locator(".calendar-block").first().waitFor({ state: "visible", timeout: 30_000 });
    await capture(page, outDir, `calendar-${suffix}.png`, viewport);
    // The phone grid shows one day, so the phone capture reaches the next
    // week the way a phone user does: by stepping the day forward until the
    // target block is on screen.
    if (viewport.width <= 760) {
      const target = page.locator(".calendar-block", { hasText: "Pay electricity bill" });
      for (let step = 0; step < 8 && !(await target.isVisible().catch(() => false)); step += 1) {
        await page.getByRole("button", { name: "Next day" }).click();
      }
    } else {
      await page.getByRole("button", { name: "Next week" }).click();
    }
    await page.locator(".calendar-block", { hasText: "Pay electricity bill" }).waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, outDir, `calendar-next-week-${suffix}.png`, viewport);
  } finally {
    await context.close();
  }
}

async function captureEmpty(browser, outDir, viewport, suffix) {
  const email = `ui-loop-empty-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await seedEmpty(email);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: PROFILE_TZ, colorScheme: process.env.UI_CAPTURE_SCHEME === "dark" ? "dark" : "light" });
  try {
    const page = await context.newPage();
    await signIn(page, email);

    await page.getByText("No tasks and no work blocks yet").waitFor({ state: "visible", timeout: 30_000 });
    await capture(page, outDir, `home-empty-${suffix}.png`, viewport);

    await gotoView(page, "Tasks");
    await page.getByText("No tasks yet.").waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, outDir, `tasks-empty-${suffix}.png`, viewport);

    await gotoView(page, "Calendar");
    await page.getByText(/No work blocks (this week|on this day)\./).waitFor({ state: "visible", timeout: 15_000 });
    await capture(page, outDir, `calendar-empty-${suffix}.png`, viewport);
  } finally {
    await context.close();
  }
}

/* ---------- inner run (emulators already up) ---------- */

async function runInner() {
  const round = Number(process.env.UI_CAPTURE_ROUND);
  const outDir = process.env.UI_CAPTURE_OUT || path.join(OUT_ROOT, `round-${round}`);
  mkdirSync(outDir, { recursive: true });

  const server = startVite();
  const serverLog = [];
  server.stdout.on("data", chunk => serverLog.push(chunk.toString()));
  server.stderr.on("data", chunk => serverLog.push(chunk.toString()));

  let browser;
  try {
    await waitForServer();
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled browser when the
    // pinned Playwright build is not downloaded (e.g. a sandboxed container).
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    await captureSeeded(browser, outDir, DESKTOP, "1440x900");
    await captureSeeded(browser, outDir, MOBILE, "390x844");
    await captureEmpty(browser, outDir, DESKTOP, "1440x900");
    await captureEmpty(browser, outDir, MOBILE, "390x844");
  } catch (cause) {
    console.error("capture failed:");
    console.error(serverLog.join(""));
    throw cause;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      server.once("exit", resolve);
      setTimeout(resolve, 5_000);
    });
  }

  const rows = printPngTable();
  console.log(`\nRound ${round} · ${rows.length} captures written to ${outDir}`);
}

/* ---------- outer run ---------- */

function nextRound() {
  if (!existsSync(OUT_ROOT)) return 1;
  const used = readdirSync(OUT_ROOT)
    .map(name => /^round-(\d+)$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1]));
  return used.length > 0 ? Math.max(...used) + 1 : 1;
}

function runOuter(round) {
  const outDir = path.join(OUT_ROOT, `round-${round}`);
  const firebase = path.join(APP_DIR, "node_modules", ".bin", "firebase");
  const innerCommand = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --inner`;
  const args = [
    "emulators:exec",
    "--config",
    "firebase.emulator.json",
    "--project",
    PROJECT_ID,
    "--only",
    "auth,firestore",
    innerCommand,
  ];

  console.log(`ui-capture round ${round} -> ${outDir}`);
  console.log(`starting emulators via: firebase ${args.slice(0, -1).join(" ")} "<inner>"`);

  const child = spawn(firebase, args, {
    cwd: APP_DIR,
    stdio: "inherit",
    env: { ...process.env, UI_CAPTURE_ROUND: String(round), UI_CAPTURE_OUT: outDir },
  });

  const forwardSignal = signal => child.kill(signal);
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", code => {
    if (code === 0) {
      console.log(`\nDone. Run again with: cd ${APP_DIR} && node scripts/ui-capture.mjs`);
    } else {
      console.error(`ui-capture failed (exit ${code ?? "signal"}).`);
    }
    process.exitCode = code ?? 1;
  });
}

/* ---------- entry ---------- */

const argv = process.argv.slice(2);
if (argv.includes("--inner")) {
  runInner().catch(cause => {
    console.error(cause);
    process.exitCode = 1;
  });
} else {
  const roundArg = argv.find(argument => /^\d+$/.test(argument));
  runOuter(roundArg ? Number(roundArg) : nextRound());
}

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { password, submitAuthForm } from "./browser-helpers.ts";

/**
 * The weekly review — the banner that proposes it, the
 * four-step flow's writes, the toast-less channels (palette, sidebar,
 * shortcut), and the Rituals rows that configure the schedule.
 *
 * The clock is Playwright's: frozen at Friday 17:30 UTC so the default
 * Friday moment is due and the day-shutdown banner is not (it opens at
 * 18:00). Every write assertion reads the emulator's server documents, never
 * the app's state.
 *
 * Screenshots are evidence for the parent review, not assertions, and land in a local folder.
 */

test.setTimeout(180_000);

test.use({ viewport: { width: 1440, height: 900 } });

const ZONE = "UTC";
const REST = "http://127.0.0.1:8187/v1/projects/demo-calendar-app/databases/(default)/documents";
const shotDir = fileURLToPath(new URL("../../odd/runs/r2-w2b-shots", import.meta.url));

/* ---------- the week the tests live in (2026-10-19 → 2026-10-25, W43) ---------- */

const MONDAY = "2026-10-19";
const SUNDAY = "2026-10-25";
const WEEK = "2026-W43";
const NEXT_MONDAY = "2026-10-26";
/** Friday 17:30: the default review moment is due; the 18:00 shutdown is not. */
const FRIDAY_EVENING = new Date("2026-10-23T17:30:00Z");
/** Tuesday lunchtime: nothing is due, so a manual open runs all four steps. */
const TUESDAY_NOON = new Date("2026-10-20T12:00:00Z");

/* ---------- emulator REST: accounts and documents, no SDK ---------- */

async function signUp(email: string): Promise<string> {
  const response = await fetch(
    "http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-only",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  if (!response.ok) throw new Error(`signUp failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { localId: string };
  return body.localId;
}

type Field =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { mapValue: { fields: Record<string, Field> } }
  | { arrayValue: { values?: Field[] } };

const str = (value: string): Field => ({ stringValue: value });
const bool = (value: boolean): Field => ({ booleanValue: value });
const int = (value: number): Field => ({ integerValue: String(value) });
const map = (fields: Record<string, Field>): Field => ({ mapValue: { fields } });
const list = (values: Field[]): Field => ({ arrayValue: { values } });

const num = (field: Field | undefined): number | undefined =>
  field === undefined || !("integerValue" in field) ? undefined : Number(field.integerValue);

async function patchDoc(uid: string, path: string, fields: Record<string, Field>): Promise<void> {
  const response = await fetch(`${REST}/users/${uid}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`patch ${path} failed: ${response.status} ${await response.text()}`);
}

async function getDoc(uid: string, path: string): Promise<Record<string, Field> | undefined> {
  const response = await fetch(`${REST}/users/${uid}/${path}`, { headers: { Authorization: "Bearer owner" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`get ${path} failed: ${response.status}`);
  const body = (await response.json()) as { fields?: Record<string, Field> };
  return body.fields;
}

async function listDocs(uid: string, kind: string): Promise<Record<string, Field>[]> {
  const response = await fetch(`${REST}/users/${uid}/${kind}`, { headers: { Authorization: "Bearer owner" } });
  if (!response.ok) throw new Error(`list ${kind} failed: ${response.status}`);
  const body = (await response.json()) as { documents?: Array<{ fields?: Record<string, Field> }> };
  return (body.documents ?? []).map(document => document.fields ?? {});
}

const text = (field: Field | undefined): string | undefined =>
  field === undefined ? undefined : "stringValue" in field ? field.stringValue : undefined;

/** The string values of an arrayValue field; anything else is an empty list. */
function listOf(field: Field | undefined): string[] {
  if (field === undefined || !("arrayValue" in field) || field.arrayValue.values === undefined) return [];
  return field.arrayValue.values.map(value => ("stringValue" in value ? value.stringValue : ""));
}

/** The fields of a mapValue field; anything else is absent. */
function mapOf(field: Field | undefined): Record<string, Field> | undefined {
  return field !== undefined && "mapValue" in field ? field.mapValue.fields : undefined;
}

/** One element of an arrayValue field, or absent. */
function at(field: Field | undefined, index: number): Field | undefined {
  return field !== undefined && "arrayValue" in field ? field.arrayValue.values?.[index] : undefined;
}

/* ---------- the seed ---------- */

async function seed(
  email: string,
  fixture: {
    /** Weekly review settings; omit for the defaults (Fri 17:00 / Sun 19:00). */
    weeklyReview?: boolean;
    /** The week document's pre-existing state, e.g. steps already walked. */
    week?: { stepsDone?: string[]; skipped?: boolean };
    tasks?: Array<{ title: string; deadline?: string; completed?: boolean; completedAt?: string; estimate?: number; actualMinutes?: number }>;
    blocks?: Array<{ start: string; end: string; task?: string }>;
  } = {},
): Promise<string> {
  const uid = await signUp(email);
  const profile: Record<string, Field> = { timeZone: str(ZONE) };
  if (fixture.weeklyReview !== undefined) {
    profile.weeklyReview = map({
      nudges: bool(true),
      moments: list([
        map({ day: int(5), time: int(17 * 60), steps: list([str("review"), str("cleanup"), str("reflect")]) }),
        map({ day: int(0), time: int(19 * 60), steps: list([str("plan")]) }),
      ]),
    });
  }
  await patchDoc(uid, "profile/main", profile);
  if (fixture.week !== undefined) {
    await patchDoc(uid, `weeklyReview/${WEEK}`, {
      week: str(WEEK),
      ...(fixture.week.stepsDone !== undefined
        ? { stepsDone: list(fixture.week.stepsDone.map(str)) }
        : {}),
      ...(fixture.week.skipped !== undefined ? { skipped: bool(fixture.week.skipped) } : {}),
    });
  }
  for (const task of fixture.tasks ?? []) {
    await patchDoc(uid, `tasks/${task.title.replace(/\W+/g, "-")}`, {
      title: str(task.title),
      completed: bool(task.completed ?? false),
      ...(task.deadline !== undefined ? { deadline: str(task.deadline) } : {}),
      ...(task.completedAt !== undefined ? { completedAt: str(task.completedAt) } : {}),
      ...(task.estimate !== undefined ? { estimate: int(task.estimate) } : {}),
      ...(task.actualMinutes !== undefined ? { actualMinutes: int(task.actualMinutes) } : {}),
    });
  }
  for (const [index, block] of (fixture.blocks ?? []).entries()) {
    await patchDoc(uid, `blocks/seed-${index}`, {
      start: str(block.start),
      end: str(block.end),
      ...(block.task !== undefined ? { taskId: str(block.task) } : {}),
    });
  }
  return uid;
}

/* ---------- page plumbing ---------- */

async function enter(page: Page, email: string, now: Date): Promise<void> {
  await page.clock.setFixedTime(now);
  await submitAuthForm(page, email, "sign in");
  await page.getByText(`Signed in as ${email}`).waitFor({ timeout: 15_000 });
}

const banner = (page: Page) => page.locator(".weekly-banner");
const startButton = (page: Page) => page.getByRole("button", { name: "Start review" });

async function shot(page: Page, name: string) {
  await expect(page.getByText("Loading your planner…")).toHaveCount(0);
  await page.waitForFunction(() =>
    (document as Document & { getAnimations(options?: { subtree?: boolean }): Animation[] })
      .getAnimations({ subtree: true }).every(animation => animation.playState !== "running"),
  );
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

function newEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
}

const flow = (page: Page) => page.getByRole("region", { name: "Weekly review" });
const rail = (page: Page) => flow(page).getByRole("list", { name: "Review steps" });

async function next(page: Page) {
  await flow(page).getByRole("button", { name: /^(Next|Finish)$/ }).click();
}

test("the banner proposes the review when the moment is due, and Later hides it", async ({ page }) => {
  const email = newEmail("weekly-banner");
  const uid = await seed(email, { weeklyReview: true });
  await enter(page, email, FRIDAY_EVENING);

  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText("Time to close the week.");
  await expect(banner(page)).toContainText("Friday at 17:00");
  await shot(page, "banner-light");

  await banner(page).getByRole("button", { name: "Later" }).click();
  await expect(banner(page)).toHaveCount(0);
  // The snooze is the week document's field, not this device's mood: it
  // holds until the frozen clock passes it, which it never does here.
  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect
    .poll(async () => {
      const week = await getDoc(uid, `weeklyReview/${WEEK}`);
      return week === undefined ? undefined : text(week.snoozedUntil);
    }, poll)
    .toBeDefined();
  await page.reload();
  await page.getByText(`Signed in as ${email}`).waitFor({ timeout: 15_000 });
  await expect(banner(page)).toHaveCount(0);
});

test("Skip this week marks the week skipped and the banner stays gone", async ({ page }) => {
  const email = newEmail("weekly-skip");
  const uid = await seed(email, { weeklyReview: true });
  await enter(page, email, FRIDAY_EVENING);

  await expect(banner(page)).toBeVisible();
  // Skip lives behind the ⋯ disclosure, not beside Start.
  await expect(banner(page).getByRole("button", { name: "Skip this week" })).toHaveCount(0);
  await banner(page).getByRole("button", { name: "More weekly review options" }).click();
  await banner(page).getByRole("button", { name: "Skip this week" }).click();
  await expect(banner(page)).toHaveCount(0);

  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect.poll(async () => (await getDoc(uid, `weeklyReview/${WEEK}`))?.skipped, poll).toEqual(bool(true));

  // Nothing proposes itself again this week, even after a reload.
  await page.reload();
  await page.getByText(`Signed in as ${email}`).waitFor({ timeout: 15_000 });
  await expect(banner(page)).toHaveCount(0);
});

test("the full flow writes every step and the reflection note", async ({ page }) => {
  const email = newEmail("weekly-flow");
  const uid = await seed(email, {
    weeklyReview: true,
    tasks: [
      { title: "Spec review", completed: true, completedAt: "2026-10-20T10:00:00Z", estimate: 60, actualMinutes: 90 },
      { title: "Old report", deadline: "2026-10-19" },
      { title: "Next week deck" },
    ],
    blocks: [{ start: "2026-10-19T09:00:00Z", end: "2026-10-19T11:00:00Z", task: "Spec-review" }],
  });
  await enter(page, email, FRIDAY_EVENING);

  // Manual entry through the palette: mid-flow the week's own steps come back.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("weekly");
  await page.getByRole("option", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();
  // Opened by hand, all four steps run — nothing is due, so nothing is hidden.
  await expect(rail(page).getByRole("button", { name: /Review/ })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: /Plan/ })).toBeVisible();
  await shot(page, "step-review-light");

  /* Review: the week's few numbers, in sentences. */
  await expect(flow(page)).toContainText("2 h planned · 1 h 30 min tracked");
  await expect(flow(page)).toContainText("Tasks took about 1.5× their estimates.");
  await expect(flow(page)).toContainText("1 of 1 planned tasks completed");
  await expect(flow(page)).toContainText("Spec review");
  await next(page);

  /* Clean up: the overdue candidate takes "This week" — its deadline moves to
     the week's last day, on the server. */
  await expect(flow(page)).toContainText("Old report");
  const cleanupRow = flow(page).locator(".weekly-cleanup-row", { hasText: "Old report" });
  await cleanupRow.getByRole("button", { name: "This week" }).click();
  await expect(cleanupRow).toHaveCount(0);
  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect
    .poll(async () => {
      const tasks = await listDocs(uid, "tasks");
      return tasks.find(fields => text(fields.title) === "Old report")?.deadline;
    }, poll)
    .toEqual(str(SUNDAY));
  await shot(page, "step-cleanup-light");
  await next(page);

  /* Plan: pick a priority, place its block on next week, apply. */
  await flow(page).locator(".weekly-pick-row", { hasText: "Next week deck" }).locator('input[type="checkbox"]').check();
  await flow(page).getByRole("button", { name: "Place blocks on next week" }).click();
  await expect(flow(page)).toContainText(NEXT_MONDAY.slice(8));
  // The pick places the chosen task; the unpicked open ones fill what is left.
  await flow(page).getByRole("button", { name: /Apply \d+ blocks?/ }).click();
  await expect
    .poll(async () => (await listDocs(uid, "blocks")).filter(fields => (text(fields.start) ?? "").startsWith(NEXT_MONDAY)).length, poll)
    .toBeGreaterThan(0);
  await shot(page, "step-plan-light");
  await next(page);

  /* Reflect: a short note, saved with the week's first instant. */
  await page.getByLabel("What worked, what did not, and one intention for next week.").fill("The flow is calm. Keep Friday afternoons for the review.");
  await shot(page, "step-reflect-light");
  await next(page);

  await expect
    .poll(async () => listOf((await getDoc(uid, `weeklyReview/${WEEK}`))?.stepsDone).sort().join(","), poll)
    .toBe("cleanup,plan,reflect,review");
  const note = mapOf((await getDoc(uid, `weeklyReview/${WEEK}`))?.note);
  expect(note).toBeDefined();
  expect(text(note?.text)).toBe(
    "The flow is calm. Keep Friday afternoons for the review.",
  );
  expect(text(note?.createdAt)).toBeDefined();
  // The flow is over: back where it came from.
  await expect(flow(page)).toHaveCount(0);
});

test("Next over undecided clean-up rows moves on without marking Clean up finished", async ({ page }) => {
  const email = newEmail("weekly-undecided");
  const uid = await seed(email, {
    weeklyReview: true,
    tasks: [{ title: "Old report", deadline: "2026-10-19" }],
  });
  await enter(page, email, TUESDAY_NOON);

  await page.getByRole("complementary").getByRole("button", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();
  await expect(flow(page)).toContainText("Step 1 of 4");
  await next(page);

  /* Clean up: "Old report" is still undecided, so Next moves on but the step
     stays open; the header counts the step it is on. */
  await expect(flow(page)).toContainText("Step 2 of 4");
  await expect(flow(page).locator(".weekly-cleanup-row", { hasText: "Old report" })).toHaveCount(1);
  await next(page);
  await expect(flow(page)).toContainText("Step 3 of 4");

  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect
    .poll(async () => listOf((await getDoc(uid, `weeklyReview/${WEEK}`))?.stepsDone).sort().join(","), poll)
    .toBe("review");
  // The old copy's footer counter is gone: the progress is in the header.
  await expect(flow(page).getByText("steps done this week")).toHaveCount(0);
});

test("a due visit runs only the moment's steps, and finished steps are not re-offered", async ({ page }) => {
  const email = newEmail("weekly-due");
  const uid = await seed(email, {
    weeklyReview: true,
    week: { stepsDone: ["review", "cleanup"] },
  });
  await enter(page, email, FRIDAY_EVENING);

  // The banner still proposes the week: reflect is the Friday step left.
  await expect(banner(page)).toBeVisible();
  await startButton(page).click();
  await expect(flow(page)).toBeVisible();
  // Only the unfinished step is in the rail.
  await expect(rail(page).getByRole("button")).toHaveCount(1);
  await expect(rail(page).getByRole("button", { name: /Reflect/ })).toBeVisible();
});

test("manual entries: the palette, the sidebar and the w shortcut", async ({ page }) => {
  const email = newEmail("weekly-manual");
  await seed(email, { weeklyReview: true });
  await enter(page, email, TUESDAY_NOON);

  // Tuesday: nothing due, no banner.
  await expect(banner(page)).toHaveCount(0);

  // The sidebar entry.
  await page.getByRole("complementary").getByRole("button", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(flow(page)).toHaveCount(0);

  // The shortcut.
  await page.keyboard.press("w");
  await expect(flow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(flow(page)).toHaveCount(0);
});

test("Rituals rows edit the schedule and it persists", async ({ page }) => {
  const email = newEmail("weekly-rituals");
  const uid = await seed(email, { weeklyReview: true });
  await enter(page, email, FRIDAY_EVENING);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Rituals" }).click();
  await expect(settings).toBeVisible();

  // Nudges off writes its boolean.
  await settings.getByRole("switch", { name: "Propose the review" }).click();
  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect.poll(async () => mapOf((await getDoc(uid, "profile/main"))?.weeklyReview)?.nudges, poll).toEqual(bool(false));

  // The first moment moves to 16:00 and drops Reflect from its steps.
  await page.locator("#rituals-time-0").fill("16:00");
  await page.keyboard.press("Tab");
  await settings.locator(".rituals-moment").first().getByRole("button", { name: "Reflect" }).click();
  await expect.poll(async () => {
    const review = mapOf((await getDoc(uid, "profile/main"))?.weeklyReview);
    const first = mapOf(at(review?.moments, 0));
    return num(first?.time);
  }, poll).toBe(16 * 60);
});

test("screenshots of every step, light and dark", async ({ page }) => {
  const email = newEmail("weekly-shots");
  await seed(email, {
    weeklyReview: true,
    tasks: [
      { title: "Spec review", completed: true, completedAt: "2026-10-20T10:00:00Z", estimate: 60, actualMinutes: 90 },
      { title: "Old report", deadline: "2026-10-19" },
      { title: "Next week deck" },
    ],
    blocks: [{ start: "2026-10-19T09:00:00Z", end: "2026-10-19T11:00:00Z", task: "Spec-review" }],
  });
  await enter(page, email, FRIDAY_EVENING);

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("weekly");
  await page.getByRole("option", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();

  await shot(page, "step-review-light");
  await next(page);
  await shot(page, "step-cleanup-light");
  // Clean up is finished only once its candidate is decided: Next before that
  // would leave the step open, and the dark walk would start there.
  await flow(page).locator(".weekly-cleanup-row", { hasText: "Old report" }).getByRole("button", { name: "This week" }).click();
  await next(page);
  await flow(page).locator(".weekly-pick-row", { hasText: "Next week deck" }).locator('input[type="checkbox"]').check();
  await flow(page).getByRole("button", { name: "Place blocks on next week" }).click();
  await shot(page, "step-plan-light");
  await next(page);
  await page.getByLabel("What worked, what did not, and one intention for next week.").fill("The flow is calm.");
  await shot(page, "step-reflect-light");
  await next(page);

  await page.emulateMedia({ colorScheme: "dark" });
  // Dark run: the same walk, from the top.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("weekly");
  await page.getByRole("option", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();
  await shot(page, "step-review-dark");
  await next(page);
  await shot(page, "step-cleanup-dark");
  await next(page);
  await flow(page).locator(".weekly-pick-row", { hasText: "Next week deck" }).locator('input[type="checkbox"]').check();
  await flow(page).getByRole("button", { name: "Place blocks on next week" }).click();
  await shot(page, "step-plan-dark");
  await next(page);
  await page.getByLabel("What worked, what did not, and one intention for next week.").fill("The flow is calm.");
  await shot(page, "step-reflect-dark");
});

test("the Clean-up step's delete takes the task's work blocks with it (S8)", async ({ page }) => {
  const email = newEmail("weekly-cleanup-delete");
  const uid = await seed(email, {
    weeklyReview: true,
    tasks: [{ title: "Stale deck", deadline: "2026-10-18" }],
    // One work block linked to the overdue task: the delete must take it too,
    // and undo would put both back (the UI path is the one wired to the
    // delete-time block query; review finding 2).
    blocks: [{ start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:30:00Z", task: "Stale-deck" }],
  });
  await enter(page, email, FRIDAY_EVENING);

  // Opened by hand through the palette, like the full-flow walk.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search tasks or run a command" }).fill("weekly");
  await page.getByRole("option", { name: "Weekly review" }).click();
  await expect(flow(page)).toBeVisible();
  await next(page); // Review

  // The overdue candidate is deleted with its block; the undo toast offers
  // the shell's one offer, exactly like Home and Tasks.
  const cleanupRow = flow(page).locator(".weekly-cleanup-row", { hasText: "Stale deck" });
  await expect(cleanupRow).toBeVisible();
  await cleanupRow.getByRole("button", { name: "Delete" }).click();
  await expect(cleanupRow).toHaveCount(0);
  await expect(page.locator("body")).toContainText("Task deleted");

  const poll = { timeout: 15_000, intervals: [250, 500, 1_000] };
  await expect
    .poll(async () => (await listDocs(uid, "tasks")).some(fields => text(fields.title) === "Stale deck"), poll)
    .toBe(false);
  await expect
    .poll(async () => (await listDocs(uid, "blocks")).filter(fields => (text(fields.start) ?? "").startsWith("2026-10-22")).length, poll)
    .toBe(0);
});

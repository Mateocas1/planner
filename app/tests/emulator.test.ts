import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signOut } from "firebase/auth";
import { connectFirestoreEmulator, disableNetwork, doc, enableNetwork, getDoc, getDocFromServer, getFirestore, increment, setDoc, terminate, updateDoc, type Firestore } from "firebase/firestore";
import { calendarKey, planHolidayCleanup, selectHolidayTasks } from "../src/domain/gcalImport.ts";
import { subtractActualMinutesIn } from "../src/data/actualMinutes.ts";
import { createOccurrenceCompletion, MAX_ACTUAL_MINUTES, occurrenceId, parseActualByDay, requireActualMinutes } from "../src/domain/model.ts";
import { maxCloseDayMoves, planCloseDay, type ShutdownBlock, type ShutdownState, type ShutdownTask } from "../src/planning/shutdown.ts";

const authHost = "127.0.0.1:9199";
const firestoreHost = "127.0.0.1:8187";

function requireEmulators(): void {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== authHost ||
      process.env.FIRESTORE_EMULATOR_HOST !== firestoreHost ||
      process.env.GCLOUD_PROJECT !== "demo-calendar-app") {
    throw new Error("test:emulator requires the demo-calendar-app Auth and Firestore emulators");
  }
}

function client(name: string): { app: FirebaseApp; db: Firestore; auth: ReturnType<typeof getAuth> } {
  requireEmulators();
  const app = initializeApp({ projectId: "demo-calendar-app", apiKey: "local-only" }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8187);
  return { app, db, auth };
}

/**
 * Drift guard. The emulators load firestore.emulator.rules while production
 * deploys firestore.rules, so the two can silently diverge: an edit to the
 * deployed rules that nobody copies over, or a stray loosening of the emulator
 * copy, would otherwise only be noticed in production.
 *
 * Normalisation: `//` comments are stripped (they carry no rule meaning and
 * the two files document themselves differently), the uid allowlist segment is
 * removed from both sides, and all whitespace is collapsed to single spaces.
 * What must remain identical is everything that actually decides access: the
 * rules version, the service, the match, the owner condition and every other
 * clause. The two allowlist presence checks stop the comparison above from
 * passing vacuously on a pair of files that both lost the allowlist.
 */
function readRules(name: "firestore.rules" | "firestore.emulator.rules"): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function withoutComments(source: string): string {
  return source.split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
}

const allowlistSegment = /\s*&&\s*request\.auth\.uid\s+in\s*\[[^\]]*\]/g;
const allowlistPresent = /&&\s*request\.auth\.uid\s+in\s*\[/;

function normalise(source: string): string {
  return withoutComments(source).replace(allowlistSegment, "").replace(/\s+/g, " ").trim();
}

test("Emulator Firestore rules mirror production except the uid allowlist", () => {
  const production = readRules("firestore.rules");
  const emulator = readRules("firestore.emulator.rules");
  assert.match(withoutComments(production), allowlistPresent, "production rules must carry a uid allowlist");
  assert.doesNotMatch(withoutComments(emulator), allowlistPresent, "emulator rules must not carry a uid allowlist");
  assert.equal(
    normalise(emulator),
    normalise(production),
    "firestore.emulator.rules drifted from firestore.rules beyond the allowlist",
  );
});

async function close({ app, db }: { app: FirebaseApp; db: Firestore }): Promise<void> {
  await terminate(db);
  await deleteApp(app);
}

/**
 * Two offline increments must reach the server as a sum, not as two absolute
 * writes racing each other.
 *
 * This is the guarantee `addActualMinutes` (src/data/tasks.ts) relies on, and
 * the reason it writes an increment transform instead of reading a task and
 * writing a value back: a read-then-write loses one of the two sessions no
 * matter which device it runs on. The helper module itself cannot be loaded
 * here -- it imports the app's client, which resolves its project from
 * `window.location` -- so this test pins the storage semantics it depends on,
 * against a real server, with the exact call shape the helper emits.
 *
 * The document starts without the field, which is also the "no read" promise:
 * an increment on an absent field counts from zero.
 */
test("two offline increments accumulate on the server instead of overwriting each other", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`increment-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `increment-${suffix}@example.invalid`, "password1");
    const path = `users/${account.user.uid}/tasks/tracked`;
    await setDoc(doc(owner.db, path), { title: "Tracked task", completed: false });

    await disableNetwork(owner.db);
    /* A write's promise settles on the *server's* answer (that is what makes a
       denied write reject), and offline there is no answer yet. So both
       sessions are started here -- each queued with its own transform -- and
       awaited once the network returns. */
    const firstSession = updateDoc(doc(owner.db, path), { actualMinutes: increment(20) });
    const secondSession = updateDoc(doc(owner.db, path), { actualMinutes: increment(10) });
    // The local cache already reads both, which is what makes the counter
    // visible offline even though nothing has reached the server.
    assert.equal((await getDoc(doc(owner.db, path))).data()?.actualMinutes, 30);
    await enableNetwork(owner.db);
    await Promise.all([firstSession, secondSession]);

    // The server, not the local cache: the two queued transforms arrive as an
    // increment each, so the stored count is their sum. Polled because the
    // queue drains asynchronously once the network returns.
    let stored: number | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = (await getDocFromServer(doc(owner.db, path))).data()?.actualMinutes;
      if (stored === 30) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(stored, 30);
  } finally {
    await close(owner);
  }
});

/**
 * Idle away (T9, spec S8.5): a subtraction confirmed after the session's own
 * minutes already landed goes through the app's helper
 * (`subtractActualMinutesIn`, which `tasks.ts` `subtractActualMinutes` calls
 * with the app's database): one `increment()` transform with a negative
 * value. This test calls that helper while offline and proves the queued
 * write drains once and changes the counter by exactly its minutes. The
 * "Keep writes nothing" half is a property of the confirm / keep functions in
 * domain/idleFlow.ts, covered by their unit tests.
 */
test("a queued offline subtraction lands once on the server", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`idle-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `idle-${suffix}@example.invalid`, "password1");
    const path = `users/${account.user.uid}/tasks/away`;
    await setDoc(doc(owner.db, path), { title: "Away task", completed: false, actualMinutes: 30 });

    await disableNetwork(owner.db);
    // The one write a confirmed Subtract produces, queued while offline. The
    // away span this subtraction belongs to is on the task's own day.
    const subtraction = subtractActualMinutesIn(owner.db, account.user.uid, "away", 12, "2026-03-24");
    // The local cache applies the transform at once, which is what keeps the
    // visible counter honest while the app is offline.
    assert.equal((await getDoc(doc(owner.db, path))).data()?.actualMinutes, 18);
    await enableNetwork(owner.db);
    await subtraction;

    // The server holds exactly one subtraction, not a replayed one.
    let stored: number | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stored = (await getDocFromServer(doc(owner.db, path))).data()?.actualMinutes;
      if (stored === 18) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(stored, 18);

    // The helper refuses what is not a whole positive minute count.
    await assert.rejects(subtractActualMinutesIn(owner.db, account.user.uid, "away", 0, "2026-03-24"), /whole minute/);
    await assert.rejects(subtractActualMinutesIn(owner.db, account.user.uid, "a/b", 5, "2026-03-24"), /task ID/);

    // Keep: the same offline cycle with no confirmed write changes nothing.
    await disableNetwork(owner.db);
    await enableNetwork(owner.db);
    assert.equal((await getDocFromServer(doc(owner.db, path))).data()?.actualMinutes, 18);
  } finally {
    await close(owner);
  }
});

test("a recorded minute count is a whole number a document may hold or omit", () => {
  // The stored field is an integer counter: the timer adds whole minutes and a
  // hand-edited document may hold anything, so the domain rejects rather than
  // rounds. Zero is a real value (a counter that has not moved yet).
  assert.equal(requireActualMinutes(0), 0);
  assert.equal(requireActualMinutes(20), 20);
  assert.equal(requireActualMinutes(MAX_ACTUAL_MINUTES), MAX_ACTUAL_MINUTES);
  for (const minutes of [-1, 4.5, MAX_ACTUAL_MINUTES + 1, Number.NaN]) {
    assert.throws(() => requireActualMinutes(minutes), /actual/);
  }
});

test("Firestore rules isolate authenticated owners and deny others", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`owner-${suffix}`);
  const other = client(`other-${suffix}`);
  try {
    const ownerAccount = await createUserWithEmailAndPassword(owner.auth, `owner-${suffix}@example.invalid`, "password1");
    const path = `users/${ownerAccount.user.uid}/tasks/task-1`;
    await setDoc(doc(owner.db, path), { title: "Synthetic task" });
    assert.equal((await getDoc(doc(owner.db, path))).data()?.title, "Synthetic task");
    const completion = createOccurrenceCompletion(occurrenceId("daily", "2026-02-03"), "2026-02-03T12:00:00Z");
    await setDoc(doc(owner.db, `users/${ownerAccount.user.uid}/completions/${completion.occurrenceId}`), completion);
    assert.deepEqual((await getDoc(doc(owner.db, `users/${ownerAccount.user.uid}/completions/${completion.occurrenceId}`))).data(), completion);
    assert.equal((await getDoc(doc(owner.db, `users/${ownerAccount.user.uid}/completions/${occurrenceId("daily", "2026-02-04")}`))).exists(), false);
    await createUserWithEmailAndPassword(other.auth, `other-${suffix}@example.invalid`, "password1");
    await assert.rejects(getDoc(doc(other.db, path)), { code: "permission-denied" });
    await assert.rejects(setDoc(doc(other.db, path), { title: "Denied" }), { code: "permission-denied" });
    await signOut(other.auth);
    await assert.rejects(getDoc(doc(other.db, path)), { code: "permission-denied" });
    await assert.rejects(setDoc(doc(other.db, path), { title: "Denied" }), { code: "permission-denied" });
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/**
 * The local state an undo checks against, read the way the app's store holds
 * it: the raw `lastShutdown` and each task's current deadline, nothing else.
 * Undo's preconditions are comparisons against exactly these values.
 */
function localReader(database: Firestore, uid: string, rawStamp: (data: Record<string, unknown> | undefined) => unknown) {
  const taskPath = (id: string) => `users/${uid}/tasks/${id}`;
  const profilePath = `users/${uid}/profile/main`;
  return {
    taskPath,
    profilePath,
    read: async (path: string): Promise<Record<string, unknown> | undefined> =>
      (await getDoc(doc(database, path))).data(),
    async state(taskIds: readonly string[]): Promise<ShutdownState> {
      const tasks: { id: string; deadline?: string }[] = [];
      for (const id of taskIds) {
        const data = (await getDoc(doc(database, taskPath(id)))).data();
        if (data === undefined) continue;
        tasks.push({ id, ...(typeof data.deadline === "string" ? { deadline: data.deadline } : {}) });
      }
      return {
        tasks,
        lastShutdown: rawStamp((await getDoc(doc(database, profilePath))).data()),
      };
    },
  };
}

/**
 * The shutdown roll (F3a) against real Firestore: one atomic batch moves the
 * due and overdue deadlines and stamps `profile.lastShutdown`, and its undo
 * puts every previous deadline and the previous stamp back — deleting the
 * stamp when the close being undone was the first one. Undo is checked against
 * the local state the app holds, so this test builds that state from the
 * emulator documents after each close.
 *
 * `data/tasks.ts` binds the browser database when it loads (`data/client.ts`
 * reads `window.location` and builds the persistent cache), so this test gives
 * Node the one global that module needs and passes its own authenticated
 * client to the batch; the app calls the same functions with the default
 * database. What is exercised here is the real batch, not a copy of it.
 */
test("the shutdown roll and its undo are one batch over exactly the named documents", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { closeDay, undoCloseDay } = await import("../src/data/tasks.ts");
  const { storedLastShutdown } = await import("../src/data/profile.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`shutdown-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `shutdown-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const zone = "America/Argentina/Buenos_Aires";
    const today = "2026-05-04";
    const tomorrow = "2026-05-05";
    const local = localReader(owner.db, uid, storedLastShutdown);
    const { taskPath } = local;

    const storedTasks: Record<string, Record<string, unknown>> = {
      // `notes` stands in for any optional field this version does not know:
      // the batch names `deadline`, so nothing else can be lost.
      due: { title: "Due today", completed: false, deadline: today, estimate: 30, notes: "call the vet" },
      overdue: { title: "Overdue", completed: false, deadline: "2026-05-02" },
      future: { title: "Later", completed: false, deadline: "2026-05-09" },
      tray: { title: "No deadline", completed: false },
      finished: { title: "Done today", completed: true, completedAt: "2026-05-04T12:00:00-03:00", deadline: today },
    };
    for (const [id, data] of Object.entries(storedTasks)) await setDoc(doc(owner.db, taskPath(id)), data);

    const blockToday = { start: "2026-05-04T10:00:00-03:00", end: "2026-05-04T11:00:00-03:00", taskId: "tray" };
    const blockPast = { start: "2026-05-01T10:00:00-03:00", end: "2026-05-01T11:00:00-03:00", taskId: "future" };
    await setDoc(doc(owner.db, `users/${uid}/blocks/block-today`), blockToday);
    await setDoc(doc(owner.db, `users/${uid}/blocks/block-past`), blockPast);

    // A series due today: the roll moves task deadlines, never a recurring
    // definition or the immutable completion record of one occurrence.
    const series = { title: "Standup", frequency: "daily", anchorDate: "2026-05-01", deadline: today };
    await setDoc(doc(owner.db, `users/${uid}/series/standup`), series);
    const completion = createOccurrenceCompletion(occurrenceId("standup", today), "2026-05-04T09:05:00-03:00");
    await setDoc(doc(owner.db, `users/${uid}/completions/${completion.occurrenceId}`), completion);

    // The first close of this profile: it carries no stamp yet, so its undo
    // must delete the field rather than leave an empty or guessed day behind.
    const profile = { timeZone: zone, workStart: "480", workEnd: "1260" };
    await setDoc(doc(owner.db, `users/${uid}/profile/main`), profile);

    const tasks: ShutdownTask[] = [
      { id: "due", title: "Due today", completed: false, deadline: today },
      { id: "overdue", title: "Overdue", completed: false, deadline: "2026-05-02" },
      { id: "future", title: "Later", completed: false, deadline: "2026-05-09" },
      { id: "tray", title: "No deadline", completed: false },
      { id: "finished", title: "Done today", completed: true, deadline: today, completedAt: "2026-05-04T12:00:00-03:00" },
    ];
    const blocks: ShutdownBlock[] = [
      { taskId: "tray", start: "2026-05-04T10:00:00-03:00" },
      { taskId: "future", start: "2026-05-01T10:00:00-03:00" },
    ];
    const plan = planCloseDay({ tasks, blocks, today, timeZone: zone });
    assert.deepEqual(plan.lastShutdown, { before: undefined, after: today });
    assert.deepEqual(plan.moves, [
      { taskId: "overdue", before: "2026-05-02", after: tomorrow },
      { taskId: "due", before: today, after: tomorrow },
    ]);

    await closeDay(uid, plan, owner.db);

    const afterClose = async (path: string) => (await getDoc(doc(owner.db, path))).data();
    assert.deepEqual(await afterClose(taskPath("due")), { ...storedTasks.due, deadline: tomorrow });
    assert.deepEqual(await afterClose(taskPath("overdue")), { ...storedTasks.overdue, deadline: tomorrow });
    assert.deepEqual(await afterClose(taskPath("future")), storedTasks.future);
    assert.deepEqual(await afterClose(taskPath("tray")), storedTasks.tray, "a task with no deadline gains none");
    assert.deepEqual(await afterClose(taskPath("finished")), storedTasks.finished);
    assert.deepEqual(await afterClose(`users/${uid}/profile/main`), { ...profile, lastShutdown: today });
    assert.deepEqual(await afterClose(`users/${uid}/series/standup`), series);
    assert.deepEqual(await afterClose(`users/${uid}/completions/${completion.occurrenceId}`), completion);
    assert.deepEqual(await afterClose(`users/${uid}/blocks/block-today`), blockToday);
    assert.deepEqual(await afterClose(`users/${uid}/blocks/block-past`), blockPast, "past blocks are never touched");

    // A second device sees lastShutdown = today and rolls nothing.
    const second = planCloseDay({
      tasks: tasks.map(item => (item.id === "due" || item.id === "overdue" ? { ...item, deadline: tomorrow } : item)),
      blocks,
      today,
      timeZone: zone,
      lastShutdown: today,
    });
    assert.equal(second.alreadyClosed, true);
    assert.deepEqual(second.moves, []);
    await closeDay(uid, second, owner.db);
    assert.deepEqual(await afterClose(taskPath("due")), { ...storedTasks.due, deadline: tomorrow });

    await undoCloseDay(uid, plan, await local.state(["due", "overdue", "future", "tray", "finished"]), owner.db);

    assert.deepEqual(await afterClose(taskPath("due")), storedTasks.due, "undo restores the exact deadline");
    assert.deepEqual(await afterClose(taskPath("overdue")), storedTasks.overdue);
    assert.deepEqual(await afterClose(taskPath("future")), storedTasks.future);
    assert.deepEqual(
      await afterClose(`users/${uid}/profile/main`),
      profile,
      "undo deletes the first stamp and leaves the rest of the profile alone",
    );
    assert.deepEqual(await afterClose(`users/${uid}/series/standup`), series);
    assert.deepEqual(await afterClose(`users/${uid}/blocks/block-past`), blockPast);

    // An earlier close left a stamp: closing again restores that exact day,
    // and a stale stamp never counts as "today is already closed".
    await setDoc(doc(owner.db, `users/${uid}/profile/main`), { lastShutdown: "2026-05-03" }, { merge: true });
    const again = planCloseDay({ tasks, blocks, today, timeZone: zone, lastShutdown: "2026-05-03" });
    assert.equal(again.alreadyClosed, false);
    await closeDay(uid, again, owner.db);
    assert.equal((await afterClose(`users/${uid}/profile/main`))?.lastShutdown, today);
    await undoCloseDay(uid, again, await local.state(["due", "overdue", "future", "tray", "finished"]), owner.db);
    assert.deepEqual(
      await afterClose(`users/${uid}/profile/main`),
      { ...profile, lastShutdown: "2026-05-03" },
      "undo puts back the previous stamp",
    );
  } finally {
    await close(owner);
  }
});

/**
 * The guarded undo (F3a2): undo compares the local state with what the close
 * wrote instead of replaying blind. A deadline edited after the close keeps its
 * edit and is counted as skipped; a stamp a later close replaced makes undo
 * refuse before the batch is built, so the later roll and its stamp stay.
 */
test("undo leaves a later edit alone and refuses after a later close", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { closeDay, undoCloseDay } = await import("../src/data/tasks.ts");
  const { storedLastShutdown } = await import("../src/data/profile.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`shutdown-guard-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `shutdown-guard-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const zone = "America/Argentina/Buenos_Aires";
    const today = "2026-05-04";
    const tomorrow = "2026-05-05";
    const local = localReader(owner.db, uid, storedLastShutdown);
    const { taskPath, profilePath, read } = local;

    const profile = { timeZone: zone, shutdownTime: 1080 };
    await setDoc(doc(owner.db, profilePath), profile);
    const stored: Record<string, Record<string, unknown>> = {
      untouched: { title: "Pay rent", completed: false, deadline: today, estimate: 15, notes: "call the vet" },
      edited: { title: "Write report", completed: false, deadline: today, estimate: 45 },
      done: { title: "Sent invoice", completed: true, completedAt: "2026-05-04T18:00:00-03:00", deadline: today, estimate: 10 },
    };
    for (const [id, data] of Object.entries(stored)) await setDoc(doc(owner.db, taskPath(id)), data);

    const plan = planCloseDay({
      tasks: [
        { id: "untouched", title: "Pay rent", completed: false, deadline: today },
        { id: "edited", title: "Write report", completed: false, deadline: today },
        { id: "done", title: "Sent invoice", completed: true, completedAt: "2026-05-04T18:00:00-03:00", deadline: today },
      ],
      blocks: [],
      today,
      timeZone: zone,
    });
    assert.deepEqual(plan.moves.map(move => move.taskId), ["untouched", "edited"]);
    await closeDay(uid, plan, owner.db);

    // Closing writes one field per task: the estimate, the completion instant,
    // the title and the field this version does not know all survive.
    assert.deepEqual(await read(taskPath("untouched")), { ...stored.untouched, deadline: tomorrow });
    assert.deepEqual(await read(taskPath("edited")), { ...stored.edited, deadline: tomorrow });
    assert.deepEqual(await read(taskPath("done")), stored.done, "a completed task is never touched");

    // Somebody moves the task after the close. Undo must not put the closed
    // day's deadline back over that edit.
    await setDoc(doc(owner.db, taskPath("edited")), { deadline: "2026-05-10" }, { merge: true });

    assert.deepEqual(
      await undoCloseDay(uid, plan, await local.state(["untouched", "edited", "done"]), owner.db),
      { reverted: 1, skipped: 1 },
      "one deadline comes back, the later edit is only counted",
    );
    assert.deepEqual(await read(taskPath("untouched")), stored.untouched, "every other field is still there");
    assert.deepEqual(await read(taskPath("edited")), { ...stored.edited, deadline: "2026-05-10" });
    assert.deepEqual(await read(profilePath), profile, "the first close's stamp is deleted, nothing else");

    // Close this day, then close the next one: the second close owns the stamp.
    const first = planCloseDay({
      tasks: [{ id: "untouched", title: "Pay rent", completed: false, deadline: today }],
      blocks: [],
      today,
      timeZone: zone,
    });
    await closeDay(uid, first, owner.db);
    const second = planCloseDay({
      tasks: [{ id: "untouched", title: "Pay rent", completed: false, deadline: tomorrow }],
      blocks: [],
      today: tomorrow,
      timeZone: zone,
      lastShutdown: storedLastShutdown(await read(profilePath)),
    });
    await closeDay(uid, second, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), tomorrow);

    assert.deepEqual(
      await undoCloseDay(uid, first, await local.state(["untouched", "edited", "done"]), owner.db),
      { reverted: 0, skipped: 0, refused: "later-close" },
      "the stamp is the second close's now, so the first undo refuses",
    );
    assert.deepEqual(
      await read(taskPath("untouched")),
      { ...stored.untouched, deadline: "2026-05-06" },
      "the refusal wrote nothing: the second close's roll stands",
    );
    assert.equal(storedLastShutdown(await read(profilePath)), tomorrow);
  } finally {
    await close(owner);
  }
});

/**
 * The two stamp rules (F3a2): a stored day later than today counts as closed
 * and is never moved backwards, an unreadable stamp is restored raw rather
 * than deleted, and a day one batch cannot hold writes nothing at all.
 */
test("a future or unreadable stamp is never rewritten and too many moves write nothing", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { closeDay, undoCloseDay } = await import("../src/data/tasks.ts");
  const { storedLastShutdown } = await import("../src/data/profile.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`shutdown-stamp-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `shutdown-stamp-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const zone = "America/Argentina/Buenos_Aires";
    const today = "2026-05-04";
    const local = localReader(owner.db, uid, storedLastShutdown);
    const { taskPath, profilePath, read } = local;

    await setDoc(doc(owner.db, profilePath), { timeZone: zone });
    await setDoc(doc(owner.db, taskPath("late")), { title: "Late", completed: false, deadline: today });

    // A profile zone change or a clock set back can leave a stamp from the
    // future. That day is closed; rewriting it with today would move the
    // ritual's history backwards.
    await setDoc(doc(owner.db, profilePath), { lastShutdown: "2026-06-01" }, { merge: true });
    const future = planCloseDay({ tasks: [{ id: "late", title: "Late", completed: false, deadline: today }], today, blocks: [], timeZone: zone, lastShutdown: storedLastShutdown(await read(profilePath)) });
    assert.equal(future.alreadyClosed, true);
    assert.deepEqual(future.moves, []);
    await closeDay(uid, future, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), "2026-06-01", "the stamp is never moved backwards");
    assert.deepEqual(await read(taskPath("late")), { title: "Late", completed: false, deadline: today });

    // An unreadable stamp is not a day: the close rolls, and undo puts the raw
    // value back instead of deleting what it cannot read.
    await setDoc(doc(owner.db, profilePath), { lastShutdown: "2026-5-4" }, { merge: true });
    const raw = planCloseDay({ tasks: [{ id: "late", title: "Late", completed: false, deadline: today }], today, blocks: [], timeZone: zone, lastShutdown: storedLastShutdown(await read(profilePath)) });
    assert.equal(raw.alreadyClosed, false);
    assert.deepEqual(raw.lastShutdown, { before: "2026-5-4", after: today });
    await closeDay(uid, raw, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), today);
    assert.deepEqual(await undoCloseDay(uid, raw, await local.state(["late"]), owner.db), { reverted: 1, skipped: 0 });
    assert.equal(storedLastShutdown(await read(profilePath)), "2026-5-4", "undo restores the raw value");
    assert.deepEqual(await read(taskPath("late")), { title: "Late", completed: false, deadline: today });

    // One batch holds 500 writes: 499 moves and the stamp. A day with more due
    // tasks is refused as a plan, so the data layer never builds a batch that
    // could not be atomic.
    const tooMany = planCloseDay({
      tasks: Array.from({ length: maxCloseDayMoves + 1 }, (_, index) => ({ id: `due-${index}`, title: `Due ${index}`, completed: false, deadline: today })),
      today,
      blocks: [],
      timeZone: zone,
      lastShutdown: storedLastShutdown(await read(profilePath)),
    });
    assert.equal(tooMany.refused, "too-many-moves");
    assert.deepEqual(tooMany.moves, []);
    await closeDay(uid, tooMany, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), "2026-5-4", "a refused close writes nothing");
    assert.deepEqual(await read(taskPath("late")), { title: "Late", completed: false, deadline: today });
  } finally {
    await close(owner);
  }
});

/**
 * The sheet's side of a later close (F3c review item 4): an undo of a close a
 * later one has stamped away refuses, writes nothing, and owes the "later
 * close" sentence the ritual shows -- never the rejected-close one (item 5).
 * The sheet reads this state live (App.tsx keeps it), so the comparison pinned
 * here is exactly the one the sheet makes.
 */
test("undo of an earlier close refuses once a later close owns the day, and says so", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { closeDay, undoCloseDay } = await import("../src/data/tasks.ts");
  const { storedLastShutdown } = await import("../src/data/profile.ts");
  const { undoMessage } = await import("../src/ui/shutdownRitual.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`shutdown-later-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `shutdown-later-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const zone = "America/Argentina/Buenos_Aires";
    const today = "2026-05-04";
    const tomorrow = "2026-05-05";
    const local = localReader(owner.db, uid, storedLastShutdown);
    const { taskPath, profilePath, read } = local;

    await setDoc(doc(owner.db, profilePath), { timeZone: zone });
    await setDoc(doc(owner.db, taskPath("late")), { title: "Late", completed: false, deadline: today });

    const first = planCloseDay({
      tasks: [{ id: "late", title: "Late", completed: false, deadline: today }],
      blocks: [],
      today,
      timeZone: zone,
      lastShutdown: storedLastShutdown(await read(profilePath)),
    });
    await closeDay(uid, first, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), today);

    // The next day is closed too: this close owns the stamp now.
    const second = planCloseDay({
      tasks: [{ id: "late", title: "Late", completed: false, deadline: tomorrow }],
      blocks: [],
      today: tomorrow,
      timeZone: zone,
      lastShutdown: storedLastShutdown(await read(profilePath)),
    });
    await closeDay(uid, second, owner.db);
    assert.equal(storedLastShutdown(await read(profilePath)), tomorrow);

    const undo = await undoCloseDay(uid, first, await local.state(["late"]), owner.db);
    assert.deepEqual(undo, { reverted: 0, skipped: 0, refused: "later-close" }, "the first close is not this one's to revert");
    assert.equal(
      undoMessage({ kind: "refused", refusal: undo.refused! }),
      "The day was closed again, so nothing was undone.",
      "and the sheet says why, instead of returning to Today silently",
    );

    // The refusal wrote nothing: the later close's roll and its stamp stand.
    assert.deepEqual(await read(taskPath("late")), { title: "Late", completed: false, deadline: "2026-05-06" });
    assert.equal(storedLastShutdown(await read(profilePath)), tomorrow);
  } finally {
    await close(owner);
  }
});

/**
 * Plan my day (F4b) against real Firestore: one `writeBatch` writes every block
 * of a plan and returns exactly their document ids, and its undo deletes those
 * documents and nothing else — an older block on the same day and the tasks the
 * plan points at are untouched.
 *
 * `data/blocks.ts` binds the browser database when it loads (`data/client.ts`
 * reads `window.location` and builds the persistent cache), so this test gives
 * Node the one global that module needs and passes its own authenticated client
 * to the batch; the app calls the same functions with the default database.
 * What is exercised here is the real batch, not a copy of it.
 */
test("a plan is one batch of blocks, and its undo removes exactly those documents", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { addBlocks, removeBlocks } = await import("../src/data/blocks.ts");
  const { collection, getDocs } = await import("firebase/firestore");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`plan-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `plan-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const blocksPath = `users/${uid}/blocks`;
    const day = "2026-05-04";
    const earlier = { start: `${day}T10:00:00+00:00`, end: `${day}T11:00:00+00:00` };
    await setDoc(doc(owner.db, `${blocksPath}/earlier`), earlier);
    await setDoc(doc(owner.db, `users/${uid}/tasks/report`), { title: "Report", completed: false });
    const stored = async () => {
      const snapshot = await getDocs(collection(owner.db, blocksPath));
      return snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
    };

    /* One batch, two blocks, and the ids come back so the caller can offer the
       exact undo without reading the collection. */
    const plan = [
      { start: `${day}T08:00:00+00:00`, end: `${day}T09:00:00+00:00`, taskId: "report" },
      { start: `${day}T11:00:00+00:00`, end: `${day}T11:30:00+00:00`, taskId: "report" },
    ];
    const { ids, done } = addBlocks(uid, plan, owner.db);
    assert.equal(ids.length, 2);
    await done;

    const afterPlan = await stored();
    assert.equal(afterPlan.length, 3);
    for (const [index, id] of ids.entries()) {
      const document = afterPlan.find(entry => entry.id === id);
      assert.deepEqual(document, { id, ...plan[index] }, "the block holds exactly the plan's instants and task link");
    }
    assert.deepEqual(afterPlan.find(entry => entry.id === "earlier"), { id: "earlier", ...earlier });

    await removeBlocks(uid, ids, owner.db);
    assert.deepEqual(await stored(), [{ id: "earlier", ...earlier }], "the undo removes the new blocks and nothing else");
    assert.equal((await getDoc(doc(owner.db, `users/${uid}/tasks/report`))).data()?.title, "Report");

    /* A rejected block never reaches Firestore: validation runs before the
       batch is built, so an inverted range writes none of the plan. */
    assert.throws(() => addBlocks(uid, [{ start: plan[0].end, end: plan[0].start }], owner.db));
    assert.equal((await stored()).length, 1);

    /* An empty plan is not a write. */
    const nothing = addBlocks(uid, [], owner.db);
    assert.deepEqual(nothing.ids, []);
    await nothing.done;
    assert.equal((await stored()).length, 1);
  } finally {
    await close(owner);
  }
});

/**
 * Holiday labels (S11) against real Firestore: the owner reads and writes
 * `users/{uid}/holidays`, nobody else does, and an import's merge write
 * refreshes Google's fields without touching the user's override or hidden
 * flag. The helpers take the test's authenticated database, as `addBlocks` does.
 */
test("holiday labels are owner-only and a re-import keeps the user's choices", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { setHolidayHidden, setHolidayKindOverride, writeHolidays } = await import("../src/data/holidays.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`holiday-owner-${suffix}`);
  const other = client(`holiday-other-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `holiday-owner-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const source = { provider: "gcal" as const, calendarId: "es.ar#holiday@group.v.calendar.google.com", eventId: "20261207_a" };
    const holiday = { id: "gcal_es-ar-holiday_20261207_a", date: "2026-12-07", title: "Puente turístico", kind: "nonWorking" as const, source };
    const path = `users/${uid}/holidays/${holiday.id}`;

    assert.equal(await writeHolidays(uid, [holiday], owner.db), 1);
    assert.deepEqual((await getDoc(doc(owner.db, path))).data(), { date: "2026-12-07", title: "Puente turístico", kind: "nonWorking", source });

    await setHolidayKindOverride(uid, holiday.id, "public", owner.db);
    await setHolidayHidden(uid, holiday.id, true, owner.db);
    // Google renames the event and reclassifies it; the user's choices stay.
    await writeHolidays(uid, [{ ...holiday, title: "Feriado puente", kind: "observance" }], owner.db);
    assert.deepEqual((await getDoc(doc(owner.db, path))).data(), {
      date: "2026-12-07", title: "Feriado puente", kind: "observance", source, kindOverride: "public", hidden: true,
    });
    await setHolidayKindOverride(uid, holiday.id, undefined, owner.db);
    await setHolidayHidden(uid, holiday.id, false, owner.db);
    assert.equal((await getDoc(doc(owner.db, path))).data()?.kindOverride, undefined);
    assert.equal((await getDoc(doc(owner.db, path))).data()?.hidden, undefined);
    await assert.rejects(setHolidayKindOverride(uid, holiday.id, "bogus" as never, owner.db), /holiday kind is invalid/);

    await createUserWithEmailAndPassword(other.auth, `holiday-other-${suffix}@example.invalid`, "password1");
    await assert.rejects(getDoc(doc(other.db, path)), { code: "permission-denied" });
    await assert.rejects(writeHolidays(uid, [holiday], other.db), { code: "permission-denied" });
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/**
 * The holiday cleanup (S11) against real Firestore. It deletes stored data, so
 * this pins the whole guarantee: of a mixed task list only the tasks the
 * selection proves came from a holiday calendar are deleted, each after its
 * label is stored, and a failing label write deletes nothing.
 */
test("cleanup deletes only holiday-calendar tasks, labels first, and nothing when the label write fails", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { cleanupHolidayTasks } = await import("../src/data/holidays.ts");
  const { collection, getDocs } = await import("firebase/firestore");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`cleanup-owner-${suffix}`);
  const other = client(`cleanup-other-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `cleanup-owner-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const holidayCalendar = "es.ar#holiday@group.v.calendar.google.com";
    const normalCalendar = "abc123@group.calendar.google.com";
    const holidayTaskId = `gcal_${calendarKey(holidayCalendar)}_20261207_a`;
    const sameTitle = "Puente turístico";
    const seeded: Record<string, Record<string, unknown>> = {
      [holidayTaskId]: { title: sameTitle, completed: false, deadline: "2026-12-07" },
      [`gcal_${calendarKey(holidayCalendar)}_20261225_nodate`]: { title: "Sin fecha", completed: false },
      [`gcal_${calendarKey(normalCalendar)}_x1`]: { title: sameTitle, completed: false, deadline: "2026-12-07" },
      [`gcal_${calendarKey("primary")}_a1`]: { title: "Renew passport", completed: false, deadline: "2026-12-07" },
      "kJ3x9QmZpT0aLw2vB7nC": { title: sameTitle, completed: false, deadline: "2026-12-07" },
    };
    for (const [id, data] of Object.entries(seeded)) await setDoc(doc(owner.db, `users/${uid}/tasks/${id}`), data);
    const stored = async (name: string) => (await getDocs(collection(owner.db, `users/${uid}/${name}`))).docs.map(entry => ({ ...entry.data(), id: entry.id }) as Record<string, unknown> & { id: string });
    const tasks = (await stored("tasks")).map(task => ({ id: task.id, title: String(task.title), ...(typeof task.deadline === "string" ? { deadline: task.deadline } : {}) }));
    const selected = selectHolidayTasks(tasks, [{ id: "primary" }, { id: normalCalendar }, { id: holidayCalendar }]);
    assert.deepEqual(selected.map(item => item.task.id).sort(), [holidayTaskId, `gcal_${calendarKey(holidayCalendar)}_20261225_nodate`].sort());
    const plan = planHolidayCleanup(selected, new Map(), []);
    assert.deepEqual(plan.deletable, [holidayTaskId]);

    // A write the server refuses (another account's subtree) stops before any delete.
    await createUserWithEmailAndPassword(other.auth, `cleanup-other-${suffix}@example.invalid`, "password1");
    await assert.rejects(cleanupHolidayTasks(uid, plan, other.db), { code: "permission-denied" });
    assert.equal((await stored("tasks")).length, 5);
    assert.deepEqual(await stored("holidays"), []);

    assert.deepEqual(await cleanupHolidayTasks(uid, plan, owner.db), { labels: 1, tasks: 1, total: 1 });
    const remaining = (await stored("tasks")).map(task => task.id).sort();
    assert.deepEqual(remaining, Object.keys(seeded).filter(id => id !== holidayTaskId).sort());
    const labels = await stored("holidays");
    assert.deepEqual(labels.map(label => [label.id, label.date, label.title]), [[holidayTaskId, "2026-12-07", sameTitle]]);
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/* ------------------------------------------------------------ weekly review */

/**
 * The weekly review's storage (ronda 2 W2a, spec S3) against real Firestore:
 * one document per ISO week holding the week's state and its reflection note.
 * The module imports the app's client, so it is loaded the way the cleanup
 * test loads its data module: with a window shim, after the process has
 * started, and every write is driven through the emulator's own database.
 */
test("the weekly review week document holds state and note, owner-only, with the note capped", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { clearWeeklyReviewSnooze, markWeeklyStepDone, readWeeklyReview, saveWeeklyReviewNote, saveWeeklyReviewState, skipWeeklyReview, snoozeWeeklyReview } =
    await import("../src/data/weeklyReview.ts");
  const { MAX_NOTE_CHARS } = await import("../src/planning/weekly.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`weekly-owner-${suffix}`);
  const other = client(`weekly-other-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `weekly-owner-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const week = "2026-W43";

    // A fresh week reads as an empty state, not as an error.
    assert.deepEqual(await readWeeklyReview(uid, week, owner.db), { week, stepsDone: [], skipped: false });

    // The state write owns skipped and the snooze only: a cleared snooze is
    // deleted, not kept stale. Step marks are never written here — they go
    // through markWeeklyStepDone's array-union — so a state save cannot
    // clobber the mark another device made offline.
    await saveWeeklyReviewState(uid, { week, stepsDone: ["review"], skipped: false, snoozedUntil: "2026-10-23T18:00:00Z" }, owner.db);
    await markWeeklyStepDone(uid, week, "cleanup", owner.db);
    await saveWeeklyReviewState(uid, { week, stepsDone: [], skipped: false }, owner.db);
    assert.deepEqual(await readWeeklyReview(uid, week, owner.db), { week, stepsDone: ["cleanup"], skipped: false });

    // Step marks merge (an array-union transform), so two devices can both
    // mark while offline without losing the other's step.
    await markWeeklyStepDone(uid, week, "reflect", owner.db);
    await markWeeklyStepDone(uid, week, "reflect", owner.db);
    assert.deepEqual((await readWeeklyReview(uid, week, owner.db)).stepsDone, ["cleanup", "reflect"]);

    // Skip and snooze write their own field and leave the steps alone.
    await skipWeeklyReview(uid, week, owner.db);
    await snoozeWeeklyReview(uid, week, "2026-10-23T20:00:00Z", owner.db);
    const skipped = await readWeeklyReview(uid, week, owner.db);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.snoozedUntil, "2026-10-23T20:00:00Z");
    // Opening the review by hand clears the snooze.
    await clearWeeklyReviewSnooze(uid, week, owner.db);
    assert.equal((await readWeeklyReview(uid, week, owner.db)).snoozedUntil, undefined);

    // The note round-trips, and an edit keeps the first createdAt: the
    // note's instant is when it was written, not when it was last touched.
    await saveWeeklyReviewNote(uid, week, "  Went well; deadlines slipped on Friday.  ", owner.db);
    const noted = await readWeeklyReview(uid, week, owner.db);
    assert.equal(noted.note?.text, "Went well; deadlines slipped on Friday.");
    assert.ok(typeof noted.note?.createdAt === "string" && Number.isFinite(Date.parse(noted.note.createdAt)));
    await new Promise(resolve => setTimeout(resolve, 20));
    await saveWeeklyReviewNote(uid, week, "Went well; deadlines slipped. Next week: fewer.", owner.db);
    const edited = await readWeeklyReview(uid, week, owner.db);
    assert.equal(edited.note?.text, "Went well; deadlines slipped. Next week: fewer.");
    assert.equal(edited.note?.createdAt, noted.note?.createdAt);
    assert.ok(typeof edited.note?.updatedAt === "string" && Number.isFinite(Date.parse(edited.note.updatedAt)));

    // Rejected input never reaches Firestore: an oversized note, an empty one,
    // a bad week key and an unknown step all throw before any write.
    const before = await readWeeklyReview(uid, week, owner.db);
    await assert.rejects(saveWeeklyReviewNote(uid, week, "x".repeat(MAX_NOTE_CHARS + 1), owner.db), /at most/);
    await assert.rejects(saveWeeklyReviewNote(uid, week, "   ", owner.db), /empty/);
    await assert.rejects(saveWeeklyReviewState(uid, { week: "2026-43", stepsDone: [], skipped: false }, owner.db), /ISO week key/);
    await assert.rejects(markWeeklyStepDone(uid, week, "nap" as never, owner.db), /review, cleanup, plan or reflect/);
    await assert.rejects(snoozeWeeklyReview(uid, week, "later", owner.db), /instant/);
    assert.deepEqual(await readWeeklyReview(uid, week, owner.db), before);

    // The subtree is owner-only, exactly like every other collection: another
    // signed-in user and a signed-out client are denied, read and write.
    await createUserWithEmailAndPassword(other.auth, `weekly-other-${suffix}@example.invalid`, "password1");
    await assert.rejects(readWeeklyReview(uid, week, other.db), { code: "permission-denied" });
    await assert.rejects(saveWeeklyReviewState(uid, { week, stepsDone: [], skipped: true }, other.db), { code: "permission-denied" });
    await assert.rejects(saveWeeklyReviewNote(uid, week, "nope", other.db), { code: "permission-denied" });
    await signOut(other.auth);
    await assert.rejects(readWeeklyReview(uid, week, other.db), { code: "permission-denied" });
    await assert.rejects(saveWeeklyReviewNote(uid, week, "nope", other.db), { code: "permission-denied" });
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/** The someday flag the Clean-up step writes: additive task data, owner-only. */
test("the someday flag is a boolean task field only its owner may set", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { setTaskSomeday } = await import("../src/data/weeklyReview.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`someday-owner-${suffix}`);
  const other = client(`someday-other-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `someday-owner-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/stale`;
    await setDoc(doc(owner.db, path), { title: "Stale task", completed: false });

    await setTaskSomeday(uid, "stale", true, owner.db);
    assert.equal((await getDoc(doc(owner.db, path))).data()?.someday, true);
    await setTaskSomeday(uid, "stale", false, owner.db);
    assert.equal((await getDoc(doc(owner.db, path))).data()?.someday, undefined);

    // Rejected input never reaches Firestore.
    await assert.rejects(setTaskSomeday(uid, "a/b", true, owner.db), /task ID/);

    await createUserWithEmailAndPassword(other.auth, `someday-other-${suffix}@example.invalid`, "password1");
    await assert.rejects(setTaskSomeday(uid, "stale", true, other.db), { code: "permission-denied" });
    await signOut(other.auth);
    await assert.rejects(setTaskSomeday(uid, "stale", true, other.db), { code: "permission-denied" });
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/**
 * Delete → undo keeps every field the row showed, including the someday flag
 * (r2-w2a review #2): the restore rewrites the closed task schema through
 * `taskFields`, so the flag has to ride in the deleted snapshot, the field
 * list and the restore. The read path (`toTask`) must map it back so the
 * snapshot the next delete captures carries it.
 */
test("a someday task survives delete and undo, and the read path maps the flag", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { deleteTask, restoreTask } = await import("../src/data/tasks.ts");
  const { toTask } = await import("../src/data/store.ts");
  const { setTaskSomeday } = await import("../src/data/weeklyReview.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`undo-someday-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `undo-someday-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/shelf`;
    await setDoc(doc(owner.db, path), { title: "Shelved", completed: false, deadline: "2026-03-20" });
    await setTaskSomeday(uid, "shelf", true, owner.db);

    // The store's read path maps the flag, so the snapshot a delete captures
    // carries it.
    const snapshot = await getDoc(doc(owner.db, path));
    const deleted = toTask(snapshot as never);
    assert.equal(deleted.someday, true);

    await deleteTask(uid, "shelf", owner.db);
    assert.equal((await getDoc(doc(owner.db, path))).exists(), false);
    await restoreTask(uid, deleted, owner.db);
    const restored = (await getDoc(doc(owner.db, path))).data();
    assert.equal(restored?.someday, true);
    assert.equal(restored?.title, "Shelved");
    assert.equal(restored?.deadline, "2026-03-20");
    assert.equal(restored?.completed, false);
  } finally {
    await close(owner);
  }
});

/** The Rituals settings write the parsed, normalized shape (review nit #7):
 *  duplicate steps collapse and unknown keys never reach the profile. */
test("weekly review settings are written normalized", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { profileDocument, setProfileWeeklyReview } = await import("../src/data/profile.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`weekly-settings-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `weekly-settings-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    await setProfileWeeklyReview(uid, {
      nudges: false,
      moments: [{ day: 5, time: 1000, steps: ["review", "review"], stray: 1 } as never],
    }, owner.db);
    const stored = (await getDoc(profileDocument(uid, owner.db))).data()?.weeklyReview;
    assert.deepEqual(stored, { nudges: false, moments: [{ day: 5, time: 1000, steps: ["review"] }] });
  } finally {
    await close(owner);
  }
});

/* ------------------------- actual minutes per day (ronda 2, S3/L6) -------- */

/**
 * The per-day map a task may hold next to its cumulative counter. The reader
 * is tolerant (a hand-edited document may hold anything): only whole-day keys
 * with finite numbers survive, and values are floored to whole minutes and
 * capped at the counter bound. The map stays SIGNED: storage may hold a
 * negative day (an older build attributed an away subtraction to the span's
 * own day, so a cross-midnight span could land where its credit did not), and
 * the reviewer clamps once at each task's in-week sum — clamping here would
 * hide a real negative and make the weekly total wrong, and undo would
 * persist the clamped map over the stored one.
 */
test("a per-day actual map reads only real days with signed whole-minute counts", () => {
  assert.equal(parseActualByDay(undefined), undefined);
  assert.equal(parseActualByDay("nope"), undefined);
  assert.equal(parseActualByDay([]), undefined);
  assert.equal(parseActualByDay({}), undefined); // empty is no data
  assert.deepEqual(parseActualByDay({ "2026-03-24": 45, "2026-03-28": 1 }), { "2026-03-24": 45, "2026-03-28": 1 });
  // Floors, caps and drops, but does NOT clamp: a negative day survives as
  // the negative it is; non-days and non-numbers never survive.
  assert.deepEqual(
    parseActualByDay({ "2026-03-24": -15, "2026-03-25": 30.9, "2026-2-24": 10, "not-a-day": 5, "2026-03-26": "x", "2026-03-27": Number.NaN }),
    { "2026-03-24": -15, "2026-03-25": 30 },
  );
  assert.deepEqual(parseActualByDay({ "2026-03-24": MAX_ACTUAL_MINUTES + 1 }), { "2026-03-24": MAX_ACTUAL_MINUTES });
});

/**
 * Every focus-session write records the cumulative counter AND the day map in
 * the SAME updateDoc (L6): two field transforms, one atomic write, so a
 * device that sees one sees the other and an offline queue drains both
 * together. The day key is the profile-zone day the session started.
 */
test("a session's increment lands on the total and its day in one atomic write", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { addActualMinutes } = await import("../src/data/tasks.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`byday-owner-${suffix}`);
  const other = client(`byday-other-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `byday-owner-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/tracked`;
    await setDoc(doc(owner.db, path), { title: "Tracked task", completed: false });

    await addActualMinutes(uid, "tracked", 20, "2026-03-24", owner.db);
    const stored = (await getDocFromServer(doc(owner.db, path))).data();
    assert.equal(stored?.actualMinutes, 20);
    assert.equal(stored?.actualByDay?.["2026-03-24"], 20);

    // Two sessions on two days, queued offline, drain as four independent
    // transforms: each day sums what its sessions spent.
    await disableNetwork(owner.db);
    const first = addActualMinutes(uid, "tracked", 10, "2026-03-24", owner.db);
    const second = addActualMinutes(uid, "tracked", 5, "2026-03-25", owner.db);
    await enableNetwork(owner.db);
    await Promise.all([first, second]);
    const drained = (await getDocFromServer(doc(owner.db, path))).data();
    assert.equal(drained?.actualMinutes, 35);
    assert.equal(drained?.actualByDay?.["2026-03-24"], 30);
    assert.equal(drained?.actualByDay?.["2026-03-25"], 5);

    // Rejected input writes nothing at all: neither field moves.
    await assert.rejects(addActualMinutes(uid, "tracked", 0, "2026-03-24", owner.db), /whole minute/);
    await assert.rejects(addActualMinutes(uid, "tracked", 10, "24-03-2026", owner.db), /day key/);
    await assert.rejects(addActualMinutes(uid, "a/b", 10, "2026-03-24", owner.db), /task ID/);
    const unchanged = (await getDocFromServer(doc(owner.db, path))).data();
    assert.equal(unchanged?.actualMinutes, 35);
    assert.deepEqual(unchanged?.actualByDay, { "2026-03-24": 30, "2026-03-25": 5 });

    // Another authenticated user cannot write someone else's day map either.
    await createUserWithEmailAndPassword(other.auth, `byday-other-${suffix}@example.invalid`, "password1");
    await assert.rejects(addActualMinutes(uid, "tracked", 10, "2026-03-24", other.db), { code: "permission-denied" });
    await signOut(other.auth);
    await assert.rejects(addActualMinutes(uid, "tracked", 10, "2026-03-24", other.db), { code: "permission-denied" });
  } finally {
    await Promise.all([close(owner), close(other)]);
  }
});

/**
 * The idle-away subtraction (T9 S8.5) is the same two-transform write as the
 * session's increment, with a negative value on both fields: the total loses
 * the away minutes and the day the away span belongs to loses them too. The
 * day key is a parameter of the helper (the hook passes the away span's day),
 * never "now" at write time.
 */
test("an idle subtraction decrements the total and the away day in one write", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`away-day-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `away-day-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/away`;
    await setDoc(doc(owner.db, path), { title: "Away task", completed: false, actualMinutes: 30, actualByDay: { "2026-03-24": 20, "2026-03-25": 10 } });

    await subtractActualMinutesIn(owner.db, uid, "away", 12, "2026-03-24");
    const stored = (await getDocFromServer(doc(owner.db, path))).data();
    assert.equal(stored?.actualMinutes, 18);
    assert.equal(stored?.actualByDay?.["2026-03-24"], 8);
    assert.equal(stored?.actualByDay?.["2026-03-25"], 10); // the other day is untouched

    // The helper refuses what it refuses today, plus a malformed day key.
    await assert.rejects(subtractActualMinutesIn(owner.db, uid, "away", 0, "2026-03-24"), /whole minute/);
    await assert.rejects(subtractActualMinutesIn(owner.db, uid, "away", 5, "nope"), /day key/);
    await assert.rejects(subtractActualMinutesIn(owner.db, uid, "away", 5, "2026-13-40"), /day key/);
  } finally {
    await close(owner);
  }
});

/**
 * Delete → undo keeps the day map like every other tracked field: the restore
 * rewrites the closed task schema through `taskFields`, so the map must ride
 * the deleted snapshot (`DeletedTask`), the field list and the restore. The
 * read path (`toTask`) maps it back so the next delete's snapshot carries it.
 */
test("a task's day map survives delete and undo, and the read path maps it", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { deleteTask, restoreTask } = await import("../src/data/tasks.ts");
  const { toTask } = await import("../src/data/store.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`undo-byday-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `undo-byday-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/tracked`;
    await setDoc(doc(owner.db, path), { title: "Tracked", completed: false, actualMinutes: 35, actualByDay: { "2026-03-24": 30, "2026-03-25": 5 } });

    // The store's read path maps the map, so the snapshot a delete captures
    // carries it.
    const snapshot = await getDoc(doc(owner.db, path));
    const deleted = toTask(snapshot as never);
    assert.deepEqual(deleted.actualByDay, { "2026-03-24": 30, "2026-03-25": 5 });

    await deleteTask(uid, "tracked", owner.db);
    assert.equal((await getDoc(doc(owner.db, path))).exists(), false);
    await restoreTask(uid, deleted, owner.db);
    const restored = (await getDoc(doc(owner.db, path))).data();
    assert.equal(restored?.actualMinutes, 35);
    assert.deepEqual(restored?.actualByDay, { "2026-03-24": 30, "2026-03-25": 5 });
  } finally {
    await close(owner);
  }
});

/**
 * Undo writes the map back UNCHANGED, negatives included (review fix 3): the
 * restore normalizes through the same signed reader, so a stored negative day
 * — an older build's cross-midnight away subtraction — is preserved exactly,
 * never rewritten as the clamped zero while the total stays at 40.
 */
test("a negative legacy day round-trips delete and undo unchanged", async () => {
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
  const { deleteTask, restoreTask } = await import("../src/data/tasks.ts");
  const { toTask } = await import("../src/data/store.ts");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = client(`undo-negative-${suffix}`);
  try {
    const account = await createUserWithEmailAndPassword(owner.auth, `undo-negative-${suffix}@example.invalid`, "password1");
    const uid = account.user.uid;
    const path = `users/${uid}/tasks/legacy`;
    // The review's shape: a 23:30 → 00:40 session credited 70 to day 1; an
    // older build's away subtraction put −30 on day 2. Total is 40.
    await setDoc(doc(owner.db, path), { title: "Legacy", completed: false, actualMinutes: 40, actualByDay: { "2026-03-24": 70, "2026-03-25": -30 } });

    const snapshot = await getDoc(doc(owner.db, path));
    const deleted = toTask(snapshot as never);
    assert.deepEqual(deleted.actualByDay, { "2026-03-24": 70, "2026-03-25": -30 });

    await deleteTask(uid, "legacy", owner.db);
    await restoreTask(uid, deleted, owner.db);
    const restored = (await getDoc(doc(owner.db, path))).data();
    assert.equal(restored?.actualMinutes, 40);
    assert.deepEqual(restored?.actualByDay, { "2026-03-24": 70, "2026-03-25": -30 });
  } finally {
    await close(owner);
  }
});

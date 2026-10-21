import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc, terminate, type Firestore } from "firebase/firestore";
import { createOccurrenceCompletion, occurrenceId } from "../src/domain/model.ts";
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

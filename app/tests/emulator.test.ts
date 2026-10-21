import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signOut } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc, terminate, type Firestore } from "firebase/firestore";
import { createOccurrenceCompletion, occurrenceId } from "../src/domain/model.ts";

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

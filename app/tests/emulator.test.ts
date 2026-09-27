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

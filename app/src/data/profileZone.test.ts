import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

/*
 * The cached-profile time-zone branch of `useProfileTimeZone` (R7-11). The hook
 * runs against stubs: React's state is a single cell and effects run at once,
 * and Firestore's subscription hands each snapshot to the test, which decides
 * whether it came from the cache or the server. Writes and reads are recorded,
 * so "writes nothing" is checked directly.
 */

type Data = Record<string, unknown> | undefined;
type Snapshot = { data: () => Data; metadata: { fromCache: boolean } };

let state: unknown;
let deliver: ((snapshot: Snapshot) => void) | null = null;
let stored: Data;
const reads: string[] = [];
const writes: { path: string; data: Record<string, unknown>; options: unknown }[] = [];

mock.module("react", {
  namedExports: {
    useState: (initial: unknown) => {
      if (state === undefined) state = initial;
      return [state, (next: unknown) => {
        state = typeof next === "function" ? (next as (previous: unknown) => unknown)(state) : next;
      }];
    },
    useEffect: (effect: () => void) => void effect(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  },
});
mock.module(new URL("./client.ts", import.meta.url).href, { namedExports: { db: {}, auth: {} } });
mock.module("firebase/firestore", {
  namedExports: {
    doc: (_db: unknown, path: string) => ({ path }),
    getDoc: async (reference: { path: string }) => {
      reads.push(reference.path);
      return { data: () => stored };
    },
    setDoc: async (reference: { path: string }, data: Record<string, unknown>, options: unknown) => {
      writes.push({ path: reference.path, data, options });
    },
    onSnapshot: (_reference: unknown, next: (snapshot: Snapshot) => void) => {
      deliver = next;
      return () => {};
    },
  },
});

const { browserTimeZone, useProfileTimeZone } = await import("./profile.ts");

/** A zone that is surely not this device's, so a fallback cannot pass by accident. */
const otherZone = browserTimeZone === "Pacific/Auckland" ? "America/Argentina/Buenos_Aires" : "Pacific/Auckland";

const current = () => state as ReturnType<typeof useProfileTimeZone>;
const cached = (data: Data) => deliver!({ data: () => data, metadata: { fromCache: true } });
const server = (data: Data) => deliver!({ data: () => data, metadata: { fromCache: false } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("useProfileTimeZone cached zone", () => {
  beforeEach(() => {
    state = undefined;
    deliver = null;
    stored = undefined;
    reads.length = 0;
    writes.length = 0;
    useProfileTimeZone("u1");
  });

  it("keeps the previous zone for a cache snapshot without one and writes nothing", async () => {
    server({ timeZone: otherZone });
    cached({ workStart: 9 * 60, workEnd: 17 * 60 });
    await settle();
    assert.equal(current().timeZone, otherZone);
    assert.deepEqual(current().workWindow, { startMinutes: 9 * 60, endMinutes: 17 * 60 });
    assert.equal(current().loading, false);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
  });

  it("lets a server snapshot with a zone win over the zone the cache rendered", async () => {
    cached(undefined);
    assert.equal(current().timeZone, browserTimeZone);
    server({ timeZone: otherZone });
    await settle();
    assert.equal(current().timeZone, otherZone);
    assert.deepEqual(writes, []);
  });

  it("lets a later server zone replace an earlier one", () => {
    server({ timeZone: otherZone });
    server({ timeZone: "UTC" });
    assert.equal(current().timeZone, "UTC");
    assert.deepEqual(writes, []);
  });

  it("initializes a missing zone from a server snapshot only", async () => {
    cached(undefined);
    cached({ shutdownTime: 17 * 60 });
    await settle();
    assert.equal(current().timeZone, browserTimeZone);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);

    server({ shutdownTime: 17 * 60 });
    await settle();
    assert.deepEqual(reads, ["users/u1/profile/main"]);
    assert.deepEqual(writes, [{ path: "users/u1/profile/main", data: { timeZone: browserTimeZone }, options: { merge: true } }]);
    assert.equal(current().timeZone, browserTimeZone);
    assert.equal(current().shutdownTime, 17 * 60);
  });

  it("does not write when the read made for initialization finds a stored zone", async () => {
    stored = { timeZone: otherZone };
    server(undefined);
    await settle();
    assert.deepEqual(writes, []);
    assert.equal(current().timeZone, otherZone);
  });

  it("never writes the device zone over a stored one from a cached echo", async () => {
    // A Settings edit right after sign-in: the local echo arrives before the stored document.
    cached({ shortcutsEnabled: false });
    server({ timeZone: otherZone, shortcutsEnabled: false });
    cached({ shortcutsEnabled: false, shutdownTime: 19 * 60 });
    await settle();
    assert.equal(current().timeZone, otherZone);
    assert.equal(current().shutdownTime, 19 * 60);
    assert.equal(current().shortcutsEnabled, false);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
  });
});

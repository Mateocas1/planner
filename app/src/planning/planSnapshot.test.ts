import assert from "node:assert/strict";
import test from "node:test";
import type { WorkBlock } from "../domain/model.ts";
import {
  capturePlanSnapshot,
  planSnapshotKey,
  readPlanSnapshot,
  type SnapshotStorage,
} from "./planSnapshot.ts";

/** An in-memory Storage with the surface the module uses. */
function memoryStorage(options: { failWrites?: boolean } = {}): SnapshotStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException("quota", "QuotaExceededError");
      map.set(key, value);
    },
    removeItem: key => {
      map.delete(key);
    },
  };
}

const zone = "America/Argentina/Buenos_Aires";
const now = new Date("2026-11-06T12:00:00Z");
const block = (id: string, start: string, end: string, extra: Partial<WorkBlock> = {}): WorkBlock => ({ id, start, end, ...extra });
const morning = [
  block("b1", "2026-11-06T09:00:00-03:00", "2026-11-06T10:30:00-03:00", { taskId: "t1" }),
  block("b2", "2026-11-06T11:00:00-03:00", "2026-11-06T12:00:00-03:00", { title: "Standup" }),
];
const titles = (id: string) => (id === "t1" ? "Write report" : undefined);
const capture = (storage: SnapshotStorage | null, overrides: Partial<Parameters<typeof capturePlanSnapshot>[1]> = {}) =>
  capturePlanSnapshot(storage, { uid: "u1", day: "2026-11-06", zone, now, blocks: morning, taskTitle: titles, ...overrides });

test("a capture stores the day's blocks, resolving task titles at capture time", () => {
  const storage = memoryStorage();
  assert.equal(capture(storage), true);
  assert.deepEqual(readPlanSnapshot(storage, "u1", "2026-11-06"), {
    v: 1,
    day: "2026-11-06",
    zone,
    takenAt: "2026-11-06T12:00:00.000Z",
    blocks: [
      { id: "b1", start: "2026-11-06T09:00:00-03:00", end: "2026-11-06T10:30:00-03:00", taskId: "t1", title: "Write report" },
      { id: "b2", start: "2026-11-06T11:00:00-03:00", end: "2026-11-06T12:00:00-03:00", title: "Standup" },
    ],
  });
  assert.deepEqual([...storage.map.keys()], [planSnapshotKey("u1", "2026-11-06")]);
  assert.equal(planSnapshotKey("u1", "2026-11-06"), "planner-day-plan:u1:2026-11-06");
});

test("the first capture of a day wins: a later one is a no-op", () => {
  const storage = memoryStorage();
  assert.equal(capture(storage), true);
  const before = storage.map.get(planSnapshotKey("u1", "2026-11-06"));
  assert.equal(capture(storage, { blocks: [block("late", "2026-11-06T15:00:00-03:00", "2026-11-06T16:00:00-03:00")], now: new Date("2026-11-06T18:00:00Z") }), false);
  assert.equal(storage.map.get(planSnapshotKey("u1", "2026-11-06")), before);
});

test("only blocks that touch the profile-zone day are kept, Google blocks and long titles are handled", () => {
  const storage = memoryStorage();
  const gcal = block("g", "2026-11-06T13:00:00-03:00", "2026-11-06T14:00:00-03:00", {
    title: "Dentist",
    source: { provider: "gcal", calendarId: "c", eventId: "e", updated: "x" },
  });
  const yesterday = block("y", "2026-11-05T09:00:00-03:00", "2026-11-05T10:00:00-03:00");
  const tomorrow = block("n", "2026-11-07T00:00:00-03:00", "2026-11-07T01:00:00-03:00");
  // Ends exactly at the zone's midnight: it is yesterday's block.
  const endsAtMidnight = block("m", "2026-11-05T23:00:00-03:00", "2026-11-06T00:00:00-03:00");
  const overnight = block("o", "2026-11-06T22:00:00-03:00", "2026-11-07T02:00:00-03:00");
  const long = block("l", "2026-11-06T08:00:00-03:00", "2026-11-06T08:30:00-03:00", { title: "x".repeat(200) });
  capture(storage, { blocks: [gcal, yesterday, tomorrow, endsAtMidnight, overnight, long, ...morning] });
  const snapshot = readPlanSnapshot(storage, "u1", "2026-11-06");
  assert.deepEqual(snapshot?.blocks.map(item => item.id), ["l", "b1", "b2", "o"]);
  assert.equal(snapshot?.blocks[0].title.length, 140);
});

test("a day with no blocks writes nothing, so a later capture can still be the first", () => {
  const storage = memoryStorage();
  assert.equal(capture(storage, { blocks: [] }), false);
  assert.equal(storage.map.size, 0);
  assert.equal(capture(storage), true);
});

test("at most 60 blocks are kept, earliest first", () => {
  const storage = memoryStorage();
  const dayStart = Date.parse("2026-11-06T00:00:00-03:00");
  const many = Array.from({ length: 75 }, (_, index) => {
    const startMs = dayStart + index * 10 * 60_000;
    return block(`b${index}`, new Date(startMs).toISOString(), new Date(startMs + 5 * 60_000).toISOString());
  });
  capture(storage, { blocks: many.slice().reverse() });
  const snapshot = readPlanSnapshot(storage, "u1", "2026-11-06");
  assert.equal(snapshot?.blocks.length, 60);
  assert.equal(snapshot?.blocks[0].id, "b0");
  assert.equal(snapshot?.blocks[59].id, "b59");
});

test("only the newest 8 days of a user are kept", () => {
  const storage = memoryStorage();
  for (let day = 1; day <= 10; day += 1) {
    const key = `2026-11-${String(day).padStart(2, "0")}`;
    capture(storage, {
      day: key,
      blocks: [block(`b${day}`, `${key}T09:00:00-03:00`, `${key}T10:00:00-03:00`)],
    });
  }
  const kept = [...storage.map.keys()].sort();
  assert.deepEqual(kept, [3, 4, 5, 6, 7, 8, 9, 10].map(day => `planner-day-plan:u1:2026-11-${String(day).padStart(2, "0")}`));
  assert.equal(readPlanSnapshot(storage, "u1", "2026-11-02"), null);
  assert.notEqual(readPlanSnapshot(storage, "u1", "2026-11-10"), null);
});

test("users are isolated: capture, read and pruning never cross a uid", () => {
  const storage = memoryStorage();
  for (let day = 1; day <= 9; day += 1) {
    const key = `2026-11-${String(day).padStart(2, "0")}`;
    capture(storage, { uid: "u1", day: key, blocks: [block(`b${day}`, `${key}T09:00:00-03:00`, `${key}T10:00:00-03:00`)] });
  }
  capture(storage, { uid: "u2", day: "2026-11-06", blocks: [block("other", "2026-11-06T09:00:00-03:00", "2026-11-06T10:00:00-03:00")] });
  assert.equal(readPlanSnapshot(storage, "u2", "2026-11-06")?.blocks[0].id, "other");
  assert.equal(readPlanSnapshot(storage, "u1", "2026-11-06")?.blocks[0].id, "b6");
  assert.equal(readPlanSnapshot(storage, "u3", "2026-11-06"), null);
  // u2 still has its day after u1's pruning ran.
  assert.equal([...storage.map.keys()].filter(key => key.startsWith("planner-day-plan:u2:")).length, 1);
  // A uid that is a prefix of another does not read its neighbour's days.
  assert.equal(readPlanSnapshot(storage, "u", "2026-11-06"), null);
});

test("corrupt or foreign stored JSON reads as absent and is replaced by the next capture", () => {
  const storage = memoryStorage();
  const key = planSnapshotKey("u1", "2026-11-06");
  for (const bad of ["{not json", "null", "[]", '{"v":2,"day":"2026-11-06","zone":"UTC","takenAt":"x","blocks":[]}', '{"v":1,"day":"2026-11-07","zone":"UTC","takenAt":"x","blocks":[]}', '{"v":1,"day":"2026-11-06","zone":"UTC","takenAt":"x","blocks":[{"id":1}]}']) {
    storage.map.set(key, bad);
    assert.equal(readPlanSnapshot(storage, "u1", "2026-11-06"), null, bad);
  }
  storage.map.set(key, "{not json");
  assert.equal(capture(storage), true);
  assert.equal(readPlanSnapshot(storage, "u1", "2026-11-06")?.blocks.length, 2);
});

test("a full or refusing storage is swallowed: capture reports false and read reads null", () => {
  const full = memoryStorage({ failWrites: true });
  assert.equal(capture(full), false);
  assert.equal(readPlanSnapshot(full, "u1", "2026-11-06"), null);

  const throwing: SnapshotStorage = {
    get length(): number {
      throw new Error("denied");
    },
    key: () => {
      throw new Error("denied");
    },
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(capture(throwing), false);
  assert.equal(readPlanSnapshot(throwing, "u1", "2026-11-06"), null);
  assert.equal(capture(null), false);
  assert.equal(readPlanSnapshot(null, "u1", "2026-11-06"), null);
});

test("the day is cut at the profile zone's midnight, not UTC's", () => {
  const storage = memoryStorage();
  // 02:00Z on the 7th is 23:00 on the 6th in Buenos Aires.
  const late = block("late", "2026-11-07T02:00:00Z", "2026-11-07T02:30:00Z");
  capture(storage, { blocks: [late] });
  assert.deepEqual(readPlanSnapshot(storage, "u1", "2026-11-06")?.blocks.map(item => item.id), ["late"]);
  // A DST day (Madrid springs forward 2026-03-29, 23 h long) still ends at the next local midnight.
  const dst = memoryStorage();
  capturePlanSnapshot(dst, {
    uid: "u1",
    day: "2026-03-29",
    zone: "Europe/Madrid",
    now,
    taskTitle: titles,
    blocks: [
      block("in", "2026-03-29T23:30:00+02:00", "2026-03-30T00:30:00+02:00"),
      block("out", "2026-03-30T00:00:00+02:00", "2026-03-30T01:00:00+02:00"),
    ],
  });
  assert.deepEqual(readPlanSnapshot(dst, "u1", "2026-03-29")?.blocks.map(item => item.id), ["in"]);
});

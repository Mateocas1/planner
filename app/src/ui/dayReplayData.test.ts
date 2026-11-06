import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setDeviceLanguage } from "../i18n/index.ts";
import type { BiasSample } from "../planning/bias.ts";
import { capturePlanSnapshot, type SnapshotStorage } from "../planning/planSnapshot.ts";
import { prepareDayReplay, type ReplayInputTask } from "./dayReplayData.ts";

/**
 * The replay as the ritual assembles it (day-replay plan §1, §4, §5): the
 * morning snapshot becomes the plan, and the bias sentence reads only the tasks
 * tracked or finished on the replay day. Plain lists, an in-memory storage, the
 * UTC zone: no DOM, no database.
 */

afterEach(() => setDeviceLanguage(null));

const DAY = "2026-11-06";
const ZONE = "UTC";
const UID = "u1";

function memory(): SnapshotStorage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

const block = (id: string, from: string, to: string, taskId?: string) => ({
  id,
  start: `${DAY}T${from}:00Z`,
  end: `${DAY}T${to}:00Z`,
  ...(taskId === undefined ? {} : { taskId }),
});

const task = (id: string, title: string, extra: Partial<ReplayInputTask> = {}): ReplayInputTask => ({
  id,
  title,
  completed: false,
  ...extra,
});

describe("prepareDayReplay", () => {
  it("returns null for a day with nothing planned or tracked", () => {
    const prepared = prepareDayReplay({
      uid: UID, day: DAY, timeZone: ZONE, tasks: [task("a", "Idle")], blocks: [], samples: [], storage: memory(),
    });
    assert.equal(prepared, null);
  });

  it("without a snapshot the plan is today's blocks: a tracked overrun stretches the row", () => {
    const prepared = prepareDayReplay({
      uid: UID,
      day: DAY,
      timeZone: ZONE,
      tasks: [task("a", "Report", { actualByDay: { [DAY]: 90 } })],
      blocks: [block("b1", "09:00", "10:00", "a")],
      samples: [],
      storage: memory(),
    });
    assert.ok(prepared);
    assert.deepEqual(prepared.replay.rows.map(row => [row.key, row.outcome]), [["task:a", "stretched"]]);
    assert.notEqual(prepared.timeline, null);
    assert.equal(prepared.sentence, null);
  });

  it("the morning snapshot is the plan: a block moved since 09:00 is a moved row", () => {
    const storage = memory();
    const planned = [block("b1", "09:00", "10:00", "a")];
    capturePlanSnapshot(storage, { uid: UID, day: DAY, zone: ZONE, now: new Date(`${DAY}T08:00:00Z`), blocks: planned, taskTitle: () => "Report" });
    const prepared = prepareDayReplay({
      uid: UID,
      day: DAY,
      timeZone: ZONE,
      tasks: [task("a", "Report", { completed: true, completedAt: `${DAY}T15:00:00Z`, actualByDay: { [DAY]: 60 } })],
      blocks: [block("b1", "14:00", "15:00", "a")],
      samples: [],
      storage,
    });
    assert.ok(prepared);
    assert.deepEqual(prepared.replay.rows.map(row => row.outcome), ["moved"]);
  });

  it("a snapshot of another day is not this day's plan", () => {
    const storage = memory();
    capturePlanSnapshot(storage, {
      uid: UID, day: "2026-11-05", zone: ZONE, now: new Date("2026-11-05T08:00:00Z"),
      blocks: [{ id: "old", start: "2026-11-05T09:00:00Z", end: "2026-11-05T10:00:00Z", taskId: "a" }],
      taskTitle: () => "Report",
    });
    const prepared = prepareDayReplay({
      uid: UID,
      day: DAY,
      timeZone: ZONE,
      tasks: [task("a", "Report", { actualByDay: { [DAY]: 60 } })],
      blocks: [block("b1", "14:00", "15:00", "a")],
      samples: [],
      storage,
    });
    assert.ok(prepared);
    assert.deepEqual(prepared.replay.rows.map(row => row.outcome), ["unchanged"]);
  });

  it("the sentence is worded from the history of the tasks of the day, in the app language", () => {
    const history: BiasSample[] = Array.from({ length: 4 }, () => ({ title: "Reunión", estimate: 30, actualMinutes: 39 }));
    const tasks = [
      task("m1", "Reunión semanal", { completed: true, completedAt: `${DAY}T10:00:00Z`, actualByDay: { [DAY]: 39 } }),
      task("x", "Unrelated", { completed: true, completedAt: "2026-10-01T10:00:00Z" }),
    ];
    const input = { uid: UID, day: DAY, timeZone: ZONE, tasks, blocks: [block("b1", "09:00", "10:00", "m1")], samples: history, storage: memory() };
    const prepared = prepareDayReplay(input);
    assert.ok(prepared);
    assert.match(prepared.sentence ?? "", /30%/);
    assert.match(prepared.sentence ?? "", /“reunión”/);
    assert.match(prepared.basis ?? "", /4 finished tasks/);

    setDeviceLanguage("es");
    const spanish = prepareDayReplay(input);
    assert.match(spanish?.sentence ?? "", /^Subestimas las tareas de «reunión» un 30\s%\.$/);
  });

  it("history alone does not speak: the word must belong to a task tracked or finished that day", () => {
    const history: BiasSample[] = Array.from({ length: 4 }, () => ({ title: "Reunión", estimate: 30, actualMinutes: 39 }));
    const prepared = prepareDayReplay({
      uid: UID,
      day: DAY,
      timeZone: ZONE,
      tasks: [task("m1", "Reunión semanal", { actualByDay: { "2026-11-05": 39 } }), task("r", "Report", { actualByDay: { [DAY]: 20 } })],
      blocks: [block("b1", "09:00", "10:00", "r")],
      samples: history,
      storage: memory(),
    });
    assert.ok(prepared);
    // 4 global samples are too few for the global pace, and "report" has none.
    assert.equal(prepared.sentence, null);
  });
});

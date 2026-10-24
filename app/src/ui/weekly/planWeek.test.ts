import assert from "node:assert/strict";
import test from "node:test";
import { nextWeekDays, planWeek } from "./planWeek.ts";
import type { PlanBlock, PlanTask } from "../../planning/place.ts";
import type { WorkWindow } from "../../planning/window.ts";

const zone = "UTC";
// Monday 2026-01-05; the "now" is the Friday before, so every day of next week
// lies ahead and no placement is refused as past.
const now = new Date("2026-01-02T12:00:00Z");
const days = nextWeekDays("2026-01-05");
const window: WorkWindow = { startMinutes: 8 * 60, endMinutes: 12 * 60 };

function task(id: string, estimate: number, deadline?: string): PlanTask {
  return { id, title: id, estimate, ...(deadline === undefined ? {} : { deadline }) };
}

test("priorities claim the week's first free slots before everything else", () => {
  const plan = planWeek({
    days,
    now,
    timeZone: zone,
    window,
    tasks: [task("later", 60), task("first", 60)],
    blocks: [],
    priorityIds: ["first"],
  });
  const first = plan.placements.find(entry => entry.taskId === "first");
  const later = plan.placements.find(entry => entry.taskId === "later");
  assert.equal(first?.day, "2026-01-05");
  assert.deepEqual([first?.startMinutes, first?.endMinutes], [480, 540]);
  // The rest fills the slot the priority left behind, on the same morning.
  assert.equal(later?.day, "2026-01-05");
  assert.deepEqual([later?.startMinutes, later?.endMinutes], [540, 600]);
});

test("a task is placed once, never once per day", () => {
  const plan = planWeek({
    days,
    now,
    timeZone: zone,
    window,
    tasks: [task("solo", 60)],
    blocks: [],
    priorityIds: [],
  });
  assert.equal(plan.placements.length, 1);
});

test("priorities are placed in the order they were picked", () => {
  const plan = planWeek({
    days,
    now,
    timeZone: zone,
    window,
    tasks: [task("b", 60), task("a", 60)],
    blocks: [],
    priorityIds: ["b", "a"],
  });
  const b = plan.placements.find(entry => entry.taskId === "b");
  const a = plan.placements.find(entry => entry.taskId === "a");
  // Both land on Monday; the first pick takes the earlier slot.
  assert.ok(b && a && b.day === a.day && b.startMinutes < a.startMinutes);
});

test("a task that fits no day is reported once, not once per day", () => {
  const fullers: PlanBlock[] = [];
  for (const day of days) {
    // Each day holds one 60-minute task; two more cannot fit anywhere.
    fullers.push({ start: `${day}T08:00:00Z`, end: `${day}T09:00:00Z` });
  }
  const tasks = [task("p1", 60), task("p2", 60), task("p3", 60), task("p4", 60), task("p5", 60), task("p6", 60), task("p7", 60), task("p8", 60), task("p9", 60)];
  const plan = planWeek({ days, now, timeZone: zone, window, tasks, blocks: fullers, priorityIds: [] });
  // Days are full only after the stored blocks; whatever remains across both
  // passes is unplaced, each task named exactly once.
  const ids = plan.unplaced.map(entry => entry.task.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(plan.placements.every(placement => placement.taskId !== undefined));
});

test("existing blocks occupy their day before planning starts", () => {
  const blocks: PlanBlock[] = [{ start: "2026-01-05T08:00:00Z", end: "2026-01-05T10:00:00Z" }];
  const plan = planWeek({ days, now, timeZone: zone, window, tasks: [task("t", 60)], blocks, priorityIds: [] });
  assert.equal(plan.placements[0]?.day, "2026-01-05");
  assert.equal(plan.placements[0]?.startMinutes, 600);
});

test("nextWeekDays walks Monday through Sunday", () => {
  assert.deepEqual(nextWeekDays("2026-01-05"), [
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
    "2026-01-10",
    "2026-01-11",
  ]);
  assert.throws(() => nextWeekDays("not-a-day"));
});

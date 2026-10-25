import assert from "node:assert/strict";
import test from "node:test";
import { buildPlannerContext, type ContextBlock, type ContextTask, type PlannerSnapshot } from "./plannerContext.ts";

const DAY = (day: string, time: string) => `${day}T${time}:00Z`;
const TODAY = "2026-10-29";
const block = (id: string, day: string, start: string, end: string, extra: Partial<ContextBlock> = {}): ContextBlock => ({
  id,
  start: DAY(day, start),
  end: DAY(day, end),
  ...extra,
});
const task = (id: string, title: string, extra: Partial<ContextTask> = {}): ContextTask => ({ id, title, completed: false, ...extra });
const snapshot = (blocks: ContextBlock[], tasks: ContextTask[]): PlannerSnapshot => ({ blocks, tasks });

test("the header carries the current date, time and time zone", () => {
  const text = buildPlannerContext(snapshot([], []), new Date("2026-10-29T14:32:00Z"), "UTC");
  assert.ok(text.includes("2026-10-29"), text);
  assert.ok(text.includes("14:32"), text);
  assert.ok(text.includes("UTC"), text);
});

test("a non-UTC zone shifts the day and the labels: a 00:30Z block is still today at 21:30", () => {
  const zone = "America/Argentina/Buenos_Aires";
  // 2026-10-29T02:00Z is 2026-10-28 23:00 in Buenos Aires: today is the 28th.
  const text = buildPlannerContext(
    snapshot([block("b1", "2026-10-28", "14:00", "15:30")], []),
    new Date("2026-10-29T02:00:00Z"),
    zone,
  );
  assert.ok(text.includes("2026-10-28"), text);
  assert.ok(text.includes("11:00–12:30"), text);
  assert.ok(text.includes(zone), text);
});

test("today's blocks list time range, title and done state; task titles fill in; linked tasks carry their id", () => {
  const text = buildPlannerContext(
    snapshot(
      [
        block("b1", TODAY, "09:00", "10:30", { title: "Deep work", taskId: "t1" }),
        block("b2", TODAY, "14:00", "15:00", { taskId: "t2" }),
        block("b3", TODAY, "16:00", "17:00"),
      ],
      [task("t1", "Chat panel", { completed: true }), task("t2", "Inbox review")],
    ),
    new Date("2026-10-29T14:32:00Z"),
    "UTC",
  );
  assert.ok(text.includes("09:00–10:30 · [t1] Deep work · done"), text);
  assert.ok(text.includes("14:00–15:00 · [t2] Inbox review"), text);
  assert.ok(text.includes("16:00–17:00 · Work block"), text);
});

test("the next 7 days group by day; an empty day says so; today and day 8 stay out", () => {
  const text = buildPlannerContext(
    snapshot(
      [
        block("b1", TODAY, "23:00", "23:30"), // today: not in the week section
        block("b2", "2026-10-30", "09:00", "10:00", { title: "Write tests" }),
        block("b3", "2026-11-01", "11:00", "12:00", { title: "Deep clean" }),
        block("b4", "2026-11-06", "08:00", "09:00", { title: "Too far" }), // day 8
      ],
      [],
    ),
    new Date("2026-10-29T12:00:00Z"),
    "UTC",
  );
  assert.ok(text.includes("2026-10-30") && text.includes("Write tests"), text);
  assert.ok(text.includes("2026-11-01") && text.includes("Deep clean"), text);
  assert.ok(text.includes("2026-11-02"), `empty days are still listed: ${text}`);
  assert.ok(text.includes("no blocks"), text);
  assert.ok(!text.includes("Too far"), text);
  const weekSection = text.slice(text.indexOf("Next 7 days"));
  assert.ok(!weekSection.includes("23:00"), weekSection);
});

test("caps bound the output: today blocks, per-day blocks and open tasks each show +N more", () => {
  const manyToday = Array.from({ length: 20 }, (_, i) =>
    block(`t${i}`, TODAY, String(1 + i).padStart(2, "0") + ":00", String(1 + i).padStart(2, "0") + ":10"),
  );
  const manyWeek = Array.from({ length: 9 }, (_, i) =>
    block(`w${i}`, "2026-10-30", String(6 + i).padStart(2, "0") + ":00", String(6 + i).padStart(2, "0") + ":10"),
  );
  const manyTasks = Array.from({ length: 20 }, (_, i) => task(`k${i}`, `Task number ${i}`, { deadline: "2026-11-02" }));
  const text = buildPlannerContext(snapshot([...manyToday, ...manyWeek], manyTasks), new Date("2026-10-29T12:00:00Z"), "UTC");
  assert.ok(text.includes("+6 more"), `20 today blocks, 14 shown: ${text}`);
  assert.ok(text.includes("+3 more"), `9 blocks on 2026-10-30, 6 shown: ${text}`);
  assert.ok(text.includes("+8 more"), `20 open tasks, 12 shown: ${text}`);
  assert.ok(text.length < 7000, `context too long: ${text.length} chars`);
});

test("titles are truncated to keep the prompt bounded", () => {
  const long = "x".repeat(200);
  const text = buildPlannerContext(snapshot([block("b1", TODAY, "09:00", "10:00", { title: long })], []), new Date("2026-10-29T12:00:00Z"), "UTC");
  assert.ok(text.includes("…"), text);
  assert.ok(!text.includes("x".repeat(49)), text);
});

test("tasks in the context carry their ids so the model can reference them (S1)", () => {
  const text = buildPlannerContext(
    snapshot(
      [block("b1", TODAY, "09:00", "10:00", { taskId: "scheduled" })],
      [
        task("scheduled", "Scheduled task"),
        task("done", "Completed task", { completed: true }),
        task("open1", "Pay the invoice", { estimateMinutes: 45, deadline: "2026-11-02" }),
        task("open2", "Buy milk", { estimateMinutes: 15 }),
      ],
    ),
    new Date("2026-10-29T12:00:00Z"),
    "UTC",
  );
  assert.ok(text.includes("[open1] Pay the invoice"), text);
  assert.ok(text.includes("[open2] Buy milk"), text);
  assert.ok(text.includes("45 min"), text);
  assert.ok(text.includes("[scheduled] Scheduled task"), text);
  // A task placed on a block is not unscheduled; a completed task appears nowhere.
  const openSection = text.slice(text.indexOf("Open unscheduled tasks:"));
  assert.ok(!openSection.includes("Scheduled task"), openSection);
  assert.ok(!openSection.includes("Completed task"), openSection);
});

test("an empty planner still renders a usable header", () => {
  const text = buildPlannerContext(snapshot([], []), new Date("2026-10-29T12:00:00Z"), "UTC");
  assert.ok(text.includes("2026-10-29"));
  assert.ok(text.includes("no blocks"));
  assert.ok(text.length < 1200);
});

test("holidays in the next 14 days ride with their ids; hidden and far ones stay out (S4)", () => {
  const text = buildPlannerContext(
    {
      blocks: [],
      tasks: [],
      holidays: [
        { id: "h-near", date: "2026-11-02", title: "Independence Day", kind: "public" },
        { id: "h-hidden", date: "2026-11-03", title: "Secret", kind: "other", hidden: true },
        { id: "h-past", date: "2026-10-01", title: "Long gone", kind: "other" },
        { id: "h-far", date: "2026-12-25", title: "Christmas", kind: "public" },
      ],
    },
    new Date("2026-10-29T12:00:00Z"),
    "UTC",
  );
  assert.match(text, /Holidays in the next 14 days:/);
  assert.match(text, /\[h-near\] [^\n]*Independence Day · public/);
  assert.ok(!text.includes("Secret"), "hidden labels are not shown");
  assert.ok(!text.includes("Long gone"), "past labels are not shown");
  assert.ok(!text.includes("Christmas"), "labels beyond 14 days are not shown");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TOOLS,
  MAX_TOOL_CALLS_PER_ANSWER,
  checkCreateTask,
  checkMoveTask,
  describeToolCall,
  isValidDayKey,
  toolResultContent,
  validateToolCall,
  type ChatToolContext,
} from "./tools.ts";

const context: ChatToolContext = {
  tasks: [
    { id: "t1", title: "Pay the invoice", deadline: "2026-10-28" },
    { id: "t2", title: "Deep clean", estimateMinutes: 90 },
  ],
  timeZone: "UTC",
  todayKey: "2026-10-29",
};

test("the two tools carry OpenAI function schemas with required fields", () => {
  assert.deepEqual(
    CHAT_TOOLS.map(tool => tool.function.name),
    ["create_task", "move_task"],
  );
  for (const tool of CHAT_TOOLS) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
  }
  // move_task must name its id and day requirements so the model sends them.
  assert.ok((MOVE_REQUIRED("move_task") as string[]).includes("taskId"));
  assert.ok((MOVE_REQUIRED("move_task") as string[]).includes("day"));
  assert.ok(!(MOVE_REQUIRED("create_task") as string[]).includes("day"), "day stays optional for create");
});

function MOVE_REQUIRED(name: string): unknown {
  const tool = CHAT_TOOLS.find(entry => entry.function.name === name);
  return (tool?.function.parameters as { required?: unknown }).required ?? [];
}

test("at most five tool calls per answer is the exported cap", () => {
  assert.equal(MAX_TOOL_CALLS_PER_ANSWER, 5);
});

test("isValidDayKey accepts real dates and rejects malformed ones", () => {
  assert.equal(isValidDayKey("2026-11-02"), true);
  assert.equal(isValidDayKey("2026-02-29"), false, "not a leap year");
  assert.equal(isValidDayKey("2024-02-29"), true);
  assert.equal(isValidDayKey("2026-13-01"), false);
  assert.equal(isValidDayKey("2026-11"), false);
  assert.equal(isValidDayKey("tomorrow"), false);
  assert.equal(isValidDayKey(""), false);
});

test("create_task: a valid proposal normalizes and describes in plain words", () => {
  const check = checkCreateTask('{"title":"Buy milk","day":"2026-10-30","estimateMinutes":30}', context.todayKey);
  assert.ok(check.ok);
  assert.deepEqual(check.value, { title: "Buy milk", day: "2026-10-30", estimateMinutes: 30 });
  assert.match(check.description, /Create task "Buy milk"/);
});

test("create_task: empty, missing and non-string titles fail", () => {
  for (const raw of ["{}", '{"title":""}', '{"title":"   "}', '{"title":42}']) {
    const check = checkCreateTask(raw);
    assert.ok(!check.ok, raw);
    assert.match(check.ok ? "" : check.error, /title/i);
  }
});

test("create_task: a title over the cap is rejected", () => {
  const check = checkCreateTask(JSON.stringify({ title: "x".repeat(201) }));
  assert.ok(!check.ok);
  assert.match(check.ok ? "" : check.error, /too long/);
  assert.ok(checkCreateTask(JSON.stringify({ title: "x".repeat(200) })).ok, "exactly 200 is fine");
});

test("create_task: a bad date fails and never describes a write", () => {
  for (const day of ["2026-13-40", "not-a-date", "2026-11", "42"]) {
    const check = checkCreateTask(JSON.stringify({ title: "X", day }));
    assert.ok(!check.ok, day);
    assert.match(check.ok ? "" : check.error, /not a valid day/);
  }
  // null and omitted day are fine (no date).
  assert.ok(checkCreateTask('{"title":"X","day":null}').ok);
  assert.ok(checkCreateTask('{"title":"X"}').ok);
});

test("create_task: a bad estimate fails; null is absent", () => {
  assert.ok(!checkCreateTask('{"title":"X","estimateMinutes":0}').ok);
  assert.ok(!checkCreateTask('{"title":"X","estimateMinutes":1441}').ok);
  assert.ok(!checkCreateTask('{"title":"X","estimateMinutes":1.5}').ok);
  assert.ok(checkCreateTask('{"title":"X","estimateMinutes":null}').ok);
});

test("create_task: arguments that are not a JSON object fail cleanly", () => {
  assert.ok(!checkCreateTask("not json").ok);
  assert.ok(!checkCreateTask('["title"]').ok);
  assert.ok(!checkCreateTask("42").ok);
});

test("move_task: a valid move to a day normalizes with the task's title", () => {
  const check = checkMoveTask('{"taskId":"t1","day":"2026-10-30"}', context);
  assert.ok(check.ok);
  assert.deepEqual(check.value, { taskId: "t1", title: "Pay the invoice", day: "2026-10-30" });
});

test("move_task: null day means unschedule", () => {
  const check = checkMoveTask('{"taskId":"t1","day":null}', context);
  assert.ok(check.ok);
  assert.equal(check.ok && check.value.day, null);
});

test("move_task: an unknown task id fails and never writes", () => {
  const check = checkMoveTask('{"taskId":"ghost","day":"2026-10-30"}', context);
  assert.ok(!check.ok);
  assert.match(check.ok ? "" : check.error, /not in your planner/);
});

test("move_task: a bad date fails", () => {
  const check = checkMoveTask('{"taskId":"t1","day":"30/10/2026"}', context);
  assert.ok(!check.ok);
});

test("move_task: a valid start time becomes minutes since midnight and needs a day", () => {
  const ok = checkMoveTask('{"taskId":"t2","day":"2026-10-30","startTime":"14:30"}', context);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.value.startMinutes, 14 * 60 + 30);
  const noDay = checkMoveTask('{"taskId":"t2","day":null,"startTime":"14:30"}', context);
  assert.ok(!noDay.ok);
  assert.match(noDay.ok ? "" : noDay.error, /needs a target day/);
  const bad = checkMoveTask('{"taskId":"t2","day":"2026-10-30","startTime":"25:00"}', context);
  assert.ok(!bad.ok);
});

test("move_task: a start time must leave room before midnight for the estimate", () => {
  // t2 estimates 90 min: 23:30 + 90 would run past midnight.
  const overflow = checkMoveTask('{"taskId":"t2","day":"2026-10-30","startTime":"23:30"}', context);
  assert.ok(!overflow.ok);
  assert.match(overflow.ok ? "" : overflow.error, /no room before midnight/);
  // Ending exactly at midnight is fine (22:30 + 90 = 1440).
  const edge = checkMoveTask('{"taskId":"t2","day":"2026-10-30","startTime":"22:30"}', context);
  assert.ok(edge.ok);
  // A task without an estimate assumes the app's 60 minutes (t1).
  const assumed = checkMoveTask('{"taskId":"t1","day":"2026-10-30","startTime":"23:30"}', context);
  assert.ok(!assumed.ok);
  assert.match(assumed.ok ? "" : assumed.error, /no room before midnight/);
});

test("validateToolCall describes both tools and rejects unknown names", () => {
  const create = validateToolCall({ name: "create_task", arguments: '{"title":"X","day":"2026-10-29"}' }, context);
  assert.ok(create.ok);
  assert.match(create.description, /Create task "X" · today/i);
  const move = validateToolCall({ name: "move_task", arguments: '{"taskId":"t1","day":"2026-10-30"}' }, context);
  assert.ok(move.ok);
  assert.match(move.description, /Move "Pay the invoice"/);
  const unknown = validateToolCall({ name: "delete_everything", arguments: "{}" }, context);
  assert.ok(!unknown.ok);
});

test("describeToolCall falls back to a neutral line for invalid arguments", () => {
  assert.match(describeToolCall({ name: "create_task", arguments: "not json" }, context), /not valid/);
  assert.match(describeToolCall({ name: "create_task", arguments: '{"title":"OK"}' }, context), /Create task "OK"/);
});

test("toolResultContent maps every card state to a tool message", () => {
  assert.match(toolResultContent({ status: "confirmed", outcome: "Task created." }), /applied/i);
  assert.match(toolResultContent({ status: "failed", outcome: "offline" }), /failed: offline/);
  assert.match(toolResultContent({ status: "discarded" }), /discarded/i);
  assert.match(toolResultContent({ status: "pending" }), /not answered/);
});

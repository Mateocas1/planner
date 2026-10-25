import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TOOLS,
  MAX_TOOL_CALLS_PER_ANSWER,
  buildGetTaskResult,
  buildListHolidaysResult,
  buildListMemoriesResult,
  buildListTasksResult,
  checkCreateTask,
  checkGetTask,
  checkListTasks,
  checkMoveTask,
  describeToolCall,
  isReadTool,
  isValidDayKey,
  toolResultContent,
  validateToolCall,
  type ChatToolContext,
} from "./tools.ts";
import type { Memory } from "./memoryStore.ts";

const context: ChatToolContext = {
  tasks: [
    { id: "t1", title: "Pay the invoice", deadline: "2026-10-28" },
    { id: "t2", title: "Deep clean", estimateMinutes: 90 },
  ],
  timeZone: "UTC",
  todayKey: "2026-10-29",
};

const readContext: ChatToolContext = {
  tasks: [
    { id: "t1", title: "Pay the invoice", deadline: "2026-10-28", estimateMinutes: 45 },
    { id: "t2", title: "Deep clean", estimateMinutes: 90, completed: true },
    { id: "t3", title: "Milk the moment" },
  ],
  blocks: [
    { id: "b1", start: "2026-10-30T14:00:00Z", end: "2026-10-30T14:45:00Z", taskId: "t1" },
  ],
  holidays: [
    { id: "h1", date: "2026-11-02", title: "Independence Day", kind: "public" },
    { id: "h2", date: "2026-11-01", title: "Halloween", kind: "observance", hidden: true },
  ],
  timeZone: "UTC",
  todayKey: "2026-10-29",
};

test("the tools carry OpenAI function schemas; reads are marked and ride every request", () => {
  assert.deepEqual(
    CHAT_TOOLS.map(tool => tool.function.name),
    ["create_task", "move_task", "update_task", "complete_task", "delete_task", "hide_holiday", "list_tasks", "get_task", "list_holidays", "list_memories"],
  );
  for (const tool of CHAT_TOOLS) {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.description, "string");
    assert.equal(tool.function.parameters.type, "object");
  }
  // Reads never confirm; writes do.
  assert.deepEqual(CHAT_TOOLS.filter(tool => isReadTool(tool.function.name)).map(tool => tool.function.name), [
    "list_tasks",
    "get_task",
    "list_holidays",
    "list_memories",
  ]);
  assert.equal(isReadTool("create_task"), false);
  assert.equal(isReadTool("delete_everything"), false);
  // move_task must name its id and day requirements so the model sends them.
  assert.ok((MOVE_REQUIRED("move_task") as string[]).includes("taskId"));
  assert.ok((MOVE_REQUIRED("move_task") as string[]).includes("day"));
  assert.ok(!(MOVE_REQUIRED("create_task") as string[]).includes("day"), "day stays optional for create");
  assert.ok(!(MOVE_REQUIRED("list_tasks") as string[]).includes("fromDay"), "read filters stay optional");
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

test("create_task: a start time schedules the task at a wall-clock time (S4)", () => {
  const ok = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"14:00"}', context.todayKey);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.value.startMinutes, 14 * 60);
  // The description names the time so the card shows what will change.
  assert.match(ok.ok ? ok.description : "", /14:00/);
});

test("create_task: a start time needs a day and a valid HH:MM", () => {
  const noDay = checkCreateTask('{"title":"X","startTime":"14:00"}');
  assert.ok(!noDay.ok);
  assert.match(noDay.ok ? "" : noDay.error, /needs a day/);
  const bad = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"24:30"}');
  assert.ok(!bad.ok);
  const malformed = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"2pm"}');
  assert.ok(!malformed.ok);
});

test("create_task: a start time must leave room before midnight for the duration", () => {
  // Without an estimate the app assumes 60 minutes: 23:30 leaves no room.
  const assumed = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"23:30"}');
  assert.ok(!assumed.ok);
  assert.match(assumed.ok ? "" : assumed.error, /no room before midnight/);
  const overflow = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"23:30","estimateMinutes":90}');
  assert.ok(!overflow.ok);
  const edge = checkCreateTask('{"title":"X","day":"2026-10-30","startTime":"23:00","estimateMinutes":60}');
  assert.ok(edge.ok, "ending exactly at midnight is fine");
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

test("toolResultContent: a write outcome's result (ids and fields) rides to the model (S4)", () => {
  const content = toolResultContent({
    status: "confirmed",
    outcome: "Task created.",
    result: 'Created task id=t9 "Buy milk" due 2026-10-30 at 14:00, 30 min.',
  });
  assert.match(content, /applied/i);
  assert.match(content, /id=t9/);
  // Without a result the outcome is the fallback, exactly as before.
  assert.match(toolResultContent({ status: "confirmed", outcome: "Task created." }), /Task created\./);
});

/* ---------- read tools (S4): pure validation and results ---------- */

test("list_tasks validates its filters purely", () => {
  const ok = checkListTasks('{"fromDay":"2026-10-29","toDay":"2026-11-04","query":"milk"}', readContext);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { fromDay: "2026-10-29", toDay: "2026-11-04", query: "milk", includeCompleted: false });
  assert.match(ok.description, /Look up tasks/);
  const emptyArgs = checkListTasks("{}", readContext);
  assert.ok(emptyArgs.ok, "no filters is fine");
  const reversed = checkListTasks('{"fromDay":"2026-11-04","toDay":"2026-10-29"}', readContext);
  assert.ok(!reversed.ok);
  assert.match(reversed.ok ? "" : reversed.error, /fromDay/);
  const badDay = checkListTasks('{"fromDay":"soon"}', readContext);
  assert.ok(!badDay.ok);
  const badCompleted = checkListTasks('{"includeCompleted":"yes"}', readContext);
  assert.ok(!badCompleted.ok);
  const longQuery = checkListTasks(JSON.stringify({ query: "x".repeat(121) }), readContext);
  assert.ok(!longQuery.ok);
  assert.ok(checkListTasks(JSON.stringify({ query: "x".repeat(120) }), readContext).ok, "120 chars is fine");
  assert.ok(!checkListTasks("42", readContext).ok);
});

test("get_task validates the id against the live context", () => {
  const ok = checkGetTask('{"taskId":"t1"}', readContext);
  assert.ok(ok.ok);
  assert.match(ok.description, /Pay the invoice/);
  const ghost = checkGetTask('{"taskId":"ghost"}', readContext);
  assert.ok(!ghost.ok);
  assert.match(ghost.ok ? "" : ghost.error, /not in your planner/);
  assert.ok(!checkGetTask("{}", readContext).ok);
});

test("buildListTasksResult filters, reports ids and respects the caps", () => {
  const all = buildListTasksResult({ includeCompleted: false }, readContext);
  assert.equal(all.summary, "2 tasks found.");
  assert.match(all.result, /\[t1\] "Pay the invoice" · due Wed, Oct 28 · tomorrow 14:00–14:45 · 45 min/);
  assert.match(all.result, /\[t3\] "Milk the moment" · no due date/);
  assert.doesNotMatch(all.result, /Deep clean/, "completed tasks stay out unless asked");

  const withCompleted = buildListTasksResult({ includeCompleted: true }, readContext);
  assert.match(withCompleted.result, /Deep clean.*done/);

  const byQuery = buildListTasksResult({ includeCompleted: false, query: "MILK" }, readContext);
  assert.equal(byQuery.summary, "1 task found.");
  assert.match(byQuery.result, /\[t3\]/);

  // A block inside the range matches a task with no deadline in it.
  const byBlock = buildListTasksResult({ fromDay: "2026-10-30", toDay: "2026-10-30", includeCompleted: false }, readContext);
  assert.match(byBlock.result, /\[t1\]/);
  assert.doesNotMatch(byBlock.result, /\[t3\]/);

  const none = buildListTasksResult({ query: "nothing-matches", includeCompleted: false }, readContext);
  assert.equal(none.summary, "No matching tasks found.");

  // Cap: 40 tasks, cap 30.
  const many: ChatToolContext["tasks"] = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    title: `Task ${index}`,
  }));
  const capped = buildListTasksResult({ includeCompleted: false }, { ...readContext, tasks: many });
  assert.match(capped.result, /\(\+10 more\)/);
  assert.equal(capped.result.split("\n").length, 31);
});

test("buildGetTaskResult reports one task with its blocks; list_holidays flags hidden ones", () => {
  const one = buildGetTaskResult("t1", readContext);
  assert.equal(one.summary, '"Pay the invoice"');
  assert.match(one.result, /\[t1\].*14:00–14:45/);
  const unplaced = buildGetTaskResult("t3", readContext);
  assert.match(unplaced.result, /not placed on the schedule/);

  const holidays = buildListHolidaysResult(readContext);
  assert.equal(holidays.summary, "2 holidays found.");
  assert.match(holidays.result, /\[h2\].*hidden/, "hidden holidays are flagged, never dropped");
  assert.match(holidays.result, /\[h1\].*Independence Day/);
  assert.equal(buildListHolidaysResult({ ...readContext, holidays: [] }).summary, "No holidays found.");
});

test("buildListMemoriesResult lists notes newest first with their topicKeys", () => {
  const notes: Memory[] = [
    { id: "m1", topicKey: "planning-style", title: "Prefers short answers", content: "Short, concrete.", updatedAt: 10 },
    { id: "m2", topicKey: "timezone", title: "Lives in UTC", content: "Profile zone is UTC.", updatedAt: 20 },
  ];
  const found = buildListMemoriesResult(notes);
  assert.equal(found.summary, "2 notes found.");
  const order = found.result.indexOf("[timezone]");
  assert.ok(order >= 0 && order < found.result.indexOf("[planning-style]"), "newest first");
  assert.equal(buildListMemoriesResult([]).summary, "No notes found.");
});

test("toolResultContent: a read's result is the data, no confirmation wording", () => {
  const content = toolResultContent({ status: "read", outcome: "2 tasks found.", result: "- [t1] one" });
  assert.match(content, /Result: /);
  assert.match(content, /\[t1\]/);
  assert.doesNotMatch(content, /confirm/i);
  assert.match(toolResultContent({ status: "read" }), /no data/);
});

test("validateToolCall routes the reads", () => {
  assert.ok(validateToolCall({ name: "list_tasks", arguments: "{}" }, readContext).ok);
  assert.ok(validateToolCall({ name: "get_task", arguments: '{"taskId":"t1"}' }, readContext).ok);
  assert.ok(validateToolCall({ name: "list_holidays", arguments: "{}" }, readContext).ok);
  assert.ok(validateToolCall({ name: "list_memories", arguments: "{}" }, readContext).ok);
  assert.ok(!validateToolCall({ name: "get_task", arguments: '{"taskId":"ghost"}' }, readContext).ok);
  const listed = validateToolCall({ name: "list_tasks", arguments: '{"query":"milk"}' }, readContext);
  assert.ok(listed.ok);
  const described = describeToolCall({ name: "list_tasks", arguments: '{"query":"milk"}' }, readContext);
  assert.match(described, /matching "milk"/);
});

/* ---------- write tools beyond create/move (S4) ---------- */

import { checkCompleteTask, checkDeleteTask, checkHideHoliday, checkUpdateTask } from "./tools.ts";

const updateContext: ChatToolContext = {
  ...readContext,
  tasks: [
    { id: "t1", title: "Pay the invoice", deadline: "2026-10-30", estimateMinutes: 45 },
    { id: "t2", title: "Deep clean", estimateMinutes: 90, completed: true },
    { id: "t3", title: "Milk the moment" },
  ],
  blocks: [
    { id: "b1", start: "2026-10-30T14:00:00Z", end: "2026-10-30T14:45:00Z", taskId: "t1" },
    { id: "b2", start: "2026-10-27T09:00:00Z", end: "2026-10-27T10:00:00Z", taskId: "t1" },
  ],
};

test("update_task: any field change survives; a proposal that changes nothing fails", () => {
  const ok = checkUpdateTask('{"taskId":"t1","title":"Pay the rent","day":"2026-11-02","estimateMinutes":30}', updateContext);
  assert.ok(ok.ok);
  assert.deepEqual(
    ok.ok ? { newTitle: ok.value.newTitle, day: ok.value.day, estimateMinutes: ok.value.estimateMinutes } : {},
    { newTitle: "Pay the rent", day: "2026-11-02", estimateMinutes: 30 },
  );
  const nothing = checkUpdateTask('{"taskId":"t1"}', updateContext);
  assert.ok(!nothing.ok);
  assert.match(nothing.ok ? "" : nothing.error, /changes nothing/);
  const same = checkUpdateTask('{"taskId":"t1","title":"Pay the invoice","day":"2026-10-30","estimateMinutes":45}', updateContext);
  assert.ok(!same.ok, "same values are treated as no change");
  const ghost = checkUpdateTask('{"taskId":"ghost","title":"X"}', updateContext);
  assert.ok(!ghost.ok);
});

test("update_task: null day unschedules and null estimate clears", () => {
  const clear = checkUpdateTask('{"taskId":"t1","day":null,"estimateMinutes":null}', updateContext);
  assert.ok(clear.ok);
  assert.equal(clear.ok && clear.value.clearDay, true);
  assert.equal(clear.ok && clear.value.clearEstimate, true);
  // A task with nothing to clear fails as a no-op.
  const pointless = checkUpdateTask('{"taskId":"t3","day":null,"estimateMinutes":null}', updateContext);
  assert.ok(!pointless.ok);
});

test("update_task: a start time resolves its day from the proposal or the current due day", () => {
  const withDay = checkUpdateTask('{"taskId":"t1","startTime":"16:00"}', updateContext);
  assert.ok(withDay.ok, "falls back to the task's current due day");
  assert.equal(withDay.ok && withDay.value.startDay, "2026-10-30");
  const explicit = checkUpdateTask('{"taskId":"t3","day":"2026-11-02","startTime":"09:30"}', updateContext);
  assert.ok(explicit.ok);
  assert.equal(explicit.ok && explicit.value.startDay, "2026-11-02");
  const noDay = checkUpdateTask('{"taskId":"t3","startTime":"09:30"}', updateContext);
  assert.ok(!noDay.ok);
  assert.match(noDay.ok ? "" : noDay.error, /needs a day/);
  const withClear = checkUpdateTask('{"taskId":"t1","day":null,"startTime":"09:30"}', updateContext);
  assert.ok(!withClear.ok);
  const overflow = checkUpdateTask('{"taskId":"t3","day":"2026-11-02","startTime":"23:30"}', updateContext);
  assert.ok(!overflow.ok);
});

test("update_task: the card describes exactly what changes, removals included (S4)", () => {
  // Placing t1 at 16:00 on its due day replaces that day's existing block.
  const place = checkUpdateTask('{"taskId":"t1","startTime":"16:00"}', updateContext);
  assert.ok(place.ok);
  assert.match(place.ok ? place.description : "", /place tomorrow 16:00–17:00 \(replaces tomorrow 14:00–14:45\)/);
  // Unscheduling names the upcoming blocks it removes — and not the past one.
  const unschedule = checkUpdateTask('{"taskId":"t1","day":null}', updateContext);
  assert.ok(unschedule.ok);
  assert.match(unschedule.ok ? unschedule.description : "", /removes its upcoming blocks: tomorrow 14:00–14:45/);
  assert.doesNotMatch(unschedule.ok ? unschedule.description : "", /09:00/, "past blocks stay");
});

test("complete_task validates the flag and the id; the card says complete or reopen", () => {
  const done = checkCompleteTask('{"taskId":"t1","completed":true}', updateContext);
  assert.ok(done.ok);
  assert.match(done.ok ? done.description : "", /Complete "Pay the invoice"/);
  const reopen = checkCompleteTask('{"taskId":"t2","completed":false}', updateContext);
  assert.ok(reopen.ok);
  assert.match(reopen.ok ? reopen.description : "", /Reopen "Deep clean"/);
  const bad = checkCompleteTask('{"taskId":"t1","completed":"yes"}', updateContext);
  assert.ok(!bad.ok);
  const ghost = checkCompleteTask('{"taskId":"ghost","completed":true}', updateContext);
  assert.ok(!ghost.ok);
});

test("delete_task validates the id and the card names exactly what is removed (S4)", () => {
  const ok = checkDeleteTask('{"taskId":"t1"}', updateContext);
  assert.ok(ok.ok);
  assert.match(ok.ok ? ok.description : "", /Delete task "Pay the invoice" · due tomorrow · 45 min · 2 blocks stay on the calendar/);
  const bare = checkDeleteTask('{"taskId":"t3"}', updateContext);
  assert.ok(bare.ok);
  assert.equal(bare.ok && bare.description, 'Delete task "Milk the moment"');
  const ghost = checkDeleteTask('{"taskId":"ghost"}', updateContext);
  assert.ok(!ghost.ok);
});

test("hide_holiday validates against the known holidays and rejects no-ops", () => {
  const hide = checkHideHoliday('{"holidayId":"h1"}', updateContext);
  assert.ok(hide.ok);
  assert.match(hide.ok ? hide.description : "", /Hide holiday "Independence Day"/);
  const show = checkHideHoliday('{"holidayId":"h2","show":true}', updateContext);
  assert.ok(show.ok);
  assert.match(show.ok ? show.description : "", /Show holiday "Halloween"/);
  const alreadyHidden = checkHideHoliday('{"holidayId":"h2"}', updateContext);
  assert.ok(!alreadyHidden.ok);
  const alreadyVisible = checkHideHoliday('{"holidayId":"h1","show":true}', updateContext);
  assert.ok(!alreadyVisible.ok);
  const ghost = checkHideHoliday('{"holidayId":"ghost"}', updateContext);
  assert.ok(!ghost.ok);
  assert.match(ghost.ok ? "" : ghost.error, /not in your planner/);
});

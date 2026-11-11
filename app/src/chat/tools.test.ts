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
  createConfirmGuard,
  moveTaskRemovals,
  describeToolCall,
  isReadTool,
  isValidDayKey,
  toolResultContent,
  validateToolCall,
  type ChatToolContext,
} from "./tools.ts";
import type { Memory } from "./memoryStore.ts";

test("move_task: a start time replaces same-day blocks, and the card says so", () => {
  // t1 has block b1 on 2026-10-30 14:00–14:45; moving it to 16:00 that day
  // replaces it — the description must state it, exactly like update_task's.
  const check = checkMoveTask('{"taskId":"t1","day":"2026-10-30","startTime":"16:00"}', readContext);
  assert.ok(check.ok);
  assert.match(check.ok ? check.description : "", /replaces 1 block: .*14:00–14:45/);
  // The executor computes the same removals from the same pure rule, so the
  // write matches the card word for word.
  const removals = moveTaskRemovals(check.ok ? check.value : { taskId: "t1", title: "", day: null }, readContext);
  assert.deepEqual(removals.map(entry => entry.id), ["b1"]);
});

test("move_task: null day clears only the due date and removes NO blocks", () => {
  // Parent decision: move_task keeps setTaskDeadline's contract. t1's block
  // on 2026-10-30 is upcoming; unscheduling must leave it alone (removing
  // placements is update_task's job, whose card lists them).
  const check = checkMoveTask('{"taskId":"t1","day":null}', readContext);
  assert.ok(check.ok);
  assert.doesNotMatch(check.ok ? check.description : "", /removes|replaces/);
  assert.deepEqual(moveTaskRemovals(check.ok ? check.value : { taskId: "t1", title: "", day: null }, readContext), []);
});

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
    ["create_task", "move_task", "update_task", "complete_task", "delete_task", "hide_holiday", "remember", "forget", "list_tasks", "get_task", "list_holidays", "list_memories"],
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

test("a resolved remember card keeps the description it was confirmed with", () => {
  const memoryTopics = [{ topicKey: "prefers-morning-planning", title: "Prefers morning planning" }];
  const args = '{"title":"Prefers morning planning","content":"Plans before 09:00."}';
  // Pending: the live context names the note the confirm will replace.
  const pending = describeToolCall({ name: "remember", arguments: args }, { ...readContext, memoryTopics });
  assert.match(pending, /Replace note "Prefers morning planning"/);
  // Resolved: the note now exists because this very confirm created it — the
  // card must not flip to "Replace note" against its own "Remembered" outcome.
  const resolved = describeToolCall({ name: "remember", arguments: args, status: "confirmed" }, { ...readContext, memoryTopics });
  assert.match(resolved, /^Remember "/);
});

test("createConfirmGuard claims a callId exactly once, so a card can never write twice", () => {
  const guard = createConfirmGuard();
  assert.equal(guard.claim("c1"), true);
  assert.equal(guard.claim("c1"), false, "a repeated confirm with the same id never reaches a write");
  assert.equal(guard.claim("c2"), true, "a different card still confirms");
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

/* ---------- read tools: pure validation and results ---------- */

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

test("read lines are bounded: at most 10 blocks per task and 120-char titles", () => {
  // 14 placements for one task: the read shows 10 and counts the rest.
  const blocks = Array.from({ length: 14 }, (_, index) => ({
    id: `b${index}`,
    start: `2026-11-${String(10 + index).padStart(2, "0")}T14:00:00Z`,
    end: `2026-11-${String(10 + index).padStart(2, "0")}T15:00:00Z`,
    taskId: "t1",
  }));
  const placed = buildListTasksResult({ includeCompleted: false }, { ...readContext, blocks });
  assert.match(placed.result, /\(\+4 more\)/);
  assert.equal((placed.result.match(/14:00–15:00/g) ?? []).length, 10, "only 10 block stamps on the line");
  // get_task (all past placements included) is capped the same way.
  const one = buildGetTaskResult("t1", { ...readContext, blocks });
  assert.match(one.result, /\(\+4 more\)/);
  assert.equal((one.result.match(/14:00–15:00/g) ?? []).length, 10);
  // A title longer than 120 characters is truncated in the read output.
  const longTitle = "x".repeat(130);
  const long = buildListTasksResult(
    { includeCompleted: false },
    { ...readContext, tasks: [{ id: "t9", title: longTitle }] },
  );
  assert.ok(!long.result.includes(longTitle), "the full 130-char title never rides the read");
  assert.match(long.result, /"x{119}…"/);
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

/* ---------- write tools beyond create/move ---------- */

import { checkCompleteTask, checkDeleteTask, checkForget, checkHideHoliday, checkRemember, checkUpdateTask, deleteTaskKeptNote, deriveTopicKey } from "./tools.ts";

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

test("delete_task validates the id and the card names every work block it removes (S4, S8)", () => {
  const ok = checkDeleteTask('{"taskId":"t1"}', updateContext);
  assert.ok(ok.ok);
  assert.match(
    ok.ok ? ok.description : "",
    /Delete task "Pay the invoice" · due tomorrow · 45 min · and its 2 work blocks: .*09:00–10:00, .*14:00–14:45/,
  );
  // The normalized value carries the exact blocks the card named, so the
  // executor deletes exactly those and nothing else.
  // Chronological (start order), the order the calendar shows them in.
  assert.deepEqual(ok.ok ? ok.value.blocks.map(block => block.id) : [], ["b2", "b1"]);
  const bare = checkDeleteTask('{"taskId":"t3"}', updateContext);
  assert.ok(bare.ok);
  assert.equal(bare.ok && bare.description, 'Delete task "Milk the moment"');
  assert.ok(bare.ok && bare.value.blocks.length === 0);
  const ghost = checkDeleteTask('{"taskId":"ghost"}', updateContext);
  assert.ok(!ghost.ok);
});

test("delete_task's kept note reports only blocks the card did not name, with count and plurals (S8)", () => {
  const card = [{ id: "b1" }, { id: "b2" }];
  // Everything left was named by the card: nothing to report.
  assert.equal(deleteTaskKeptNote(card, [{ id: "b2" }, { id: "b1" }]), "");
  assert.equal(deleteTaskKeptNote(card, []), "");
  // One unconfirmed survivor: the exact sentence the outcome appends.
  assert.equal(
    deleteTaskKeptNote(card, [{ id: "b9" }]),
    ". 1 more block linked to this task was created after the card and was kept",
  );
  // Two or more: plural verb and count.
  assert.equal(
    deleteTaskKeptNote(card, [{ id: "b9" }, { id: "b8" }]),
    ". 2 more blocks linked to this task were created after the card and were kept",
  );
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

/* ---------- memory tools ---------- */

test("remember validates bounded title/content and an optional topic key", () => {
  const ok = checkRemember('{"title":"Planning style","content":"Plans before 09:00."}');
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { title: "Planning style", content: "Plans before 09:00." });
  assert.match(ok.ok ? ok.description : "", /Remember "Planning style"/);
  const keyed = checkRemember('{"title":"T","content":"C","topicKey":"planning-style"}');
  assert.ok(keyed.ok && keyed.value.topicKey === "planning-style");
  assert.ok(!checkRemember('{"content":"C"}').ok);
  assert.ok(!checkRemember('{"title":"T"}').ok);
  assert.ok(!checkRemember(JSON.stringify({ title: "T", content: "C".repeat(801) })).ok);
  assert.ok(checkRemember(JSON.stringify({ title: "T", content: "C".repeat(800) })).ok, "800 chars is the cap");
  assert.ok(!checkRemember('{"title":"T","content":"C","topicKey":""}').ok);
  assert.ok(!checkRemember(JSON.stringify({ title: "T", content: "C", topicKey: "k".repeat(121) })).ok);
});

test("remember over an existing key describes the replacement, not a silent overwrite", () => {
  const memoryTopics = [{ topicKey: "planning-style", title: "Prefers short answers" }];
  // A derived key colliding with an existing note names the note it will
  // replace (review finding 3) — the card cannot say just "Remember X".
  const derived = checkRemember('{"title":"Planning style","content":"Plans before 09:00."}', { ...readContext, memoryTopics });
  assert.ok(derived.ok);
  assert.match(derived.ok ? derived.description : "", /Replace note "Prefers short answers"/);
  const explicit = checkRemember('{"title":"T","content":"C","topicKey":"planning-style"}', { ...readContext, memoryTopics });
  assert.ok(explicit.ok);
  assert.match(explicit.ok ? explicit.description : "", /Replace note "Prefers short answers"/);
  // An unknown key stays a plain Remember.
  const fresh = checkRemember('{"title":"Planning style","content":"Plans before 09:00."}', readContext);
  assert.ok(fresh.ok);
  assert.match(fresh.ok ? fresh.description : "", /^Remember "/);
});

test("deriveTopicKey slugs the title the way the store keys notes", () => {
  assert.equal(deriveTopicKey("Planning style"), "planning-style");
  assert.equal(deriveTopicKey("  ¡Mañana, temprano!  "), "manana-temprano");
  assert.equal(deriveTopicKey("###"), "note", "degenerate titles get a stable fallback");
  assert.ok(deriveTopicKey("x".repeat(300)).length <= 120);
});

test("forget validates the topic key; the card names the note when the context knows it", () => {
  const known = checkForget('{"topicKey":"planning-style"}', {
    ...readContext,
    memoryTopics: [{ topicKey: "planning-style", title: "Prefers short answers" }],
  });
  assert.ok(known.ok);
  assert.match(known.ok ? known.description : "", /Forget the note "Prefers short answers"/);
  const unknownTitle = checkForget('{"topicKey":"ghost-key"}', readContext);
  assert.ok(unknownTitle.ok, "existence is checked live at confirm, not here");
  assert.match(unknownTitle.ok ? unknownTitle.description : "", /ghost-key/);
  assert.ok(!checkForget("{}", readContext).ok);
  assert.ok(!checkForget(JSON.stringify({ topicKey: "k".repeat(121) }), readContext).ok);
});

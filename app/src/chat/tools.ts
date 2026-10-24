/**
 * The chat's function tools (Ronda 3 R1, spec S1): what the model may
 * propose, the pure validation of its raw JSON arguments, and the plain-words
 * description each action card shows. Nothing here writes anything — the
 * confirmation flow in the panel calls the app's existing data functions only
 * after the user confirms, and every write re-validated by `data/**` throws
 * before reaching Firestore.
 *
 * `move_task` maps onto what the UI's own surfaces do when they move work:
 * a target day is the task's deadline (`setTaskDeadline`), `null` clears it
 * (unschedule), and an optional start time — the app's primitive for placing
 * a task at a time is a work block linked to the task — creates that block
 * for the estimate's duration (60 min without one), next to the deadline.
 */

import { ASSUMED_ESTIMATE_MINUTES } from "../domain/model.ts";
import { formatDateKey } from "../ui/format.ts";
import { dateKey, timeLabel } from "../ui/time.ts";
import type { Memory } from "./memoryStore.ts";
import type { ChatToolCall, ChatToolSpec } from "./types.ts";

/** At most 5 tool calls per answer; extras are dropped with a note (S1). */
export const MAX_TOOL_CALLS_PER_ANSWER = 5;

/** At most this many characters in a proposed task title (S1): the model
 * sometimes echoes a whole page back as the title. */
export const MAX_TOOL_TITLE_CHARS = 200;

const CREATE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "create_task",
    description:
      "Create a task in the user's planner, optionally due on a day and optionally placed on that day's schedule at a start time. The user must confirm before anything is created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The task's title, in the user's own words." },
        day: {
          type: "string",
          description: "Optional due day as YYYY-MM-DD (the planner's timezone). Omit for no date.",
        },
        startTime: {
          type: "string",
          description:
            "Optional wall-clock HH:MM (24 h) to place the task on that day's schedule; needs a day. The block runs for the estimate (60 min without one).",
        },
        estimateMinutes: {
          type: "integer",
          description: "Optional estimate (duration) in whole minutes (1–1440).",
        },
      },
      required: ["title"],
    },
  },
};

const MOVE_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "move_task",
    description:
      "Move a task to another day, unschedule it, or place it at a start time. The user must confirm before anything changes.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task's id, exactly as it appears in the planner context.",
        },
        day: {
          type: ["string", "null"],
          description:
            "The target day as YYYY-MM-DD, or null to unschedule the task (clear its date).",
        },
        startTime: {
          type: "string",
          description:
            "Optional wall-clock HH:MM (24 h) to also place the task on that day's schedule; needs a day.",
        },
      },
      required: ["taskId", "day"],
    },
  },
};

/** The tools every chat request carries (extraction requests carry none). */
const LIST_TASKS: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_tasks",
    description:
      "Read tasks from the user's planner without asking. Filter by due-day range and/or a title text; task ids come back so you can reference them in other tools.",
    parameters: {
      type: "object",
      properties: {
        fromDay: { type: "string", description: "Optional first due day, YYYY-MM-DD (inclusive)." },
        toDay: { type: "string", description: "Optional last due day, YYYY-MM-DD (inclusive)." },
        query: { type: "string", description: "Optional case-insensitive text the title must contain." },
        includeCompleted: { type: "boolean", description: "Include completed tasks (default false)." },
      },
      required: [],
    },
  },
};

const GET_TASK: ChatToolSpec = {
  type: "function",
  function: {
    name: "get_task",
    description: "Read one task by id, including its scheduled blocks, without asking.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task's id, exactly as it appears in the context or in a tool result." },
      },
      required: ["taskId"],
    },
  },
};

const LIST_HOLIDAYS: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_holidays",
    description: "Read the user's holiday labels (id, date, title, kind, hidden) without asking.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const LIST_MEMORIES: ChatToolSpec = {
  type: "function",
  function: {
    name: "list_memories",
    description: "Read the notes you keep about the user (topicKey, title, content) without asking.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

/** The tools every chat request carries (extraction requests carry none).
 * Reads run without confirmation (S4); writes render confirmation cards. */
export const CHAT_TOOLS: ChatToolSpec[] = [
  CREATE_TASK,
  MOVE_TASK,
  LIST_TASKS,
  GET_TASK,
  LIST_HOLIDAYS,
  LIST_MEMORIES,
];

const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["list_tasks", "get_task", "list_holidays", "list_memories"]);

/** Whether a tool name is a read: reads execute at once, never behind a
 * confirmation card. Unknown names are not reads. */
export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}

/** The planner data validation and descriptions read: the context's tasks. */
export type ChatToolContext = {
  tasks: ReadonlyArray<{ id: string; title: string; deadline?: string; estimateMinutes?: number; completed?: boolean }>;
  /** Task-linked work blocks, so reads can report when a task is placed and
   * writes can describe what they replace or remove. Absent in a context
   * built without blocks (the panel's display-only fallback). */
  blocks?: ReadonlyArray<{ id: string; start: string; end: string; taskId?: string }>;
  /** Holiday labels (S4: the model may list and hide them like the Holidays
   * sheet does). */
  holidays?: ReadonlyArray<{ id: string; date: string; title: string; kind: string; hidden?: boolean }>;
  /** The notes the model may forget (topicKey → title), for descriptions. */
  memoryTopics?: ReadonlyArray<{ topicKey: string; title: string }>;
  timeZone: string;
  /** The profile zone's today (`YYYY-MM-DD`), for "today" wording. */
  todayKey: string;
};

export type ToolCheck<T> = { ok: true; value: T; description: string } | { ok: false; error: string };

export type NormalizedCreateTask = {
  title: string;
  day?: string;
  /** Minutes since midnight when a start time was given (needs a day). */
  startMinutes?: number;
  estimateMinutes?: number;
};

export type NormalizedMoveTask = {
  taskId: string;
  title: string;
  /** Target day key, or `null` = unschedule. */
  day: string | null;
  /** Minutes since midnight when a start time was given. */
  startMinutes?: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const ESTIMATE_MAX_MINUTES = 1440;

/** A `YYYY-MM-DD` string that names a real calendar day. */
export function isValidDayKey(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(stamp)) return false;
  return new Date(stamp).toISOString().slice(0, 10) === value;
}

function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "The proposal was not a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "The proposal was not valid JSON." };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Validates a raw `day` argument.
 * `optional` (create_task): absent, null or empty all mean "no date".
 * `requiredOrNull` (move_task): null means unschedule; absence is an error
 * (the schema requires the field so the model states its intent). */
function checkDay(value: unknown, mode: "optional" | "requiredOrNull"): { day?: string; unschedule: boolean } | { error: string } {
  if (value === undefined || value === null || value === "") {
    if (mode === "optional" || value === null) return { unschedule: true };
    return { error: "The proposal needs a day (or null to unschedule)." };
  }
  if (typeof value !== "string" || !isValidDayKey(value.trim())) {
    return { error: `"${String(value)}" is not a valid day (YYYY-MM-DD).` };
  }
  return { day: value.trim(), unschedule: false };
}

/** Validates `estimateMinutes`: absent, null, or a whole minute count in range. */
function checkEstimate(value: unknown): { estimateMinutes?: number } | { error: string } {
  if (value === undefined || value === null) return {};
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ESTIMATE_MAX_MINUTES) {
    return { error: "The estimate must be a whole minute count between 1 and 1440." };
  }
  return { estimateMinutes: value as number };
}

/** Validates a raw `HH:MM` string into minutes since midnight, or an error.
 * Shared by every tool that can place work at a wall-clock time. */
function checkStartTime(value: unknown): { startMinutes: number } | { error: string } {
  if (typeof value !== "string") return { error: "The start time must be HH:MM." };
  const match = TIME_RE.exec(value.trim());
  const hour = match === null ? -1 : Number(match[1]);
  const minute = match === null ? -1 : Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { error: `"${value}" is not a valid start time (HH:MM).` };
  }
  return { startMinutes: hour * 60 + minute };
}

/** Validates `create_task` arguments (spec S1: empty title, bad date; S4:
 * start time with midnight room). `todayKey` only feeds the description's
 * "today"/"tomorrow" wording. */
export function checkCreateTask(raw: string, todayKey = ""): ToolCheck<NormalizedCreateTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const title = optionalString(parsed.value.title);
  if (title === undefined) return { ok: false, error: "The task needs a title." };
  if (title.length > MAX_TOOL_TITLE_CHARS) return { ok: false, error: TITLE_TOO_LONG };
  const day = checkDay(parsed.value.day, "optional");
  if ("error" in day) return { ok: false, error: day.error };
  let startMinutes: number | undefined;
  if (parsed.value.startTime !== undefined && parsed.value.startTime !== null) {
    if (day.day === undefined) return { ok: false, error: "A start time needs a day." };
    const time = checkStartTime(parsed.value.startTime);
    if ("error" in time) return { ok: false, error: time.error };
    startMinutes = time.startMinutes;
  }
  const estimate = checkEstimate(parsed.value.estimateMinutes);
  if ("error" in estimate) return { ok: false, error: estimate.error };
  // The block a start time creates runs for the estimate (the app's assumed
  // 60 minutes without one) and must end before midnight — checked here,
  // before any write, exactly like the estimate bounds.
  if (startMinutes !== undefined) {
    const estimateForRoom = estimate.estimateMinutes ?? ASSUMED_ESTIMATE_MINUTES;
    if (startMinutes + estimateForRoom > 1440) {
      return { ok: false, error: "The start time leaves no room before midnight for this task's duration." };
    }
  }
  const value: NormalizedCreateTask = {
    title,
    ...(day.day === undefined ? {} : { day: day.day }),
    ...(startMinutes === undefined ? {} : { startMinutes }),
    ...estimate,
  };
  return { ok: true, value, description: describeCreateTask(value, todayKey) };
}

const TITLE_TOO_LONG = `The title is too long (at most ${MAX_TOOL_TITLE_CHARS} characters).`;

function describeCreateTask(value: NormalizedCreateTask, todayKey: string): string {
  const parts = [`Create task "${value.title}"`];
  if (value.day !== undefined) parts.push(formatDateKey(value.day, todayKey));
  if (value.startMinutes !== undefined) {
    parts.push(`${String(Math.floor(value.startMinutes / 60)).padStart(2, "0")}:${String(value.startMinutes % 60).padStart(2, "0")}`);
  }
  if (value.estimateMinutes !== undefined) parts.push(`${value.estimateMinutes} min`);
  return parts.join(" · ");
}

function describeMoveTask(value: NormalizedMoveTask, task: ChatToolContext["tasks"][number], context: ChatToolContext): string {
  const label = (day: string | undefined | null) =>
    day === undefined || day === null ? "No date" : formatDateKey(day, context.todayKey);
  const parts = [`Move "${task.title}"`, `${label(task.deadline)} → ${value.day === null ? "No date" : label(value.day)}`];
  if (value.startMinutes !== undefined) {
    const hour = Math.floor(value.startMinutes / 60);
    const minute = value.startMinutes % 60;
    parts.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return parts.join(" · ");
}

/** Validates `move_task` arguments against the planner context (S1: unknown
 * id, bad date). An unknown id or a malformed proposal never writes. Every
 * check — including the midnight room check for a start time — runs here,
 * so a rejected proposal fails the card before any data call happens. */
export function checkMoveTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedMoveTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  const hasStartTime = parsed.value.startTime !== undefined && parsed.value.startTime !== null;
  if (hasStartTime && (parsed.value.day === undefined || parsed.value.day === null || parsed.value.day === "")) {
    return { ok: false, error: "A start time needs a target day." };
  }
  const day = checkDay(parsed.value.day, "requiredOrNull");
  if ("error" in day) return { ok: false, error: day.error };
  let startMinutes: number | undefined;
  if (parsed.value.startTime !== undefined && parsed.value.startTime !== null) {
    if (typeof parsed.value.startTime !== "string") return { ok: false, error: "The start time must be HH:MM." };
    const match = TIME_RE.exec(parsed.value.startTime.trim());
    const hour = match === null ? -1 : Number(match[1]);
    const minute = match === null ? -1 : Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return { ok: false, error: `"${parsed.value.startTime}" is not a valid start time (HH:MM).` };
    }
    if (day.day === undefined) {
      return { ok: false, error: "A start time needs a target day." };
    }
    startMinutes = hour * 60 + minute;
    // The block this start time creates runs for the task's estimate (the
    // app's assumed 60 minutes without one) and must end before midnight —
    // checked here, before any write, exactly like the estimate bounds.
    const estimate = task.estimateMinutes ?? ASSUMED_ESTIMATE_MINUTES;
    if (startMinutes + estimate > 1440) {
      return { ok: false, error: "The start time leaves no room before midnight for this task's estimate." };
    }
  }
  const value: NormalizedMoveTask = {
    taskId,
    title: task.title,
    ...(day.day === undefined ? { day: null } : { day: day.day }),
    ...(startMinutes === undefined ? {} : { startMinutes }),
  };
  return { ok: true, value, description: describeMoveTask(value, task, context) };
}

/* ---------- read tools (S4): run without confirmation, validate purely ---------- */

export type NormalizedListTasks = {
  fromDay?: string;
  toDay?: string;
  query?: string;
  includeCompleted: boolean;
};

export type NormalizedGetTask = { taskId: string };

export type NormalizedNoArgs = Record<string, never>;

const QUERY_MAX_CHARS = 120;
const LIST_RESULTS_CAP = 30;
const HOLIDAY_RESULTS_CAP = 40;

/** Validates `list_tasks` arguments: absent/null/empty filters are absent;
 * days must be real day keys in order; the query is a bounded string. */
export function checkListTasks(raw: string, context: ChatToolContext): ToolCheck<NormalizedListTasks> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const value: NormalizedListTasks = { includeCompleted: parsed.value.includeCompleted === true };
  if (parsed.value.includeCompleted !== undefined && typeof parsed.value.includeCompleted !== "boolean") {
    return { ok: false, error: "includeCompleted must be true or false." };
  }
  for (const [key, target] of [["fromDay", "fromDay"], ["toDay", "toDay"]] as const) {
    const raw2 = parsed.value[key];
    if (raw2 === undefined || raw2 === null || raw2 === "") continue;
    if (typeof raw2 !== "string" || !isValidDayKey(raw2.trim())) {
      return { ok: false, error: `"${String(raw2)}" is not a valid day (YYYY-MM-DD).` };
    }
    value[target] = raw2.trim();
  }
  if (value.fromDay !== undefined && value.toDay !== undefined && value.fromDay > value.toDay) {
    return { ok: false, error: "fromDay must not be after toDay." };
  }
  const rawQuery = parsed.value.query;
  if (rawQuery !== undefined && rawQuery !== null && rawQuery !== "") {
    if (typeof rawQuery !== "string") return { ok: false, error: "The query must be text." };
    if (rawQuery.trim().length > QUERY_MAX_CHARS) {
      return { ok: false, error: `The query is too long (at most ${QUERY_MAX_CHARS} characters).` };
    }
    value.query = rawQuery.trim();
  }
  return { ok: true, value, description: describeListTasks(value, context) };
}

function describeListTasks(value: NormalizedListTasks, context: ChatToolContext): string {
  const parts = ["Look up tasks"];
  if (value.fromDay !== undefined || value.toDay !== undefined) {
    const from = value.fromDay === undefined ? "the beginning" : formatDateKey(value.fromDay, context.todayKey);
    const to = value.toDay === undefined ? "onwards" : formatDateKey(value.toDay, context.todayKey);
    parts.push(`due ${from} – ${to}`);
  }
  if (value.query !== undefined) parts.push(`matching "${value.query}"`);
  if (value.includeCompleted) parts.push("including completed");
  return parts.join(" · ");
}

/** Validates `get_task`: an id is required, and it must be one the context
 * knows — a read of an unknown id fails before anything runs. */
export function checkGetTask(raw: string, context: ChatToolContext): ToolCheck<NormalizedGetTask> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  const taskId = optionalString(parsed.value.taskId);
  if (taskId === undefined) return { ok: false, error: "The proposal needs a task id." };
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { ok: false, error: "That task id is not in your planner." };
  return { ok: true, value: { taskId }, description: `Look up task "${task.title}"` };
}

/** Validates the no-argument reads (`list_holidays`, `list_memories`): extra
 * arguments are tolerated (the schema keeps them out), nothing to reject. */
export function checkNoArgs(raw: string, description: string): ToolCheck<NormalizedNoArgs> {
  const parsed = parseArguments(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: {}, description };
}

/** The read results are plain lines the model quotes back. */
export type ReadResult = { summary: string; result: string };

const emptyResult = (noun: string): ReadResult => ({ summary: `No ${noun} found.`, result: `No ${noun} found.` });

function taskLine(
  task: ChatToolContext["tasks"][number],
  blocks: ReadonlyArray<{ start: string; end: string; taskId?: string }>,
  context: ChatToolContext,
): string {
  const parts = [`[${task.id}] "${task.title}"`];
  parts.push(task.deadline === undefined ? "no due date" : `due ${formatDateKey(task.deadline, context.todayKey)}`);
  const linked = blocks.filter(block => block.taskId === task.id);
  if (linked.length > 0) {
    parts.push(
      linked
        .map(block => `${formatDateKey(dateKey(new Date(block.start), context.timeZone), context.todayKey)} ${timeLabel(new Date(block.start), context.timeZone)}–${timeLabel(new Date(block.end), context.timeZone)}`)
        .join(", "),
    );
  }
  if (task.estimateMinutes !== undefined) parts.push(`${task.estimateMinutes} min`);
  if (task.completed === true) parts.push("done");
  return `- ${parts.join(" · ")}`;
}

/** Builds the `list_tasks` result from the live context (pure; unit-tested). */
export function buildListTasksResult(value: NormalizedListTasks, context: ChatToolContext): ReadResult {
  const blocks = context.blocks ?? [];
  const query = value.query === undefined ? undefined : value.query.toLowerCase();
  const matches = context.tasks.filter(task => {
    if (value.includeCompleted !== true && task.completed === true) return false;
    if (query !== undefined && !task.title.toLowerCase().includes(query)) return false;
    if (value.fromDay === undefined && value.toDay === undefined) return true;
    const deadlineInRange =
      task.deadline !== undefined && (value.fromDay === undefined || task.deadline >= value.fromDay) && (value.toDay === undefined || task.deadline <= value.toDay);
    if (deadlineInRange) return true;
    // A task with no matching deadline still matches when one of its blocks
    // starts inside the range (the schedule placement, not just the due day).
    return blocks.some(block => {
      if (block.taskId !== task.id) return false;
      const blockDay = dateKey(new Date(block.start), context.timeZone);
      return (value.fromDay === undefined || blockDay >= value.fromDay) && (value.toDay === undefined || blockDay <= value.toDay);
    });
  });
  if (matches.length === 0) return emptyResult("matching tasks");
  const ordered = [...matches].sort((left, right) => {
    if (left.deadline !== right.deadline) return (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999");
    return left.title.localeCompare(right.title);
  });
  const shown = ordered.slice(0, LIST_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "task" : "tasks"} found.`,
    result: `${shown.map(task => taskLine(task, blocks, context)).join("\n")}${more}`,
  };
}

/** Builds the `get_task` result: the one task line, plus every block placed
 * for it (past placements included — the full truth about one task). */
export function buildGetTaskResult(taskId: string, context: ChatToolContext): ReadResult {
  const task = context.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return { summary: "Task not found.", result: `Task id=${taskId} is not in the planner.` };
  const blocks = (context.blocks ?? []).filter(block => block.taskId === taskId);
  const line = taskLine(task, blocks, context);
  const extras = blocks.length > 0 ? "" : " · not placed on the schedule";
  return { summary: `"${task.title}"`, result: `${line}${extras}` };
}

/** Builds the `list_holidays` result (hidden ones flagged, never dropped —
 * the model needs their ids to show them again). */
export function buildListHolidaysResult(context: ChatToolContext): ReadResult {
  const holidays = context.holidays ?? [];
  if (holidays.length === 0) return emptyResult("holidays");
  const ordered = [...holidays].sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title));
  const shown = ordered.slice(0, HOLIDAY_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "holiday" : "holidays"} found.`,
    result: `${shown
      .map(holiday => `- [${holiday.id}] ${formatDateKey(holiday.date, context.todayKey)} · "${holiday.title}" · ${holiday.kind}${holiday.hidden === true ? " · hidden" : ""}`)
      .join("\n")}${more}`,
  };
}

/** Builds the `list_memories` result from the live notes store (pure; the
 * topicKeys are what `forget` removes by). */
export function buildListMemoriesResult(memories: ReadonlyArray<Memory>): ReadResult {
  if (memories.length === 0) return emptyResult("notes");
  const ordered = [...memories].sort((left, right) => right.updatedAt - left.updatedAt);
  const shown = ordered.slice(0, NOTES_RESULTS_CAP);
  const more = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more)` : "";
  return {
    summary: `${ordered.length} ${ordered.length === 1 ? "note" : "notes"} found.`,
    result: `${shown.map(memory => `- [${memory.topicKey}] ${memory.title} — ${memory.content}`).join("\n")}${more}`,
  };
}

const NOTES_RESULTS_CAP = 20;

/** Validates one proposed call; `ok` carries the plain-words description the
 * card shows. Unsupported tool names fail (never render as a write). Reads
 * validate against the same pure rules the executor re-runs. */
export function validateToolCall(
  call: Pick<ChatToolCall, "name" | "arguments">,
  context: ChatToolContext,
): ToolCheck<NormalizedCreateTask | NormalizedMoveTask | NormalizedListTasks | NormalizedGetTask | NormalizedNoArgs> {
  switch (call.name) {
    case "create_task":
      return checkCreateTask(call.arguments, context.todayKey);
    case "move_task":
      return checkMoveTask(call.arguments, context);
    case "list_tasks":
      return checkListTasks(call.arguments, context);
    case "get_task":
      return checkGetTask(call.arguments, context);
    case "list_holidays":
      return checkNoArgs(call.arguments, "Look up holidays");
    case "list_memories":
      return checkNoArgs(call.arguments, "Look up the saved notes");
    default:
      return { ok: false, error: `Unknown action "${call.name}".` };
  }
}

/** The plain-words description of a still-pending proposal, or a neutral line
 * when the arguments do not parse (the card never invents a description from
 * unvalidated data). */
export function describeToolCall(call: Pick<ChatToolCall, "name" | "arguments">, context: ChatToolContext): string {
  const check = validateToolCall(call, context);
  return check.ok ? check.description : "The assistant proposed an action, but its details are not valid.";
}

/** The `tool` message content each card state sends back to the model, so the
 * OpenAI protocol stays valid (S1: one tool message per call). A resolved
 * write's `result` line — ids and fields — rides to the model so it can
 * reference the task it just changed (S4); the `outcome` stays the card's
 * short user-facing line. A read's result is the data itself. */
export function toolResultContent(card: { status: string; outcome?: string; result?: string }): string {
  const detail = card.result ?? card.outcome;
  switch (card.status) {
    case "read":
      return `The assistant looked this up on its own. Result: ${detail ?? "no data"}`;
    case "confirmed":
      return `The user confirmed and it was applied. ${detail ?? ""}`.trim();
    case "failed":
      return `The user confirmed but it failed: ${detail ?? "unknown error"}`;
    case "discarded":
      return "The user discarded this proposal. Nothing was changed.";
    default:
      return "The user has not answered this proposal yet; treat it as not done.";
  }
}
